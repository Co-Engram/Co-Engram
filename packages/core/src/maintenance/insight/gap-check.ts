/**
 * PDCA 闭合校验(Phase1,2026-08-18)—— 生成权转移的最小实现:
 * 闭合证据从执行者自报改为引擎侧调用流水(signals.jsonl)机械复核。
 *
 * 统一原则(engram 01M08950SRAHWPZ6FDZPAZR9EQ v7):凡被校验的对象,
 * 生成权不得留在被审查的执行者手中。本模块把三类「自报」钉死在事实上:
 * 1. 假闭合:closed 的 engrams/skills 条目,流水里必须有对应真实调用
 *    (evidence.ids ⊆ 流水检索/读取集合),否则判缺口;
 * 2. 瞒报:流水里有 engram/skill 读调用而清单未报对应条目 → 整单拒绝;
 *    流水零读调用(完全偏废)→ 整单拒绝;
 * 3. 零增量:洞察 sourceIds 全部来自任务包种子 → 该洞察拒绝。
 *
 * P3 重报语义反转:同哈希缺口重报 = 修复失败计数(reopens+1),连续
 * gapReopenEscalation 次 → 强制升级 logic-needed;终束只能由预算耗尽
 * 触发,重报本身不构成任何终束理由。
 *
 * 本模块是纯函数(无 IO),单测覆盖全部拒绝/缺口路径;IO(流水快照、
 * 时间窗过滤)由 incubator 侧组装后传入。
 *
 * @module @co-engram/core/maintenance/insight
 */

import { createHash } from "node:crypto";

import type { ToolCallEvent } from "../../signals/types.js";
import type {
  PonderGap,
  PonderPlanItem,
  PonderRequirement,
  PonderResourceType,
} from "./types.js";
import { INSIGHT_LIMITS } from "./types.js";

/** engram 读取类工具(进入闭合证据面;写类不算) */
const ENGRAM_READ_TOOLS: ReadonlySet<string> = new Set([
  "engram_get",
  "engram_search",
  "engram_list",
  "engram_list_paths",
  "engram_audit_query",
  "engram_synthesize",
]);

/** skill 读取/使用类工具 */
const SKILL_TOOLS: ReadonlySet<string> = new Set(["skill_get", "skill_list", "skill_invoke"]);

/** 引擎可观测(可事实化闭合)的资源类型 */
const OBSERVABLE_TYPES: ReadonlySet<PonderResourceType> = new Set(["engrams", "skills"]);

/** 流水证据汇总(时间窗过滤后) */
export interface EvidenceDigest {
  /** 真实读到的 engram id(retrievedEngramIds ∪ engram_get input.id) */
  readonly engramsRead: ReadonlySet<string>;
  readonly engramReadCalls: number;
  /** skill_get/skill_invoke 涉及的 skill id */
  readonly skillIds: ReadonlySet<string>;
  readonly skillCalls: number;
  /**
   * P1:engram_search 调用明细(query + 命中数,outputSummary={hits:N} 解析)。
   * 引擎探测的「逐字执行」与「空结果」都从这机械核验 —— 豁免权在引擎侧。
   */
  readonly searches: ReadonlyArray<{ readonly query: string; readonly hits: number }>;
}

/** 汇总证据(纯函数;events 需已按 run 时间窗过滤) */
export function digestEvidence(events: readonly ToolCallEvent[]): EvidenceDigest {
  const engramsRead = new Set<string>();
  const skillIds = new Set<string>();
  const searches: Array<{ query: string; hits: number }> = [];
  let engramReadCalls = 0;
  let skillCalls = 0;
  for (const e of events) {
    if (ENGRAM_READ_TOOLS.has(e.toolName)) {
      engramReadCalls += 1;
      if (e.toolName === "engram_get") {
        const id = e.input?.id;
        if (typeof id === "string" && id) engramsRead.add(id);
      }
      if (e.toolName === "engram_search") {
        const q = e.input?.query;
        if (typeof q === "string" && q.trim()) {
          searches.push({ query: q.trim(), hits: parseHits(e.outputSummary) });
        }
      }
      for (const id of e.retrievedEngramIds ?? []) engramsRead.add(id);
    } else if (SKILL_TOOLS.has(e.toolName)) {
      skillCalls += 1;
      const id = e.input?.id;
      if (typeof id === "string" && id) skillIds.add(id);
    }
  }
  return { engramsRead, engramReadCalls, skillIds, skillCalls, searches };
}

/** outputSummary `{hits: N}` → N(解析失败按 -1 = 未知,不视为空) */
function parseHits(summary: string | undefined): number {
  const m = /\{hits:\s*(\d+)\}/.exec(summary ?? "");
  return m ? Number(m[1]!) : -1;
}

/** 缺口哈希:资源类型 + 归一化描述(小写、压缩空白;跨轮稳定) */
export function gapHash(resourceType: PonderResourceType, description: string): string {
  const normalized = description.trim().toLowerCase().replace(/\s+/g, " ");
  return createHash("sha256").update(`${resourceType}::${normalized}`).digest("hex").slice(0, 16);
}

/** 清单校验结果(单条目维度;整单拒绝独立于缺口) */
export interface RequirementCheckResult {
  /** 整单拒绝原因(瞒报/零盘点;report 退回重报,不进修复回路) */
  readonly reject?: string;
  /** 本轮视角的缺口/闭合记录(含 helpful 未闭合项;不含历史未重报项) */
  readonly current: readonly PonderGap[];
}

/**
 * 校验需求清单(纯函数):
 * - L2 + 引擎有证据面时清单必填;
 * - 瞒报拦截:流水有读调用而清单无对应类型条目 → reject;
 * - 零盘点拦截:流水零 engram 读调用(完全偏废)→ reject;
 * - 假闭合复核:closed + 可观测类型 → evidence.ids 逐个对流水,缺一即缺口。
 */
/**
 * evidence-mismatch 的自解释诊断(2026-08-20):拒绝必须自带修复所需的
 * 全部信息——未观测到的 claimed id、引擎观测到的 id 集(截断)、合法证据
 * 锚点、以及「ids 留空 + 本类型有调用」的类型级闭合出口。此前只有
 * reason 标签,执行者只能盲猜(实测两次重报),违反快速失败原则。
 */
function mismatchDetail(
  resourceType: import("./types.js").PonderResourceType,
  missing: readonly string[],
  readIds: ReadonlySet<string>,
  callCount: number,
): string {
  const observed = [...readIds].slice(0, 8).join(", ");
  const observedNote = readIds.size
    ? `${observed}${readIds.size > 8 ? `, ...(${readIds.size} total)` : ""}`
    : "(none)";
  if (resourceType === "engrams") {
    return (
      `claimed evidence.ids not observed in this run's tool-call stream: [${missing.join(", ")}]. ` +
      `Valid engram anchors are ids passed to engram_get or surfaced by engram_search hits; ` +
      `engine observed these ids this run: ${observedNote} (${callCount} read call(s)). ` +
      `Fix: cite only ids you actually read, OR leave evidence.ids empty — an empty list still closes ` +
      `this item at type level when the engine observed at least one engram read call this run.`
    );
  }
  return (
    `claimed evidence.ids not observed in this run's tool-call stream: [${missing.join(", ")}]. ` +
    `Skill evidence only counts co-engram imprint ids actually passed to skill_get / skill_invoke — ` +
    `skill_list results and host-runtime skill names are NOT valid ids (host-skill calls are outside ` +
    `the engine's observation surface; record them in the trace instead). ` +
    `Engine observed these ids this run: ${observedNote} (${callCount} skill call(s)). ` +
    `Fix: cite only imprint ids you actually read via skill_get, OR leave evidence.ids empty — an empty ` +
    `list still closes this item at type level when the engine observed at least one skill call ` +
    `(e.g. the skill_list inventory) this run.`
  );
}

/** 类型级零调用的 mismatch 诊断:告知最低成本闭合路径(先调一次该类型工具) */
function zeroCallDetail(resourceType: import("./types.js").PonderResourceType): string {
  if (resourceType === "engrams") {
    return "no engram read call observed this run — self-declared closure without any engram call is rejected. " +
      "Run at least one engram_search / engram_get and re-report, or declare closed:false honestly.";
  }
  if (resourceType === "skills") {
    return "no skill call observed this run — self-declared closure without any skill call is rejected. " +
      "Run at least skill_list (the inventory itself counts at type level) and re-report, " +
      "or declare closed:false honestly.";
  }
  // 防御:不可观测类型不走 mismatch 路径(上方 observable 分支已保证),兜底文案
  return `no ${resourceType} evidence observed this run — declare closed:false honestly or close it with real usage.`;
}

export function checkRequirements(
  requirements: readonly PonderRequirement[] | undefined,
  evidence: EvidenceDigest,
  opts: {
    readonly level: "L1" | "L2";
    readonly evidenceAvailable: boolean;
    /** Phase2:与 requirements 等长的缺口来源标注(计划项不占执行者预算) */
    readonly origins?: ReadonlyArray<"plan" | "executor">;
  },
): RequirementCheckResult {
  const enforce = opts.level === "L2" && opts.evidenceAvailable;
  if (!enforce) {
    // L1 / 无证据面部署:PDCA 降级,清单仅展示,不产生缺口
    return { current: [] };
  }
  if (requirements === undefined) {
    return {
      reject:
        "requirements missing: L2 reports MUST include the requirements list (see protocol REPORT step)",
      current: [],
    };
  }
  if (evidence.engramReadCalls === 0 && evidence.skillCalls === 0) {
    return {
      reject:
        `no resource evidence at all: engine observed 0 engram/skill read calls in this run's ` +
        `signal stream — a full-inventory contemplation must at least mine the memory graph`,
      current: [],
    };
  }
  const declared = new Set(requirements.map((r) => r.resourceType));
  if (evidence.engramReadCalls > 0 && !declared.has("engrams")) {
    return {
      reject:
        `under-declared: signal stream shows ${evidence.engramReadCalls} engram read call(s) ` +
        `but no resourceType="engrams" requirement declared`,
      current: [],
    };
  }
  if (evidence.skillCalls > 0 && !declared.has("skills")) {
    return {
      reject:
        `under-declared: signal stream shows ${evidence.skillCalls} skill call(s) ` +
        `but no resourceType="skills" requirement declared`,
      current: [],
    };
  }

  const current: PonderGap[] = [];
  for (let i = 0; i < requirements.length; i += 1) {
    const r = requirements[i]!;
    const origin = opts.origins?.[i] ?? "executor";
    const observable = OBSERVABLE_TYPES.has(r.resourceType);
    if (r.closed) {
      if (!observable) {
        // logs/web/mcp:引擎无观测面,自报闭合仅展示(unverified)—— 但仍落
        // closed 记录:修复轮中该类缺口从 open 转 closed 靠它推进(不落记录
        // = 历史 open 缺口「未重报」永远保持 open,修复回路死锁)
        current.push({
          hash: gapHash(r.resourceType, r.description),
          resourceType: r.resourceType,
          description: r.description,
          necessity: r.necessity,
          state: "closed",
          reopens: 0,
          origin,
          engineUnverified: true,
        });
        continue;
      }
      const readIds = r.resourceType === "engrams" ? evidence.engramsRead : evidence.skillIds;
      const callCount = r.resourceType === "engrams" ? evidence.engramReadCalls : evidence.skillCalls;
      const claimed = (r.evidence?.ids ?? []).filter((id) => typeof id === "string" && !!id);
      if (claimed.length > 0) {
        const missing = claimed.filter((id) => !readIds.has(id));
        if (missing.length > 0) {
          current.push({
            hash: gapHash(r.resourceType, r.description),
            resourceType: r.resourceType,
            description: r.description,
            necessity: r.necessity,
            state: "open",
            reopens: 0,
            reason: "evidence-mismatch",
            origin,
            detail: mismatchDetail(r.resourceType, missing, readIds, callCount),
          });
          continue;
        }
      } else if (callCount === 0) {
        // 无事实锚点退化为类型级:该类型本轮零调用 → 自报闭合无证据
        current.push({
          hash: gapHash(r.resourceType, r.description),
          resourceType: r.resourceType,
          description: r.description,
          necessity: r.necessity,
          state: "open",
          reopens: 0,
          reason: "evidence-mismatch",
          origin,
          detail: zeroCallDetail(r.resourceType),
        });
        continue;
      }
      // 闭合复核通过
      current.push({
        hash: gapHash(r.resourceType, r.description),
        resourceType: r.resourceType,
        description: r.description,
        necessity: r.necessity,
        state: "closed",
        reopens: 0,
        origin,
      });
      continue;
    }
    // 自报未闭合:logic-needed → 缺口;helpful → 记录(重报可升级)
    current.push({
      hash: gapHash(r.resourceType, r.description),
      resourceType: r.resourceType,
      description: r.description,
      necessity: r.necessity,
      state: "open",
      reopens: 0,
      reason: r.necessity === "logic-needed" ? "unclosed" : undefined,
      origin,
      ...(!observable ? { engineUnverified: true } : {}),
    });
  }
  return { current };
}

/** 缺口合并结果(跨轮视角) */
export interface AdvanceResult {
  /** 合并后的全量缺口(run 生命周期视角) */
  readonly gaps: readonly PonderGap[];
  /** 是否存在阻塞缺口(任何 open;见 blocking 语义注释) */
  readonly blocking: boolean;
  /** 单 run 累计唯一缺口超预算(触顶 → degraded 终束) */
  readonly totalBudgetExhausted: boolean;
  /** 本轮被 deferred 的新增缺口描述(超额;审计/返回给执行者) */
  readonly deferredThisRound: readonly string[];
}

/**
 * 跨轮合并缺口状态(P3 语义反转的核心):
 * - 本轮清单条目按复核结果更新;**历史 open 缺口未在本轮清单出现 = 未处置,
 *   保持 open**(缺口消失 ≠ 闭合;闭合必须显式 closed 且复核通过);
 * - 同哈希重报 → reopens+1;≥ gapReopenEscalation → 强制升级 logic-needed;
 * - 单轮新增唯一缺口 > maxNewGapsPerReport → 超额部分 deferred(不阻塞);
 * - 累计唯一缺口 > maxTotalGapsPerRun → totalBudgetExhausted。
 *
 * blocking 语义(v7「终束只能由预算耗尽触发」):清单里**任何** open 缺口
 * (不分 necessity)都阻塞终束 —— 报进清单 = 承诺闭合,不报 = 放弃;
 * helpful 反复悬置(重报 ≥ 阈值)会被强制升级 logic-needed,把「知道有
 * 资源却一直不做」从可容忍的取舍变成必须解释的缺口。
 */
export function advanceGaps(
  prev: readonly PonderGap[],
  current: readonly PonderGap[],
  limits: {
    readonly maxNewGapsPerReport: number;
    readonly maxTotalGapsPerRun: number;
    readonly gapReopenEscalation: number;
  } = INSIGHT_LIMITS,
): AdvanceResult {
  const byHash = new Map<string, PonderGap>();
  for (const g of prev) byHash.set(g.hash, g);

  // 单轮新增(open 状态的新哈希)超额 → deferred。Phase2:预算只约束
  // executor 来源(计划项是引擎的承诺,不占执行者的反拖延预算)
  const openNow = current.filter((g) => g.state === "open");
  const newHashes = openNow
    .filter((g) => !byHash.has(g.hash) && g.origin !== "plan")
    .map((g) => g.hash);
  const deferredSet = new Set(newHashes.slice(Math.min(limits.maxNewGapsPerReport, newHashes.length)));
  const deferredThisRound: string[] = [];

  for (const g of current) {
    const existing = byHash.get(g.hash);
    if (g.state === "closed") {
      byHash.set(g.hash, {
        ...g,
        state: "closed",
        reopens: existing?.reopens ?? 0,
      });
      continue;
    }
    // open:重报计数 + 升级判定
    const reopens = (existing?.reopens ?? 0) + (existing?.state === "open" ? 1 : 0);
    let necessity = g.necessity;
    if (reopens >= limits.gapReopenEscalation && necessity !== "logic-needed") {
      necessity = "logic-needed"; // P3:连续重报强制升级
    }
    if (deferredSet.has(g.hash)) {
      deferredThisRound.push(g.description);
      byHash.set(g.hash, { ...g, necessity, state: "deferred", reopens, reason: "deferred-over-budget" });
      continue;
    }
    byHash.set(g.hash, { ...g, necessity, state: "open", reopens });
  }
  // 历史 open 未在本轮清单出现 → 保持 open(未处置;reopens 不变)
  const currentHashes = new Set(current.map((g) => g.hash));
  for (const [hash, g] of byHash) {
    if (g.state === "open" && !currentHashes.has(hash)) byHash.set(hash, g);
  }

  const gaps = [...byHash.values()];
  // blocking 排除「engineUnverified + origin=plan」的合成缺口:logs/web/mcp
  // 引擎无观测面,P5 防收窄合成的 open(执行者从未申报)修复轮里只能等到
  // 一句补报表态 —— 现场路径徒增一轮交互,headless 单跑路径必然挂到 TTL。
  // executor 主动申报又悬置的不可观测项仍阻塞(报进清单 = 承诺闭合,
  // incubation-pdca 集成测试固化该语义);展示不受影响(openGapDescs/
  // timeline 仍列出全部 open 缺口)。
  const blocking = gaps.some(
    (g) => g.state === "open" && !(g.engineUnverified && g.origin === "plan"),
  );
  const executorGaps = gaps.filter((g) => g.origin !== "plan");
  const totalBudgetExhausted = executorGaps.length > limits.maxTotalGapsPerRun;
  return { gaps, blocking, totalBudgetExhausted, deferredThisRound };
}

/**
 * 洞察种子源检查(P2 零增量拦截):sourceIds 全部来自任务包种子
 * (用户指定 ∪ 引擎兜底检索)→ 拒绝该洞察。种子是起点提示不是边界,
 * 全引种子 = 没有为问题开采任何新证据。
 */
export function isSeedOnlySources(
  sourceIds: readonly string[],
  seedIds: ReadonlySet<string>,
): boolean {
  if (sourceIds.length === 0) return false; // 空由 validate 的 no sourceIds 拒
  return sourceIds.every((id) => seedIds.has(id));
}

// ============================================================
// Phase2:计划先行 —— 计划 → 有效需求集的合并(P5 防收窄 + P1 自动豁免)
// ============================================================

/** 计划应用结果(喂给 checkRequirements 的有效需求集) */
export interface PlanApplication {
  /** 有效需求 = 计划项(覆盖/合成/豁免)∪ 执行者追加项 */
  readonly effective: readonly PonderRequirement[];
  /** origin 标注(与 effective 等长:plan / executor) */
  readonly origins: ReadonlyArray<"plan" | "executor">;
  /** P1 自动豁免的计划项描述(全部探测变体执行且皆空,引擎亲证) */
  readonly exempted: readonly string[];
  /**
   * P5 收窄拦截明细:被删除的计划项(report 缺失)与被降级的计划项
   * (logic-needed → helpful,引擎已覆写回)—— 展示与审计
   */
  readonly narrowed: readonly string[];
}

/**
 * 把计划应用到 report 需求清单上(Phase2 核心,纯函数):
 *
 * P5 防收窄 ——
 * - 计划项在 report 中缺失(被删除)→ 合成 open 项(unclosed),删除即缺口;
 * - report 项把计划项 necessity 降级 → 以计划为准覆写回(降级无效);
 * - 执行者追加项(无 planItemId)原样保留(受缺口预算约束)。
 *
 * P1 自动豁免(豁免权在引擎侧)——
 * - 可观测(engrams)计划项的全部探测变体(≥2)都在流水里**逐字执行**
 *   且全部空结果(hits=0 引擎亲证)→ 自动置 closed(exempt),无论执行者
 *   是否申报 —— 「资源确实不存在」由引擎自己的空结果证明,不依赖自报。
 */
export function applyPlanToRequirements(
  plan: ReadonlyArray<PonderPlanItem>,
  requirements: readonly PonderRequirement[] | undefined,
  evidence: EvidenceDigest,
): PlanApplication {
  const effective: PonderRequirement[] = [];
  const origins: Array<"plan" | "executor"> = [];
  const exempted: string[] = [];
  const narrowed: string[] = [];
  const claimedByPlanId = new Map<string, PonderRequirement>();
  for (const r of requirements ?? []) {
    if (r.planItemId) claimedByPlanId.set(r.planItemId, r);
  }

  for (const pi of plan) {
    // P1:engrams 项探测全部逐字执行且全部空 → 自动豁免(引擎亲证)
    if (
      pi.resourceType === "engrams" &&
      pi.probes.length >= 2 &&
      pi.probes.every((p) => probeRanEmpty(p.query, evidence))
    ) {
      effective.push({
        resourceType: pi.resourceType,
        description: pi.description,
        necessity: pi.necessity,
        closed: true,
        planItemId: pi.id,
      });
      origins.push("plan");
      exempted.push(pi.description);
      continue;
    }
    const claimed = claimedByPlanId.get(pi.id);
    if (!claimed) {
      // P5:计划项被删除 → 合成 open(描述以计划为准;缺口即收窄证据)
      narrowed.push(pi.description);
      effective.push({
        resourceType: pi.resourceType,
        description: pi.description,
        necessity: pi.necessity,
        closed: false,
        planItemId: pi.id,
      });
      origins.push("plan");
      continue;
    }
    // P5:降级覆写(计划 logic-needed 不因 report 报 helpful 而降级)
    if (pi.necessity === "logic-needed" && claimed.necessity !== "logic-needed") {
      narrowed.push(pi.description);
    }
    effective.push({
      ...claimed,
      description: pi.description, // 描述以计划为准(漂移即换需求,同属收窄面)
      necessity: pi.necessity === "logic-needed" ? "logic-needed" : claimed.necessity,
      planItemId: pi.id,
    });
    origins.push("plan");
  }
  for (const r of requirements ?? []) {
    if (r.planItemId) continue; // 已并入计划项
    effective.push(r);
    origins.push("executor");
  }
  return { effective, origins, exempted, narrowed };
}

/** 探测词逐字执行且空结果(精确匹配 input.query;hits=0 从 outputSummary 解析) */
function probeRanEmpty(query: string, evidence: EvidenceDigest): boolean {
  const q = query.trim();
  return evidence.searches.some((s) => s.query === q && s.hits === 0);
}
