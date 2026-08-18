/**
 * 思考计划生成(Phase2 计划先行,2026-08-18)—— 清单生成权转移:
 * 需求拓扑由引擎/critic 在 run 启动时(buildTask)生成落盘,执行者不再
 * 自拟清单(v7 P0 结构性弱点的根治:所有「被判断的对象」不再由被审查者
 * 亲手撰写)。
 *
 * 生成双源:
 * - llm:critic 式单次调用,从问题结构 + 种子 + 深思史 + 上轮未闭合缺口
 *   生成 3-6 项需求(资源类型/描述/必要性/探测 payload);engrams 项强制
 *   ≥2 个探测变体(P1:两次皆空 → 引擎自动豁免)。
 * - template:无 llmClient(测试/最小部署)的机械兜底 —— 问题词切片作
 *   查询,资源类型模板;planSource 落审计可区分。
 *
 * 跨轮接力:上轮 degraded 的未闭合缺口机械追加为 logic-needed 计划项
 * (不依赖 LLM 判断 —— 接力权转移的 Phase2 部分;完整 P8 在 Phase3)。
 *
 * @module @co-engram/core/maintenance/insight
 */

import { randomUUID } from "node:crypto";

import type { LlmClient } from "../../observability/necessity-evaluator.js";
import type { PonderPlan, PonderPlanItem, PonderProbe } from "./types.js";

/** 计划生成输入(buildTask 组装;全部脱敏级内容) */
export interface PlanGenerationInput {
  readonly question: string;
  readonly seedTitles: readonly string[];
  readonly dreamHistory: string;
  /** 上轮 degraded 未闭合缺口描述(机械接力,不依赖 LLM) */
  readonly carryOverGaps: readonly string[];
}

/** LLM 计划生成的输出契约(解析失败/字段非法 → 逐项过滤,不整单拒绝) */
interface RawPlanItem {
  readonly resourceType?: unknown;
  readonly description?: unknown;
  readonly necessity?: unknown;
  readonly probes?: unknown;
}

const RESOURCE_TYPES: ReadonlySet<string> = new Set(["engrams", "skills", "logs", "web", "mcp"]);
/** 计划项上限:计划=引擎承诺,过度规划直接惩罚执行者,critic 被指示保守 */
const MAX_PLAN_ITEMS = 8;

function newPlanId(): string {
  return `pi-${randomUUID().slice(0, 8)}`;
}

function sanitizeProbes(raw: unknown, resourceType: string): PonderProbe[] {
  if (!Array.isArray(raw)) return [];
  const out: PonderProbe[] = [];
  for (const p of raw) {
    const q = (p as { query?: unknown })?.query;
    if (typeof q !== "string") continue;
    const trimmed = q.trim().slice(0, 300);
    if (trimmed) out.push({ query: trimmed });
    if (out.length >= 4) break;
  }
  // P1:engrams 项至少 2 个探测变体(两次皆空才可豁免);LLM 少给时由
  // 问题词补足 —— 变体数是引擎义务,不依赖 LLM 自觉
  if (resourceType === "engrams" && out.length < 2) {
    // 调用方(模板兜底)会补;此处 LLM 路径同样兜底
    return out; // 由 generateThinkPlan 统一补足
  }
  return out;
}

/**
 * LLM 生成思考计划(critic 式单次调用;fail-open 到模板 —— 计划缺失比
 * 计划平庸更糟,模板至少保证资源类型覆盖与探测变体)。
 */
export async function generateThinkPlan(
  llm: LlmClient,
  input: PlanGenerationInput,
  now: () => string,
): Promise<PonderPlan> {
  const template = templatePlan(input, now);
  try {
    const prompt = [
      "You are the PLANNING critic for a deep-thinking (contemplation) run.",
      "Given ONLY the question (plus seed titles and past-session summaries), draft the",
      "requirement topology the run MUST close: which resource types are needed, why,",
      "and with which probe queries. The executor cannot add or drop these items —",
      "they are the contract.",
      "",
      "Rules:",
      "- 3-6 items (8 max). Be conservative: every item blocks finalization until closed.",
      "- resourceType ∈ engrams | skills | logs | web | mcp.",
      "- necessity: logic-needed only when the question genuinely cannot be answered",
      "  without it; otherwise helpful.",
      "- engrams items carry >= 2 probe queries (distinct angles: keywords, synonyms,",
      "  upstream concepts). If every probe returns empty the item is auto-exempted,",
      "  so make them plausible — do NOT sabotage them with irrelevant terms.",
      "- web items carry 1-3 probe queries (used verbatim by the executor).",
      "- skills: probes optional (skill inventory is a mechanical call).",
      "- logs/mcp: no probes.",
      "",
      "## Question",
      input.question,
      "",
      "## Seed memory titles (hints, not the boundary)",
      input.seedTitles.length ? input.seedTitles.map((t) => `- ${t}`).join("\n") : "(none)",
      "",
      "## Previous thinking sessions",
      input.dreamHistory.trim() || "(none)",
      "",
      input.carryOverGaps.length
        ? "## Carry-over open gaps from the previous degraded run (MUST be covered)\n" +
          input.carryOverGaps.map((g) => `- ${g}`).join("\n")
        : "",
      "",
      'Reply with ONLY a JSON object: {"items":[{"resourceType":"...","description":"...","necessity":"logic-needed|helpful","probes":[{"query":"..."}]}]}',
    ]
      .filter(Boolean)
      .join("\n");
    const raw = await llm.complete(prompt, { temperature: 0.3, maxTokens: 4096, timeoutMs: 120_000 });
    const parsed = JSON.parse(extractJson(raw)) as { items?: unknown };
    if (!Array.isArray(parsed.items)) return template;
    const items: PonderPlanItem[] = [];
    const seen = new Set<string>();
    for (const rawItem of parsed.items as RawPlanItem[]) {
      if (items.length >= MAX_PLAN_ITEMS) break;
      const resourceType = String(rawItem.resourceType ?? "");
      if (!RESOURCE_TYPES.has(resourceType)) continue;
      const typedResourceType = resourceType as PonderPlanItem["resourceType"];
      const description = String(rawItem.description ?? "").trim().slice(0, 500);
      if (!description) continue;
      const necessity = rawItem.necessity === "helpful" ? "helpful" : "logic-needed";
      const probes = sanitizeProbes(rawItem.probes, resourceType);
      const dedupe = `${resourceType}::${description.toLowerCase()}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      items.push({
        id: newPlanId(),
        resourceType: typedResourceType,
        description,
        necessity,
        probes,
      });
    }
    if (items.length === 0) return template;
    // 兜底融合:LLM 计划缺 engrams 项或 engrams 变体不足 → 从模板补足
    return finalizePlan("llm", items, input, now);
  } catch {
    // 解析失败/超时/空输出:模板兜底(fail-open,计划平庸好过无计划)
    return template;
  }
}

/**
 * 机械模板计划(无 llmClient 兜底 / LLM 失败兜底):
 * engrams logic-needed(问题本体 + 关键词两组变体)、skills/logs/web/mcp
 * helpful(web 带 1 个问题词探测,payload 受控但执行不可观测)。
 */
export function templatePlan(input: PlanGenerationInput, now: () => string): PonderPlan {
  const items: PonderPlanItem[] = [
    {
      id: newPlanId(),
      resourceType: "engrams",
      description: "记忆图谱检索:问题相关记忆的全量盘点",
      necessity: "logic-needed",
      probes: [
        { query: input.question.trim().slice(0, 200) },
        { query: keywordsOf(input.question) },
      ],
    },
    {
      id: newPlanId(),
      resourceType: "skills",
      description: "技能盘点:co-engram 印迹与宿主技能的适用性检查",
      necessity: "helpful",
      probes: [],
    },
    {
      id: newPlanId(),
      resourceType: "logs",
      description: "行为日志佐证(问题涉及使用模式/演化史时)",
      necessity: "helpful",
      probes: [],
    },
    {
      id: newPlanId(),
      resourceType: "web",
      description: "联网检索(问题涉及外部事实/业界趋势时)",
      necessity: "helpful",
      probes: [{ query: input.question.trim().slice(0, 200) }],
    },
    {
      id: newPlanId(),
      resourceType: "mcp",
      description: "其他 MCP 工具盘点(问题涉及代码/文档核实时)",
      necessity: "helpful",
      probes: [],
    },
  ];
  return finalizePlan("template", items, input, now);
}

/**
 * 计划终态化(双源共用):
 * - 跨轮接力缺口机械追加为 logic-needed engrams 项(描述即缺口原文,
 *   不经 LLM 改写 —— 接力权在引擎);
 * - engrams 项探测变体 <2 时补足(模板第二变体 = 关键词切片)。
 */
function finalizePlan(
  source: "llm" | "template",
  items: PonderPlanItem[],
  input: PlanGenerationInput,
  now: () => string,
): PonderPlan {
  const out = items.map((it) =>
    it.resourceType === "engrams" && it.probes.length < 2
      ? {
          ...it,
          probes: [
            ...it.probes,
            { query: keywordsOf(`${it.description} ${input.question}`) },
          ],
        }
      : it,
  );
  const existing = new Set(out.map((it) => `${it.resourceType}::${it.description.toLowerCase()}`));
  for (const gap of input.carryOverGaps) {
    const description = gap.trim().slice(0, 500);
    if (!description) continue;
    const key = `engrams::${description.toLowerCase()}`;
    if (existing.has(key)) continue;
    existing.add(key);
    out.push({
      id: newPlanId(),
      resourceType: "engrams",
      description,
      necessity: "logic-needed",
      probes: [
        { query: description.slice(0, 200) },
        { query: keywordsOf(description) },
      ],
      carryOver: true,
    });
  }
  return { source, generatedAt: now(), items: out };
}

/** 问题关键词切片(模板第二探测变体;无停用词表的长词优先) */
function keywordsOf(question: string): string {
  const tokens = question
    .split(/[^\p{L}\p{N}_]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
    .sort((a, b) => b.length - a.length)
    .slice(0, 5);
  return tokens.join(" ").slice(0, 200) || question.trim().slice(0, 200);
}

/** 从 LLM 输出剥 ```json 围栏 / 前后散文 */
function extractJson(raw: string): string {
  const text = raw.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence) return fence[1]!.trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return text;
}
