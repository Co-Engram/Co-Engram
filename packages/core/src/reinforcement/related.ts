/**
 * Hebbian 关联强化
 *
 * 神经科学依据："一起激活的神经元连接增强"（Hebb, 1949）。
 * 业务含义：engram A 被有效强化时，与 A 相连的邻居 engram 也得到部分增益。
 *
 * 策略：
 *   - 沿 outgoing/incoming synapse 找邻居
 *   - 每个邻居得到 importanceDelta × hebbianRatio（默认 0.5）
 *   - 排除 contradicts（矛盾邻居不强化）
 *   - 跳过 archived/forgotten（生命周期已结束的不强化）
 *
 * 与 ltp.ts 的关系：
 *   - ltp.recordRetrievalSuccess：直接强化单个 engram
 *   - related.reinforceRelated：触发 ltp 后，对邻居做 reinforceEngram
 *
 * P0-9 修复:此前邻居联动是"幽灵强化" —— 邻居 importance 被改但
 *   (a) effectiveRetrievals/retrievalCount/reinforcementScore 全为 0
 *   (b) audit_log 无任何 reinforce 记录(查 action:reinforce, engramId:B 永远空)
 *   (c) 也不知道是哪个 engram 触发的联动
 * 现在通过 options.auditLog + options.triggeredBy 让联动可观察:
 *   - reinforceEngram 传 withStats:true 让统计字段同步更新
 *   - auditLog.append({action:"reinforce", engramId:邻居, metadata:{triggeredBy, sourceImportanceDelta, ...}})
 *
 * @module @co-engram/core/reinforcement
 */

import type { EngramRepository } from "../storage/repository.js";
import type { SynapseKind } from "../types/synapse.js";
import type { AuditLog } from "../observability/audit-log.js";
import { DEFAULT_CONFIG, type ReinforcementConfig } from "./config.js";
import { reinforceEngram } from "./ltp.js"; // 无循环依赖：ltp.ts 不 import related.ts

/** 不应该被强化的 synapse 类型（矛盾关系） */
const NEGATIVE_KINDS: ReadonlySet<SynapseKind> = new Set<SynapseKind>([
  "contradicts",
]);

export interface ReinforceRelatedResult {
  /** 被强化的邻居 id 列表 */
  readonly reinforcedNeighborIds: readonly string[];
  /** 跳过的邻居数（contradicts / archived / 不存在） */
  readonly skipped: number;
  /** 给每个邻居的 importanceDelta */
  readonly importanceDeltaPerNeighbor: number;
}

/** reinforceRelated 的可选参数 */
export interface ReinforceRelatedOptions {
  /**
   * 触发此次联动的源 engram id(等于 reinforceRelated 的 engramId 参数)。
   * 用于 audit metadata,让邻居能追溯"我为什么被强化"。
   */
  readonly triggeredBy?: string;
  /**
   * 触发此次联动的工具/路径(如 "reinforce" / "close_learning_loop")。
   * 用于 audit metadata,便于过滤不同来源的联动。
   */
  readonly triggerTool?: string;
  /**
   * 若提供,对每个被强化的邻居写一条 reinforce audit(解决 P0-9 幽灵强化)。
   */
  readonly auditLog?: AuditLog;
  /** 宿主标识(透传到 audit entry) */
  readonly host?: "claude-code-mcp" | "openclaw-plugin" | string;
}

/**
 * 对邻居执行 Hebbian 强化
 *
 * @param repo - 仓库
 * @param engramId - 触发强化的 engram id
 * @param baseImportanceDelta - 原始 engram 得到的 importanceDelta
 * @param config - 配置（可选）
 * @param nowIso - 当前时间
 * @param options - P0-9 修复:可选 auditLog + triggeredBy,让联动可观察
 */
export function reinforceRelated(
  repo: EngramRepository,
  engramId: string,
  baseImportanceDelta: number,
  config: ReinforcementConfig = DEFAULT_CONFIG,
  nowIso: string = new Date().toISOString(),
  options: ReinforceRelatedOptions = {},
): ReinforceRelatedResult {
  if (!repo.exists(engramId)) {
    throw new Error(`Engram not found: ${engramId}`);
  }
  if (baseImportanceDelta < 0) {
    // LTD 不应触发 Hebbian 强化（避免反向放大失败）
    return {
      reinforcedNeighborIds: [],
      skipped: 0,
      importanceDeltaPerNeighbor: 0,
    };
  }
  const neighborDelta = baseImportanceDelta * config.hebbianRatio;
  if (neighborDelta <= 0) {
    return {
      reinforcedNeighborIds: [],
      skipped: 0,
      importanceDeltaPerNeighbor: 0,
    };
  }

  // 收集 outgoing + incoming 邻居
  const all = repo.collectAllSynapses();
  const neighborIds = new Set<string>();
  /** 记录每个邻居关联的 synapse id,用于 audit metadata 追溯 */
  const neighborSynapseMap = new Map<string, string>();
  let skipped = 0;

  for (const { fromId, synapse } of all) {
    if (NEGATIVE_KINDS.has(synapse.kind)) {
      skipped += 1;
      continue;
    }
    if (fromId === engramId) {
      // 我是 from，邻居是 to
      neighborIds.add(synapse.to);
      neighborSynapseMap.set(synapse.to, synapse.id);
    } else if (synapse.to === engramId) {
      // 我是 to，邻居是 from
      neighborIds.add(fromId);
      neighborSynapseMap.set(fromId, synapse.id);
    }
  }

  const reinforced: string[] = [];
  // 批量读取邻居 status(替代 N+1 readEngram,消除 synapse/ 目录扫描)。
  // readDigestBatch 对不存在的 id 静默跳过 → 等价于旧的 exists 检查。
  // 只需 status 字段做 archived/forgotten 过滤,完整 DigestLine 是超集够用。
  const neighborIdList = [...neighborIds];
  const neighborLines = repo.readDigestBatch(neighborIdList);
  const neighborStatusById = new Map<string, string>();
  for (const line of neighborLines) {
    neighborStatusById.set(line.id, line.status);
  }
  for (const neighborId of neighborIdList) {
    const status = neighborStatusById.get(neighborId);
    if (!status) {
      // readDigestBatch 没返回 → 邻居不存在(等价旧 exists 检查)
      skipped += 1;
      continue;
    }
    if (status === "archived" || status === "forgotten") {
      skipped += 1;
      continue;
    }
    // P0-9 修复:邻居联动也更新统计字段,让 effectiveRetrievals/retrievalCount/
    // reinforcementScore 可观察。语义上邻居被"间接有效检索"。
    // D1:neighborDelta 已经是源 engram 经 dynamics 算出的 importanceDelta × hebbianRatio,
    // 直接当作 importance 增量累加(asImportanceDelta: true),避免再次经 dynamics 缩放。
    reinforceEngram(repo, neighborId, neighborDelta, nowIso, {
      withStats: true,
      effectiveness: neighborDelta,
      asImportanceDelta: true,
    });
    reinforced.push(neighborId);

    // P0-9 修复:写邻居 audit,让联动可追溯
    if (options.auditLog) {
      options.auditLog.append({
        actor: "system",
        action: "reinforce",
        engramId: neighborId,
        host: options.host,
        metadata: {
          triggeredBy: options.triggeredBy ?? engramId,
          triggerTool: options.triggerTool,
          sourceEngramId: engramId,
          synapseId: neighborSynapseMap.get(neighborId),
          importanceDelta: neighborDelta,
          effectiveness: neighborDelta,
          hebbian: true,
        },
      });
    }
  }

  return {
    reinforcedNeighborIds: reinforced,
    skipped,
    importanceDeltaPerNeighbor: neighborDelta,
  };
}
