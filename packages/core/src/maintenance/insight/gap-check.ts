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
import type { PonderGap, PonderRequirement, PonderResourceType } from "./types.js";
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
}

/** 汇总证据(纯函数;events 需已按 run 时间窗过滤) */
export function digestEvidence(events: readonly ToolCallEvent[]): EvidenceDigest {
  const engramsRead = new Set<string>();
  const skillIds = new Set<string>();
  let engramReadCalls = 0;
  let skillCalls = 0;
  for (const e of events) {
    if (ENGRAM_READ_TOOLS.has(e.toolName)) {
      engramReadCalls += 1;
      if (e.toolName === "engram_get") {
        const id = e.input?.id;
        if (typeof id === "string" && id) engramsRead.add(id);
      }
      for (const id of e.retrievedEngramIds ?? []) engramsRead.add(id);
    } else if (SKILL_TOOLS.has(e.toolName)) {
      skillCalls += 1;
      const id = e.input?.id;
      if (typeof id === "string" && id) skillIds.add(id);
    }
  }
  return { engramsRead, engramReadCalls, skillIds, skillCalls };
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
export function checkRequirements(
  requirements: readonly PonderRequirement[] | undefined,
  evidence: EvidenceDigest,
  opts: { readonly level: "L1" | "L2"; readonly evidenceAvailable: boolean },
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
  for (const r of requirements) {
    const observable = OBSERVABLE_TYPES.has(r.resourceType);
    if (r.closed) {
      if (!observable) {
        // logs/web/mcp:引擎无观测面,自报闭合仅展示(unverified)
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
      });
      continue;
    }
    // 自报未闭合:logic-needed → 缺口;helpful → 记录(不阻塞,重报可升级)
    current.push({
      hash: gapHash(r.resourceType, r.description),
      resourceType: r.resourceType,
      description: r.description,
      necessity: r.necessity,
      state: "open",
      reopens: 0,
      reason: r.necessity === "logic-needed" ? "unclosed" : undefined,
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

  // 单轮新增(open 状态的新哈希)超额 → deferred
  const openNow = current.filter((g) => g.state === "open");
  const newHashes = openNow.filter((g) => !byHash.has(g.hash)).map((g) => g.hash);
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
  const blocking = gaps.some((g) => g.state === "open");
  const totalBudgetExhausted = gaps.length > limits.maxTotalGapsPerRun;
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
