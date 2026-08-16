/**
 * 夜思契约与 L1 基线执行器(spec §四)。
 *
 * core 只定义任务/回写契约,不绑宿主;L2 执行器由宿主提供(claude-code =
 * headless spawn / 现场会话;openclaw 一期降级 L1)。L1 = 单次 LLM 远距类比,
 * 仅当宿主无 agent runtime 或 L2 不可用时使用 —— 不与 L2 并存竞争预算。
 *
 * Dormio 协议形态(非睡眠机制):播种 → 锚定 → 捕获 → 回灌迭代 → resolve。
 *
 * @module @co-engram/core/maintenance/insight
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import type { EngramRepository } from "../../storage/repository.js";
import type { LlmClient } from "../../observability/necessity-evaluator.js";
import { buildNightThinkingL1Prompt } from "./modes.js";
import { parseDrafts } from "./run.js";
import type { NightThinkingReport, NightThinkingTask } from "./types.js";

/**
 * 零存活轮标记(共享契约常量):生产端 dreamHistoryFor(incubator.ts)在
 * 零存活轮的梦境史行里渲染它,消费端 synthesizeFinalAnswer 靠它判定空态。
 * 两端必须引用同一常量,禁止手写串 —— 漂移会导致空态诚实性指令失配。
 */
export const NO_SURVIVOR_MARKER = "(no insight survived validation)";

/**
 * dataRoot/.co-engram 下可作夜思证据源的日志/状态文件(存在才返回)。
 * 仅列行为证据类文件;不列 incubations/proposals 等内部存储 —— 那些由
 * dreamHistory / 提案工具面结构化提供,直读会绕过脱敏边界。
 */
const RESOURCE_FILES = [
  "signals.jsonl",
  "maintenance-state.json",
  "audit.jsonl",
  "rem-state.json",
  "observation-windows.jsonl",
] as const;

/** 收集 dataRoot/.co-engram 下存在的资源文件路径(协议 RESOURCE MANDATE 证据面) */
export function collectResourceHints(dataRoot: string): string[] {
  const dir = join(dataRoot, ".co-engram");
  return RESOURCE_FILES.map((f) => join(dir, f)).filter((p) => existsSync(p));
}

/**
 * 固化协议(spec §四 L2 主路径):协议固化在 incubation_run 返回的结构化
 * 指令中,不依赖 agent 自觉;incubation_report 是唯一写回路径。
 */
export const NIGHT_THINKING_PROTOCOL = `NIGHT-THINKING PROTOCOL (follow exactly):
1. CAPABILITY INVENTORY — enumerate your available read-only capabilities
   (installed skills, engram_search, repository reading, WebSearch if allowed).
2. RESOURCE MANDATE — mine ALL available resources before planning:
   - Full memory graph: engram_search from multiple angles (keywords,
     synonyms, upstream/downstream concepts); survey engram_list_paths.
     Do NOT limit yourself to the seed digests.
   - Behavioral logs: paths in task.resourceHints are local log/state files
     you may Read; ground improvement-type questions in real usage evidence
     (retrieval counts, failed uses).
   - Installed skills: enumerate via skill_list; read relevant ones via
     skill_get and apply their methodology.
3. PLAN — decide the steps: what to examine, which capability for each step,
   what question each step answers. Keep it small (3-6 steps).
4. EXECUTE — run the plan with READ-ONLY actions only. Record what you did
   and what you found at each step. Do NOT write or modify anything.
   PRIVACY: web research is ${"__WEB__"} — if disabled, do not make any
   network call; never send raw memory content to external services; only
   the question and summary-level content may leave.
5. REPORT — call the tool \`incubation_report\` exactly once with a JSON object:
   { "incubationId": "<id>", "report": { "insights": [ <insight drafts> ],
     "plan": [ {"step": "...", "capability": "..."} ],
     "trace": [ {"step": "...", "action": "...", "detail": "..."} ],
     "externalCalls": [ {"tool": "...", "purpose": "...", "at": "<ISO>"} ] } }
   Each insight draft: { "type": "theme|lesson|analogy|hypothesis", "title",
   "summary", "content", "sourceIds": [...], "domainTags": [...], "reason",
   "aar": {...} (lesson only) }. Insights are captured immediately — do not
   wait or batch. Do not repeat directions already explored in the dream
   history; deepen or pivot.
   EVIDENCE ANCHORING (hard gate): every insight's sourceIds must contain ONLY
   real engram ids from the memory repo — the path-like ids returned by
   engram_search / engram_get / seed digests — at least one per insight.
   Findings from other resources (source code, behavioral logs, web pages)
   are valuable evidence but are NOT valid sourceIds: cite them inside
   content (e.g. "verified in repo source / log") and mention them in reason.
   Insights with empty, invented, or non-engram sourceIds are rejected by
   the citation gate before review.`;

/** 组装带隐私开关的协议文本 */
export function buildProtocol(webResearchOptIn: boolean): string {
  return NIGHT_THINKING_PROTOCOL.replace("__WEB__", webResearchOptIn ? "ALLOWED (opted-in)" : "DISABLED (default)");
}

/**
 * L1 基线执行器:单次 llmClient.complete,远距类比 + 锚定 + 梦境史回灌。
 * 无 plan/trace(L1 无编排);externalCalls 为空(不联网)。
 */
export function createL1Executor(
  llm: LlmClient,
  repo: EngramRepository,
): { execute(task: NightThinkingTask): Promise<NightThinkingReport> } {
  return {
    async execute(task) {
      // 种子用 S 别名(与 run.ts 同因:LLM 抄写 26 位 ULID 极易出错)
      const alias = new Map<string, string>();
      const seedText = task.seedDigests
        .map((s, i) => {
          const a = `S${i + 1}`;
          alias.set(a, s.id);
          return `- [${a}] ${s.title} (id=${s.id}) | tags=${s.domainTags.join("/")} | ${s.summary}`;
        })
        .join("\n");
      const prompt = buildNightThinkingL1Prompt(
        task.question,
        seedText || "(no seeds)",
        task.dreamHistory,
      );
      const raw = await llm.complete(prompt, { temperature: 0.5, maxTokens: 131072, timeoutMs: 600_000 });
      const insights = parseDrafts(raw, "inspiration")
        .map((d) => ({
          ...d,
          sourceIds: d.sourceIds.map((x) => alias.get(x) ?? x),
        }))
        .map((d) => ({
          ...d,
          mode: "inspiration" as const,
        }));
      return {
        insights,
        plan: [{ step: "L1 single-pass distant analogy", capability: "llm" }],
        trace: [
          { step: "generate", action: "llm.complete", detail: `${insights.length} drafts` },
        ],
        externalCalls: [],
      };
    },
  };
}

/** 种子摘要(脱敏:不带记忆原文;viewer/L2 prompt 组装共用) */
export function collectSeedDigests(
  repo: EngramRepository,
  seedEngramIds: readonly string[],
  cap = 12,
): NightThinkingTask["seedDigests"] {
  const out: Array<NightThinkingTask["seedDigests"][number]> = [];
  for (const id of seedEngramIds.slice(0, cap)) {
    try {
      const e = repo.readEngram(id);
      out.push({
        id: e.id,
        title: e.title,
        summary: e.summary,
        domainTags: e.domainTags ?? [],
      });
    } catch {
      // 种子可能已删除,跳过
    }
  }
  return out;
}

/**
 * 阶段性回答草稿(spec §五):对「问题 + 梦境史 + 本轮摘要 + 本轮执行语境」
 * 做单次综合。不降级 —— 调用失败/空输出由调用方记 answerDraftError,绝不
 * 拼接伪草稿。
 *
 * roundContext(2026-08-16 机制缺陷修复:综合层信息面断裂):零存活轮里
 * 执行层 agent 往往做了大量实质工作(资源盘点/源码核实/联网调研),但旧
 * 输入面只有「存活摘要」—— 综合层对拒因与执行轨迹一无所知,只能猜测性
 * 归因(「问题表述模糊」「先明确概念所指」),把系统缺陷误报成用户提问
 * 问题。此处把拒因/轨迹/外部调研 purpose 注入综合输入,归因必须锚定真实
 * 证据。
 */
export async function synthesizeAnswerDraft(
  llm: LlmClient,
  question: string,
  dreamHistoryBefore: string,
  roundSummaries: readonly string[],
  roundContext?: {
    /** 本轮逐条拒绝原因(三道闸;title 前缀 + reason) */
    readonly rejectReasons?: readonly string[];
    /** 本轮执行轨迹摘要(step: action — detail) */
    readonly traceSummary?: readonly string[];
    /** 本轮外部调用申报(tool: purpose) */
    readonly externalPurposes?: readonly string[];
  },
): Promise<string> {
  const ctx = roundContext ?? {};
  const prompt = [
    "You are synthesizing a WORKING ANSWER DRAFT (not final) for an incubated question.",
    "Audience: the user who planted the question. Language: match the question's language.",
    "",
    "## Question",
    question,
    "",
    "## Dream history (previous rounds, with user accept/dismiss dispositions)",
    dreamHistoryBefore.trim() || "(no previous rounds)",
    "",
    "## This round's surviving insight summaries",
    roundSummaries.length ? roundSummaries.map((s) => `- ${s}`).join("\n") : "(none survived this round)",
    "",
    "## This round's execution trace (what the thinking agent actually did)",
    ctx.traceSummary?.length ? ctx.traceSummary.map((t) => `- ${t}`).join("\n") : "(no trace recorded)",
    ...(ctx.externalPurposes?.length
      ? [`External research performed: ${ctx.externalPurposes.map((p) => `[${p}]`).join(" ")}`, ""]
      : []),
    "## This round's rejection reasons (why drafts died at the quality gates)",
    ctx.rejectReasons?.length ? ctx.rejectReasons.map((r) => `- ${r}`).join("\n") : "(none)",
    "",
    "Write 3-6 sentences: what the accumulated evidence currently suggests as an answer,",
    "how confident it is, and what the next round should examine. If nothing survived yet,",
    "say so honestly instead of inventing conclusions — and when explaining WHY nothing",
    "survived, ground the explanation in the rejection reasons and execution trace above.",
    "Do NOT speculate that the question is too vague or ask the user to clarify the",
    "subject unless the rejection reasons actually say so.",
    "Plain text only, no markdown fences.",
  ].join("\n");
  // 效果优先(2026-08-15 用户决策,与 critic.ts 对齐):GLM thinking 模型
  // 思考耗时长,120s 会系统性超时 → 600s;8192 → 16384 给足输出预算
  const raw = await llm.complete(prompt, {
    temperature: 0.3,
    maxTokens: 16384,
    timeoutMs: 600_000,
  });
  const text = raw.trim();
  if (!text) throw new Error("empty synthesis output");
  return text.slice(0, 4000);
}

/**
 * 最终回答(spec §五收束):对全部梦境史做终版综合。
 * 诚实性:历史为空/零存活时必须如实陈述,禁止虚构。
 */
export async function synthesizeFinalAnswer(
  llm: LlmClient,
  question: string,
  dreamHistory: string,
): Promise<string> {
  // 「零存活」= 全部轮次都无存活洞察(逐行判定;混合历史 —— 部分轮成案、
  // 部分轮零存活 —— 不算零存活,不能给 LLM 注入与可见历史矛盾的空态指令)
  const lines = dreamHistory.split("\n").filter((l) => l.trim());
  const empty =
    lines.length === 0 ||
    lines.every((l) => l.includes(NO_SURVIVOR_MARKER));
  const prompt = [
    "You are writing the FINAL ANSWER for an incubated question, based only on the dream history below.",
    "Audience: the user who planted the question. Language: match the question's language.",
    "",
    "## Question",
    question,
    "",
    "## Dream history (all rounds, with user accept/dismiss dispositions)",
    dreamHistory.trim() || "(empty — no round produced anything)",
    "",
    empty
      ? "MANDATORY: no insight survived. State this honestly, explain what blocked progress "
        + "(see history notes), and suggest what the user should change (seeds, schedule, or question). "
        + "Do NOT invent findings."
      : "Synthesize the accumulated, user-vetted insights into a direct, actionable answer. "
        + "Cite which accepted insights support each point. Note open gaps honestly.",
    "",
    "Plain text, 5-15 sentences. No markdown fences.",
  ].join("\n");
  // 与 synthesizeAnswerDraft 同款参数(效果优先:600s 超时 + 16384 输出预算)
  const raw = await llm.complete(prompt, {
    temperature: 0.3,
    maxTokens: 16384,
    timeoutMs: 600_000,
  });
  const text = raw.trim();
  if (!text) throw new Error("empty final answer output");
  return text.slice(0, 8000);
}
