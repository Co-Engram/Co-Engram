/**
 * 必要性评估器(Necessity Evaluator)
 *
 * 在 cluster 晋升 proposal 前,判断"这个反复出现的话题是否值得固化为团队记忆"。
 * 设计参考 flexmem 的 task 层 `shouldSkipSummary`(8 条规则)+ mem0 的"重要性
 * 判断交给 extraction LLM,filter 层只过滤明显垃圾"的分工哲学。
 *
 * 两层设计:
 *   - Layer 1(proposal-engine.observe 入口):规则预过滤,零成本挡机械噪声
 *   - Layer 2(proposal-engine.maybePromoteToProposal):必要性评估
 *     - 默认 RuleBasedNecessityEvaluator(零依赖,挡 80% 低质量提案)
 *     - host 可注入 LlmNecessityEvaluator(用 LLM 判断语义必要性)
 *
 * core 不绑定 LLM provider,通过 LlmClient 接口抽象;host 自行实现具体适配器
 * (Anthropic / OpenAI-compatible / 本地模型)。
 *
 * @module @co-engram/core/observability
 */

import type {
  LlmTool,
  LlmToolOptions,
} from "./llm-tool.js";
import { internalError } from "../tools/error-schema.js";

// ============================================================
// LLM 抽象层
// ============================================================

/**
 * Provider-agnostic LLM 调用接口
 *
 * host 实现具体适配器:
 *   - claude-code-mcp:Anthropic API
 *   - openclaw-plugin:OpenAI-compatible endpoint(可读 ~/.openclaw/openclaw.json)
 */
export interface LlmClient {
  /**
   * 同步完成一次 LLM 调用,返回生成的文本
   *
   * 实现需保证:
   *   - 失败时抛错(由调用方决定 fallback)
   *   - 不在内部 catch(LlmNecessityEvaluator 需感知失败以触发 fallback)
   */
  complete(
    prompt: string,
    opts?: {
      readonly maxTokens?: number;
      readonly temperature?: number;
      readonly timeoutMs?: number;
    },
  ): Promise<string>;
}

// ============================================================
// 评估接口
// ============================================================

/** 评估输入 */
export interface NecessityInput {
  /** cluster 累积的样本(已截断为短字符串,最多 maxSamples 条) */
  readonly samples: readonly string[];
  /** 累积次数 */
  readonly occurrences: number;
  /** 首次见到时间 ISO */
  readonly firstSeenAt: string;
  /** 最后见到时间 ISO */
  readonly lastSeenAt: string;
  /** 已有 engram 标题(用于重复检测提示,可选) */
  readonly existingTitles: readonly string[];
}

/** 评估结果 */
export interface NecessityVerdict {
  /** 是否值得固化为团队记忆 */
  readonly necessary: boolean;
  /** 理由(展示给用户看,帮助审批决策) */
  readonly reason: string;
  /** 触发的规则名(规则版填充,如 'high_repetition'/'too_short';LLM 版留空) */
  readonly rule?: string;
  /** LLM 建议的标题(LLM 版填充,作为用户审批时的草稿) */
  readonly suggestedTitle?: string;
}

/** 评估器接口 */
export interface NecessityEvaluator {
  evaluate(input: NecessityInput): Promise<NecessityVerdict>;
}

// ============================================================
// Layer 1:消息预过滤(纯函数,observe 入口调用)
// ============================================================

/**
 * Trivial 词集合(中英双语)
 *
 * 参考 flexmem TRIVIAL_PATTERNS,适配 co-engram 的"团队决策记忆"场景。
 * 单独的问候/确认/测试内容不应触发聚类。
 *
 * 判断逻辑(参考 flexmem looksLikeTrivialContent):
 *   - 把消息按空白切成词(CJK 段按 bigram 切)
 *   - 统计 trivial 词占比
 *   - 占比 > 60% → 视为 trivial 内容
 *
 * 这比 "^(ok|hi|...)$" 整条匹配更稳健,能识别 "ok ok ok done done" 这种重复 trivial。
 */
const TRIVIAL_WORDS = new Set([
  // 英文
  "test",
  "testing",
  "hello",
  "hi",
  "hey",
  "ok",
  "okay",
  "yes",
  "no",
  "yeah",
  "nope",
  "sure",
  "thanks",
  "thank",
  "you",
  "thx",
  "ping",
  "pong",
  "done",
  "next",
  "continue",
  "go",
  "stop",
  "wait",
  "confirm",
  "lol",
  "haha",
  "hmm",
  "aaa",
  "bbb",
  "xxx",
  "zzz",
  "123",
  "asdf",
  "qwer",
  // 中文(单字 + 双字)
  "测试",
  "你好",
  "好的",
  "嗯",
  "是的",
  "不是",
  "谢谢",
  "继续",
  "下一个",
  "完成",
  "确认",
  "对",
  "不对",
  "行",
  "不行",
  "可以",
  "不可以",
  "搞定",
  "收到",
]);

/** 仅空白/标点 */
const ONLY_PUNCT_RE = /^[\s\p{P}\p{S}]*$/u;

/** 预过滤结果 */
export interface PrefilterVerdict {
  readonly accepted: boolean;
  readonly rule?: string;
  readonly reason?: string;
}

/**
 * 判断消息是否由 trivial 词主导(占比 > 60%)
 *
 * 用于 Layer 1 入口和 Layer 2 cluster 评估
 */
export function isTrivialDominated(content: string, threshold = 0.6): boolean {
  const tokens = tokenizeForTrivial(content);
  if (tokens.length === 0) return false;
  const trivialCount = tokens.filter((t) =>
    TRIVIAL_WORDS.has(t.toLowerCase()),
  ).length;
  return trivialCount / tokens.length > threshold;
}

/** 把消息切成可统计的 token(CJK 按 bigram,其他按空白分) */
function tokenizeForTrivial(text: string): string[] {
  const tokens: string[] = [];
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (CJK_RUN.test(word)) {
      if (word.length === 1) {
        tokens.push(word);
        continue;
      }
      for (let i = 0; i + 1 < word.length; i++) {
        tokens.push(word.slice(i, i + 2));
      }
    } else {
      tokens.push(word);
    }
  }
  return tokens;
}

// ============================================================
// 对话内务检测(conversational artifact detection)
//
// 5 类信号识别"对话过程中重复出现、但本质是过程产物、不应固化为团队记忆"
// 的内容。这类内容长半衰期为零——任务完成即失效。
//
// 根本共性:内容描述"这次会话本身的进行状态",而非"会话之外的领域事实"。
// ============================================================

/**
 * 对话时态信号词(将来/进行/刚过去 + 第一人称动作)
 *
 * 命中 ≥2 个不同短语 → 视为"对话时态主导"(描述一次性任务流)
 */
const CONVERSATIONAL_TENSE_PHRASES = new Set([
  // 中文
  "我会",
  "我打算",
  "我将",
  "我们即将",
  "正在",
  "现已",
  "已完成",
  "接下来",
  "下一步",
  "马上",
  "稍后",
  "即将",
  // 英文
  "i'll",
  "i will",
  "i'm going to",
  "currently",
  "just finished",
  "next step",
  "about to",
  "in progress",
]);

/**
 * 指代依赖词(脱离当前上下文即失效)
 *
 * 命中 ≥2 个不同词 → 视为"指代依赖"(内容无法独立成立)
 */
const DEICTIC_REFS = new Set([
  // 中文
  "上面",
  "刚才",
  "下一步",
  "这个",
  "那个",
  "这里",
  "那里",
  "前面",
  "后面",
  "接下来",
  "本次",
  "刚刚",
  "等会",
  // 英文
  "above",
  "earlier",
  "previous",
  "mentioned",
  "following",
]);

/**
 * 自我元层短语(LLM 描述自身行为 / 向用户请求输入 / 等待决策)
 *
 * 命中 ≥1 个 → 视为"自我元层"(强信号——这是对话协议本身,不是知识)
 */
const SELF_META_PHRASES = new Set([
  // 中文
  "我推荐",
  "我建议",
  "我的推荐",
  "我的分析",
  "我的判断",
  "我的方案",
  "我倾向",
  "我认为",
  "等你确认",
  "请你决定",
  "请提供",
  "让我先",
  // 英文
  "i recommend",
  "i suggest",
  "my recommendation",
  "my analysis",
  "please provide",
  "let me",
  "i think",
  "waiting for",
]);

/** markdown 表格签名:`| 字段 | 值 |` + `|---|---|` */
const MARKDOWN_TABLE_RE =
  /\|[\s\w一-鿿]+\|[\s\w一-鿿]+\|[\s\S]*?\|[-:\s|]+\|/;

/** 完整 commit SHA(40 位 hex)— 强信号,要求完整长度避免误判短 hex */
const COMMIT_SHA_FULL_RE = /\b[0-9a-f]{40}\b/i;

/** ULID(01 + 24 位 base32)— co-engram 内部 ID 的强特征 */
const ULID_RE = /01[A-Z0-9]{24}/;

/** 凭证 token(GitHub PAT / Bearer)— 强信号 */
const TOKEN_RE = /ghp_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9_-]{10,}/i;

/** 命令字面量(≥20 字符的反引号包裹串,反复出现说明在回显命令而非陈述事实) */
const COMMAND_LITERAL_RE = /`[^`\n]{20,}`/g;

/** 选项枚举标记(方案 A / 选项 1 / Option 1 / G1 / (A) 并列) */
const ENUMERATED_OPTION_RE =
  /(?:方案|选项)\s*[A-Z一二三四五六七八九\d]+|Option\s*\d+|[Gg]\d+|[（(][A-Z][）)]/g;

/** 对话内务检测结果 */
export interface ConversationalArtifactVerdict {
  /** 是否为对话内务产物 */
  readonly artifact: boolean;
  /** 命中的信号列表(展示给用户审批时参考) */
  readonly reasons: readonly string[];
}

/**
 * 检测内容是否为"对话内务产物"(conversational artifact)
 *
 * 5 类信号:
 *   1. `tense_dominated` - 对话时态主导(≥2 个时态短语命中)
 *   2. `deictic_refs` - 指代依赖(≥2 个指代词命中)
 *   3. `process_signature:<sub>` - 过程输出签名(table / sha / ulid / token / command,任一命中)
 *   4. `enumerated_options` - 选项枚举结构(≥2 个并列标记命中)
 *   5. `self_meta` - 自我元层(≥1 个自我元层短语命中,强信号)
 *
 * 任一信号命中 → `artifact=true`
 *
 * 设计哲学:
 *   - 真正该记的内容跨会话稳定、不依赖指代、是领域事实
 *   - 过程产物描述"这次会话本身的进行状态",任务完成即失效
 *   - 把"长半衰期为零"的内容挡在 proposal pipeline 之外
 *
 * 用于:
 *   - L1 `prefilterMessage` 入口直接拒(零成本,样本不进聚类)
 *   - L2 `RuleBasedNecessityEvaluator` 防御性兜底(L1 万一漏检)
 */
export function isConversationalArtifact(
  content: string,
): ConversationalArtifactVerdict {
  const lower = content.toLowerCase();
  const reasons: string[] = [];

  // 1. 对话时态主导
  let tenseHits = 0;
  for (const phrase of CONVERSATIONAL_TENSE_PHRASES) {
    if (lower.includes(phrase)) tenseHits++;
  }
  if (tenseHits >= 2) reasons.push("tense_dominated");

  // 2. 指代依赖
  let deicticHits = 0;
  for (const word of DEICTIC_REFS) {
    if (lower.includes(word)) deicticHits++;
  }
  if (deicticHits >= 2) reasons.push("deictic_refs");

  // 3. 过程输出签名
  const sigReasons: string[] = [];
  if (MARKDOWN_TABLE_RE.test(content)) sigReasons.push("table");
  if (COMMIT_SHA_FULL_RE.test(content)) sigReasons.push("sha");
  if (ULID_RE.test(content)) sigReasons.push("ulid");
  if (TOKEN_RE.test(content)) sigReasons.push("token");
  const cmdMatches = content.match(COMMAND_LITERAL_RE);
  if (cmdMatches) {
    const cmdTotal = cmdMatches.reduce((s, m) => s + m.length, 0);
    if (cmdTotal / content.length >= 0.5) sigReasons.push("command");
  }
  if (sigReasons.length > 0) {
    reasons.push(`process_signature:${sigReasons.join("+")}`);
  }

  // 4. 选项枚举
  const optMatches = content.match(ENUMERATED_OPTION_RE);
  if (optMatches && optMatches.length >= 2) reasons.push("enumerated_options");

  // 5. 自我元层(强信号,单次命中即拒)
  for (const phrase of SELF_META_PHRASES) {
    if (lower.includes(phrase)) {
      reasons.push("self_meta");
      break;
    }
  }

  return { artifact: reasons.length > 0, reasons };
}

/**
 * Layer 1 预过滤单条消息
 *
 * @param content 消息原文
 * @param role 消息角色(user/assistant/system)
 * @returns accepted=true 通过;accepted=false 时 rule/reason 标明拒绝原因
 */
export function prefilterMessage(
  content: string,
  role: "user" | "assistant" | "system",
): PrefilterVerdict {
  if (role === "system") {
    return {
      accepted: false,
      rule: "system_role",
      reason: "system role not observed",
    };
  }

  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return { accepted: false, rule: "empty", reason: "empty content" };
  }

  // 长度:对 user 收紧(30+),对 assistant 放宽(15+,允许简短确认)
  const minLen = role === "user" ? 30 : 15;
  if (trimmed.length < minLen) {
    return {
      accepted: false,
      rule: "too_short",
      reason: `${trimmed.length} < ${minLen} chars`,
    };
  }

  // Trivial 占比(参考 flexmem looksLikeTrivialContent)
  if (isTrivialDominated(trimmed)) {
    return {
      accepted: false,
      rule: "trivial_pattern",
      reason: "trivial/test content dominated",
    };
  }

  // 仅标点
  if (ONLY_PUNCT_RE.test(trimmed)) {
    return {
      accepted: false,
      rule: "only_punct",
      reason: "only punctuation/symbols",
    };
  }

  // 信息密度:去停用词后有效 token 数
  const meaningful = countMeaningfulTokens(trimmed);
  if (meaningful < 4) {
    return {
      accepted: false,
      rule: "low_density",
      reason: `only ${meaningful} meaningful tokens`,
    };
  }

  // 对话内务产物(配置表/命令回显/选项枚举/自我元层/指代依赖等)
  // 这类内容在对话过程中高频重复出现,但长半衰期为零,不该固化为团队记忆。
  // 见 isConversationalArtifact 文档。
  const artifact = isConversationalArtifact(trimmed);
  if (artifact.artifact) {
    return {
      accepted: false,
      rule: "conversational_artifact",
      reason: `conversational bookkeeping (${artifact.reasons.join(", ")})`,
    };
  }

  return { accepted: true };
}

/**
 * 计算去停用词后的有效 token 数
 *
 * 复用 proposal-engine 的 normalize 思路,但内联以避免循环依赖
 */
function countMeaningfulTokens(text: string): number {
  const normalized = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ");
  const tokens = normalized
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
  // CJK 段按 bigram 切分,每个 bigram 算一个有效 token
  let count = 0;
  for (const tok of tokens) {
    if (CJK_RUN.test(tok)) {
      count += Math.max(1, tok.length - 1);
    } else {
      count += 1;
    }
  }
  return count;
}

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "must",
  "shall",
  "of",
  "in",
  "on",
  "at",
  "to",
  "for",
  "with",
  "by",
  "from",
  "as",
  "i",
  "me",
  "my",
  "we",
  "us",
  "our",
  "you",
  "your",
  "he",
  "him",
  "his",
  "she",
  "her",
  "it",
  "its",
  "they",
  "them",
  "their",
  "this",
  "that",
  "的",
  "了",
  "是",
  "在",
  "和",
  "与",
  "或",
  "但",
  "可以",
  "应该",
  "需要",
  "我",
  "你",
  "他",
  "她",
  "它",
  "我们",
  "你们",
  "他们",
  "这",
  "那",
]);

const CJK_RUN = /[㐀-鿿豈-﫿぀-ヿ가-힯]/;

// ============================================================
// Layer 2 默认实现:RuleBasedNecessityEvaluator
// ============================================================

/**
 * 规则版必要性评估器
 *
 * 在 cluster 累积到 threshold 后,从 samples/occurrences 判断是否值得提案。
 * 规则参考 flexmem `shouldSkipSummary`,适配 co-engram 单层 proposal 场景:
 *   - rule:high_repetition     samples 内 uniqueRatio < 0.5(机械重复)
 *   - rule:few_unique_samples  unique samples < 2(完全雷同)
 *   - rule:too_short           平均长度 < 30 chars
 *   - rule:low_density         平均有效 token < 5
 *   - rule:trivial_dominated   70%+ samples 命中 trivial 词表
 *
 * 全部通过 → necessary=true,reason="通过 N 条规则检查"
 */
export class RuleBasedNecessityEvaluator implements NecessityEvaluator {
  async evaluate(input: NecessityInput): Promise<NecessityVerdict> {
    const { samples, occurrences } = input;

    if (samples.length === 0) {
      return {
        necessary: false,
        rule: "no_samples",
        reason: "No samples accumulated",
      };
    }

    // 1. 完全雷同(只有 1 条独特样本,但 occurrences > 1)— 最严格的重复判断,先于 high_repetition
    const normalizedSamples = samples.map((s) => s.trim().toLowerCase());
    const uniqueSet = new Set(normalizedSamples);
    if (uniqueSet.size < 2 && occurrences > 1) {
      return {
        necessary: false,
        rule: "few_unique_samples",
        reason: "All samples are identical — likely automated retry or paste",
      };
    }

    // 2. 重复率(机械复制粘贴检测)
    const uniqueRatio = uniqueSet.size / samples.length;
    if (uniqueRatio < 0.5) {
      return {
        necessary: false,
        rule: "high_repetition",
        reason: `Mechanical repetition: ${uniqueSet.size}/${samples.length} unique samples (ratio ${uniqueRatio.toFixed(2)} < 0.5)`,
      };
    }

    // 3. 平均长度
    const avgLen = samples.reduce((s, x) => s + x.length, 0) / samples.length;
    if (avgLen < 30) {
      return {
        necessary: false,
        rule: "too_short",
        reason: `Samples too short: avg ${avgLen.toFixed(0)} chars < 30`,
      };
    }

    // 4. 平均信息密度
    const avgTokens =
      samples.reduce((s, x) => s + countMeaningfulTokens(x), 0) /
      samples.length;
    if (avgTokens < 5) {
      return {
        necessary: false,
        rule: "low_density",
        reason: `Low information density: avg ${avgTokens.toFixed(1)} meaningful tokens < 5`,
      };
    }

    // 5. trivial 占比
    const trivialCount = samples.filter((s) => isTrivialDominated(s)).length;
    if (trivialCount / samples.length > 0.7) {
      return {
        necessary: false,
        rule: "trivial_dominated",
        reason: `${trivialCount}/${samples.length} samples are trivial/test content`,
      };
    }

    // 6. 对话内务产物(L1 已挡,这是 L2 防御性兜底:防止 L1 万一漏检时
    //    cluster 累积到阈值仍能拦截)。超过 50% 的 sample 是内务产物 → 拒
    const artifactSamples = samples.filter(
      (s) => isConversationalArtifact(s).artifact,
    );
    if (artifactSamples.length / samples.length >= 0.5) {
      const allReasons = new Set<string>();
      for (const s of artifactSamples) {
        for (const r of isConversationalArtifact(s).reasons) {
          allReasons.add(r);
        }
      }
      return {
        necessary: false,
        rule: "conversational_artifact",
        reason: `${artifactSamples.length}/${samples.length} samples are conversational artifacts (${[...allReasons].join(", ")})`,
      };
    }

    return {
      necessary: true,
      reason: `Passed 6 rule checks: ${uniqueSet.size} unique samples, avg ${avgLen.toFixed(0)} chars, ${avgTokens.toFixed(1)} tokens`,
    };
  }
}

// ============================================================
// Layer 2 LLM 实现:LlmNecessityEvaluator
// ============================================================

const LLM_NECESSITY_PROMPT = `You are evaluating whether a recurring conversation topic is worth saving as a long-term team memory.

A "team memory" should capture reusable decisions, preferences, design rationale, debugging lessons, or patterns that will be relevant to future conversations. It is NOT for one-off questions, transient status updates, or content that can be derived from the code.

Below are ${"<SAMPLE_COUNT>"} samples (out of ${"<OCCURRENCES>"} total occurrences) of a recurring topic that the proposal engine has clustered together:

${"<SAMPLES_BLOCK>"}

Evaluate whether this topic should be promoted to a team memory. Return STRICT JSON only (no markdown, no prose) with this shape:

{
  "necessary": true | false,
  "reason": "<one sentence explaining why>",
  "suggestedTitle": "<if necessary, a concise 4-10 word title; else empty string>"
}

 STRICT criteria — necessary=true only if ALL three hold:
  1. Repeatable: this topic will recur across future conversations (not a one-off task)
  2. Transferable: the resolution/preference would be useful to other team members or future sessions
  3. Technical depth: contains non-trivial decisions, configurations, lessons, or rationale

 EXCLUDE (necessary=false):
  - Status reports / progress updates ("done with X", "50% complete")
  - Mechanical retries of the same question
  - Code/output pastes without decision context
  - Trivial confirmations ("ok", "thanks", "got it")
  - One-off personal tasks with no team relevance
  - Pure factual Q&A already answerable from docs
  - Content already covered by existing memory titles: ${"<EXISTING_TITLES>"}`;

/**
 * LLM 版必要性评估器
 *
 * host 注入 LlmClient,core 不绑定 provider。
 * LLM 失败时 fallback 到 RuleBasedNecessityEvaluator,保证可用性。
 *
 * AI-4 LlmTool 契约:本类实现 LlmTool<NecessityInput, NecessityVerdict>,
 * 让 dryRun / fallback 行为标准化。evaluate() 是 LlmTool 适配包装:
 *   - 旧调用方:evaluator.evaluate(input) → 走 runLlmTool(LLM + fallback)
 *   - 新调用方:runLlmTool(evaluator, input, { dryRun: true }) → 强制 heuristic
 */
export class LlmNecessityEvaluator
  implements NecessityEvaluator, LlmTool<NecessityInput, NecessityVerdict>
{
  private readonly fallback: RuleBasedNecessityEvaluator;
  readonly name = "llm-necessity-evaluator";

  constructor(private readonly client: LlmClient) {
    this.fallback = new RuleBasedNecessityEvaluator();
  }

  // ============================================================
  // LlmTool 契约实现
  // ============================================================

  hasHeuristicFallback(): boolean {
    return true;
  }

  async executeHeuristic(
    input: NecessityInput,
    _opts: LlmToolOptions,
  ): Promise<NecessityVerdict> {
    // 走规则版,绝调不到 LLM(契约保证)
    return this.fallback.evaluate(input);
  }

  async executeWithLlm(
    input: NecessityInput,
    opts: LlmToolOptions,
  ): Promise<NecessityVerdict> {
    const samplesBlock = input.samples
      .map((s, i) => `[${i + 1}] ${s}`)
      .join("\n");

    const existingTitles =
      input.existingTitles.length > 0
        ? input.existingTitles.slice(0, 20).join(" | ")
        : "(none)";

    const prompt = LLM_NECESSITY_PROMPT.replace(
      "<SAMPLE_COUNT>",
      String(input.samples.length),
    )
      .replace("<OCCURRENCES>", String(input.occurrences))
      .replace("<SAMPLES_BLOCK>", samplesBlock)
      .replace("<EXISTING_TITLES>", existingTitles);

    // maxTokens=1500 留足 reasoning 模型预算
    // reasoning 模型(Qwen3 / DeepSeek-R1 / DeepSeek-V4 / GLM-5.2 / Claude w/ thinking)
    // 会先输出 reasoning_content 再输出 content,300 tokens 不够会在思考阶段就截断
    const raw = await this.client.complete(prompt, {
      maxTokens: opts.maxTokens ?? 1500,
      temperature: opts.temperature ?? 0.1,
      timeoutMs: opts.timeoutMs ?? 30_000,
    });

    if (typeof raw !== "string" || raw.length === 0) {
      throw internalError(`LlmClient returned non-string: ${typeof raw}`);
    }

    const parsed = parseLlmVerdict(raw);
    if (!parsed) {
      throw internalError("non-JSON output from LLM");
    }
    return parsed;
  }

  // ============================================================
  // NecessityEvaluator 接口(旧 API,向后兼容)
  // ============================================================
  //
  // 保留 evaluate() 是为了不破坏现有 ProposalEngine 注入契约。新代码应用
  // runLlmTool(evaluator, input, opts) 显式走 LlmTool 路由。evaluate() 内部
  // 沿用旧行为(LLM 失败 → safeFallback 到规则),不强制调用方改代码。
  async evaluate(input: NecessityInput): Promise<NecessityVerdict> {
    const samplesBlock = input.samples
      .map((s, i) => `[${i + 1}] ${s}`)
      .join("\n");

    const existingTitles =
      input.existingTitles.length > 0
        ? input.existingTitles.slice(0, 20).join(" | ")
        : "(none)";

    const prompt = LLM_NECESSITY_PROMPT.replace(
      "<SAMPLE_COUNT>",
      String(input.samples.length),
    )
      .replace("<OCCURRENCES>", String(input.occurrences))
      .replace("<SAMPLES_BLOCK>", samplesBlock)
      .replace("<EXISTING_TITLES>", existingTitles);

    // 容错包装:任何意外 JS 错误(host adapter bug / 返回非 string / parseLlmVerdict
    // 内部异常 / fallback 自身抛错)都不会让 evaluate 失败。最坏情况返回保守拒绝。
    // 历史教训:necessity-evaluator 曾静默崩溃,导致 proposal 路径整体死掉,proposal
    // 队列无限累积。所有错误路径必须 fallback,不可 throw 出去。
    const safeFallback = async (
      prefix: "llm-unavailable" | "llm-parse-failed" | "internal-error",
      err: unknown,
    ): Promise<NecessityVerdict> => {
      try {
        const verdict = await this.fallback.evaluate(input);
        return {
          ...verdict,
          reason: `[${prefix}, rule-fallback] ${verdict.reason}`,
        };
      } catch (fallbackErr) {
        // 规则版兜底也挂了(不应该发生,但防御):返回保守拒绝 + 错误上下文
        return {
          necessary: false,
          reason: `[${prefix}, fallback-failed] ${err instanceof Error ? err.message : String(err)} | ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`,
        };
      }
    };

    let raw: unknown;
    try {
      // maxTokens=1500 留足 reasoning 模型预算
      // reasoning 模型(Qwen3 / DeepSeek-R1 / DeepSeek-V4 / GLM-5.2 / Claude w/ thinking)
      // 会先输出 reasoning_content 再输出 content,300 tokens 不够会在思考阶段就截断
      raw = await this.client.complete(prompt, {
        maxTokens: 1500,
        temperature: 0.1,
        timeoutMs: 30_000,
      });
    } catch (err) {
      // LLM 调用失败 → fallback 到规则
      return safeFallback("llm-unavailable", err);
    }

    // host adapter 协议:complete 必须返回 string。但防御性检查避免 trim() TypeError
    if (typeof raw !== "string" || raw.length === 0) {
      return safeFallback(
        "internal-error",
        new Error(`LlmClient returned non-string: ${typeof raw}`),
      );
    }

    let parsed: NecessityVerdict | null;
    try {
      parsed = parseLlmVerdict(raw);
    } catch (err) {
      // parseLlmVerdict 内部不应抛(已有 try/catch),但兜底防御
      return safeFallback("internal-error", err);
    }

    if (!parsed) {
      // LLM 返回非 JSON → fallback 到规则
      return safeFallback("llm-parse-failed", new Error("non-JSON output"));
    }

    return parsed;
  }
}

/**
 * 解析 LLM 返回的 JSON
 *
 * 容忍常见的不规范输出:前后带 markdown fence / 多余空白 / 嵌套在别的字段里
 */
function parseLlmVerdict(raw: string): NecessityVerdict | null {
  let text = raw.trim();

  // 剥 markdown fence
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    text = fenceMatch[1]!.trim();
  }

  // 抽取最外层 { ... }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  const jsonStr = text.slice(start, end + 1);

  let obj: { necessary?: unknown; reason?: unknown; suggestedTitle?: unknown };
  try {
    obj = JSON.parse(jsonStr);
  } catch {
    return null;
  }

  const necessary = obj.necessary === true;
  const reason =
    typeof obj.reason === "string" && obj.reason.trim().length > 0
      ? obj.reason.trim()
      : necessary
        ? "LLM approved"
        : "LLM rejected";
  const suggestedTitle =
    typeof obj.suggestedTitle === "string" &&
    obj.suggestedTitle.trim().length > 0
      ? obj.suggestedTitle.trim().slice(0, 200)
      : undefined;

  return { necessary, reason, suggestedTitle };
}
