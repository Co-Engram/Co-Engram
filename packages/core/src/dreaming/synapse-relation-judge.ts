/**
 * 突触关系语义判断层(REM 突触维护二期 / 反思落地,2026-08)。
 *
 * 背景:图谱取证(2026-08-16)149 条突触 80% similar_to,causes/depends_on/
 * follows/supersedes/consolidates/contradicts 全 0——根因是 similar_to 靠向量/
 * token 相似机械可算,因果/时间族需要语义判断,只有 LLM 能做(记忆
 * 01KYCGK8FPGW2GW9C3WF0FK2TM)。本模块补上这一层。
 *
 * 职责边界(与 synapse-refiner 分工):
 *   - refiner:计算「哪些 engram 对值得看」(增量活跃集 + Jaccard 预筛 + 三层节流)
 *   - 本模块:对候选对做**语义关系判断**(12 种 SynapseKind 或 none)
 *   - propose 与审批:仍走 proposeSynapseOp → 提案中心(用户裁决,不直写)
 *
 * 降级链(不做机械伪因果):llmClient 缺失/调用失败/输出不可解析 → 调用方
 * 降级(refiner 降回占位 similar_to 提案 / 写入时反思直接跳过),记审计
 * reflection_skipped。机械层只负责筛候选,关系判断只有 LLM。
 *
 * @module @co-engram/core/dreaming
 */

import type { LlmClient } from "../observability/necessity-evaluator.js";
import type { SynapseKind } from "../types/synapse.js";

/** 判断结果:kind 为 "none" 表示两记忆无明确语义关系(不提案) */
export interface RelationVerdict {
  readonly kind: SynapseKind | "none";
  readonly confidence: number;
  readonly reason: string;
  /**
   * 有向关系(causes/supersedes/derives_from 等)的实际方向与给出的
   * from→to 相反(即 to→from 成立)时为 true;propose 时交换两端。
   * 候选对的 a/b 来自字典序去重,方向由 LLM 裁定。
   */
  readonly reverse?: boolean;
}

/** 待判断的一对(素材由调用方预截断控 token) */
export interface RelationJudgePair {
  readonly aId: string;
  readonly bId: string;
  readonly aTitle: string;
  readonly bTitle: string;
  /** 端点素材:summary + domainTags(已截断) */
  readonly aText: string;
  readonly bText: string;
}

/** 12 种 SynapseKind + none 的判断选项 */
const JUDGEABLE: readonly (SynapseKind | "none")[] = [
  "extends",
  "part_of",
  "similar_to",
  "depends_on",
  "causes",
  "follows",
  "derives_from",
  "contradicts",
  "exemplifies",
  "supersedes",
  "consolidates",
  "contextualizes",
  "none",
];

/** 每批判断的对数上限(控单次 prompt token) */
export const RELATION_JUDGE_BATCH_SIZE = 8;

/** 单端素材(title+summary+tags 参与判断)的截断长度(字符) */
export const RELATION_JUDGE_TEXT_MAX_CHARS = 400;

const KIND_DEFINITIONS = `各 kind 的语义(方向均为 from → to):
- extends:from 是 to 的泛化/上位概念(to 是 from 的特化;如 pattern→fact)
- part_of:from 是 to 的组成部分(to 是更大的整体)
- similar_to:内容主题相似,但无上述明确结构/因果/时间关系
- depends_on:from 依赖 to(缺 to 的知识,from 不完整/不成立)
- causes:from 描述的事因导致/引发 to 描述的结果
- follows:from 在时间或流程上先于 to(to 跟随/承接 from)
- derives_from:from 的结论从 to 推导、提炼或综合而来
- contradicts:from 与 to 相互矛盾(同一问题给出不相容结论)
- exemplifies:from 是 to 所述抽象规律/模式的一个具体实例
- supersedes:from 取代 to(to 的内容已过时,以 from 为准)
- consolidates:from 整合/收纳了 to 的内容(to 被并入 from)
- contextualizes:from 为 to 提供背景、语境或适用条件
- none:无明确语义关系(宁缺毋滥,不确定时选 none)`;

/**
 * 构建批量判断 prompt。要求输出严格 JSON(带 index 回定位),reason 用简体中文。
 */
export function buildRelationJudgePrompt(
  pairs: readonly RelationJudgePair[],
): string {
  const blocks = pairs
    .map((p, i) => {
      const a = truncate(p.aText, RELATION_JUDGE_TEXT_MAX_CHARS);
      const b = truncate(p.bText, RELATION_JUDGE_TEXT_MAX_CHARS);
      return `[${i}] from(${p.aId}): ${p.aTitle}\n${a}\n---\n[${i}] to(${p.bId}): ${p.bTitle}\n${b}`;
    })
    .join("\n\n=====\n\n");
  return `你是团队知识图谱的突触关系审查员。下面每对记忆(from/to)已通过机械相似度预筛,请判断它们之间最恰当的语义关系。

${KIND_DEFINITIONS}

判断要求:
1. 只依据给出的文本判断,不臆测未提及的因果;证据不足时选 none
2. confidence ∈ [0,1]:关系在文本中的明确程度(1=文本直接陈述,0.5=合理推断)
3. reason 一句话说明依据(简体中文,≤60 字)
4. 有向关系按 from → to 理解;若实际方向相反(to → from 才成立),加 "reverse": true
5. 只输出 JSON,不加任何其他文字:
{"judgments":[{"index":0,"kind":"causes","confidence":0.8,"reason":"...","reverse":false},...]}

待判断的记忆对:
${blocks}`;
}

/**
 * 解析 LLM 输出。非法 JSON / 结构不符 / index 越界 / kind 未知 → undefined
 * (整体解析失败,调用方降级——不部分采纳,防错位配对)。
 */
export function parseRelationJudgeOutput(
  raw: string,
  pairCount: number,
): RelationVerdict[] | undefined {
  let parsed: unknown;
  try {
    // 容错:剥掉 ```json 围栏与前后杂文
    const jsonStart = raw.indexOf("{");
    const jsonEnd = raw.lastIndexOf("}");
    if (jsonStart < 0 || jsonEnd <= jsonStart) return undefined;
    parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
  } catch {
    return undefined;
  }
  const judgments = (parsed as { judgments?: unknown }).judgments;
  if (!Array.isArray(judgments) || judgments.length === 0) return undefined;
  const out: RelationVerdict[] = [];
  for (const j of judgments) {
    const obj = j as {
      index?: unknown;
      kind?: unknown;
      confidence?: unknown;
      reason?: unknown;
      reverse?: unknown;
    };
    const idx = Number(obj.index);
    if (!Number.isInteger(idx) || idx < 0 || idx >= pairCount) return undefined;
    if (typeof obj.kind !== "string") return undefined;
    if (!JUDGEABLE.includes(obj.kind as SynapseKind | "none")) return undefined;
    const confidence = Number(obj.confidence);
    if (!Number.isFinite(confidence)) return undefined;
    out.push({
      kind: obj.kind as SynapseKind | "none",
      confidence: Math.min(1, Math.max(0, confidence)),
      reason: typeof obj.reason === "string" ? obj.reason.slice(0, 200) : "",
      ...(obj.reverse === true ? { reverse: true } : {}),
    });
  }
  return out;
}

/**
 * 对候选对批量调 LLM 判断(分批,每批 ≤ RELATION_JUDGE_BATCH_SIZE 对)。
 *
 * 降级粒度:按批降级——某批调用失败/解析失败返回该批的 undefined 位,
 * 其余批次照常(单批失败不拖垮整轮)。
 *
 * @returns 与输入 pairs 等长的数组,元素 undefined = 该对所在批次降级
 */
export async function judgeRelationPairs(
  llmClient: LlmClient,
  pairs: readonly RelationJudgePair[],
  options: { readonly batchSize?: number } = {},
): Promise<(RelationVerdict | undefined)[]> {
  const size = options.batchSize ?? RELATION_JUDGE_BATCH_SIZE;
  const out: (RelationVerdict | undefined)[] = new Array(pairs.length).fill(
    undefined,
  );
  for (let start = 0; start < pairs.length; start += size) {
    const batch = pairs.slice(start, start + size);
    let raw: string;
    try {
      raw = await llmClient.complete(buildRelationJudgePrompt(batch), {
        temperature: 0,
        maxTokens: 120 * batch.length,
        timeoutMs: 60_000,
      });
    } catch {
      continue; // 该批调用失败 → 降级(undefined 位)
    }
    const verdicts = parseRelationJudgeOutput(raw, batch.length);
    if (verdicts === undefined) continue; // 解析失败 → 降级
    for (let i = 0; i < verdicts.length; i++) {
      out[start + i] = verdicts[i];
    }
  }
  return out;
}

/** 截断(按字符;保持前缀,语义密度通常在开头) */
function truncate(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}
