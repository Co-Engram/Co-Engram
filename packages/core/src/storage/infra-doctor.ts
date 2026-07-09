/**
 * 基础设施自愈:补齐 `computeStatus` 检测到、但 `EngramRepository.runDoctor` 不覆盖的层。
 *
 * `runDoctor` 只扫 engram 文件层(moved / title / missing / orphan / dangling)。
 * 但 status 还会检测:
 *   - digest.jsonl / graph.json 缺失(派生索引文件,IndexOrchestrator 的职责)
 *   - merge driver 未配置(git 层,onboard 的职责)
 *
 * 这两层问题让用户「点 doctor 按钮也修不了」,因为 doctor 跑完是空报告。
 * 本模块在 doctor 执行前做 preflight,把这些基础设施问题自动修复,
 * 让「网页 health tab → 运行 doctor 扫描」真正成为一键自愈入口。
 *
 * 2026-07 升级:除文件缺失外,额外检测 graph.json 内容陈旧(stale):
 *   - 读 graph.json 的 edges 数,与磁盘 collectAllSynapses 扫盘数比较
 *   - 不一致 → 触发 IndexOrchestrator.fullRebuild
 *   - 一致 → 保持幂等,不重建
 * 解决长期运行后 graph.json 反映历史峰值、SQLite synapse 表 = 0 行、
 * 磁盘只剩 15 个 synapse 文件 这类三源脱钩。
 *
 * 设计:
 *   - 纯函数,不持有状态;接受 repo + dataRoot
 *   - 失败不抛错(返回空 fixes),让上层 doctor 主流程继续
 *   - 幂等(无问题时连跑两次,第二次不重建)
 *
 * @module @co-engram/core/storage
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveMergeDriverBundle } from "../merge/auto-onboard.js";

import type { EngramRepository } from "./repository.js";
import { IndexOrchestrator, defaultCachePath } from "../index/orchestrator.js";
import { autoOnboardMergeDriver } from "../merge/auto-onboard.js";
import type { DoctorIssue } from "../types/repository-types.js";

export interface InfraDoctorResult {
  /** 基础设施层的修复列表(已自动应用),插入到 DoctorReport.fixes 头部。 */
  readonly fixes: readonly DoctorIssue[];
}

/**
 * 在 runDoctor 之前运行的基础设施自愈。
 *
 * 检查范围:
 *   1. 派生索引(digest.jsonl / graph.json / SQLite synapse 表):
 *      - 文件缺失 → 全量重建
 *      - 文件存在但 graph.json edges 数 ≠ 磁盘 synapse 数(stale)→ 全量重建
 *      - 文件存在且一致 → 保持幂等,不重建
 *   2. merge driver 未配置(且 dataRoot 在 git repo 内)→ autoOnboardMergeDriver
 *
 * 不检查(留给 runDoctor 或人工):
 *   - engram-index.json(已由 EngramRepository.getIndex 惰性重建)
 *   - git dirty(不能 auto-commit 用户工作)
 *   - config 字段缺失(需用户决策)
 */
export function runInfraDoctor(params: {
  repo: EngramRepository;
  dataRoot: string;
}): InfraDoctorResult {
  const { repo, dataRoot } = params;
  const fixes: DoctorIssue[] = [];
  const cachePath = defaultCachePath(dataRoot);

  // 1. 派生索引:文件缺失或 stale graph → 全量重建。
  const digestPath = join(cachePath, "digest.jsonl");
  const graphPath = join(cachePath, "graph.json");
  const digestMissing = !existsSync(digestPath);
  const graphMissing = !existsSync(graphPath);
  const staleGraph = !graphMissing && isGraphStale(repo, graphPath);
  if (digestMissing || graphMissing || staleGraph) {
    try {
      const orchestrator = new IndexOrchestrator(repo, cachePath);
      const result = orchestrator.fullRebuild();
      const parts: string[] = [];
      if (digestMissing) {
        parts.push(`digest.jsonl (${result.digest.total} entries)`);
      }
      if (graphMissing) {
        parts.push(`graph.json (${result.graph.nodes} nodes, ${result.graph.edges} edges)`);
      }
      if (staleGraph) {
        parts.push(
          `stale graph.json rebuilt (${result.graph.nodes} nodes / ${result.graph.edges} edges)`,
        );
      }
      if (result.synapses) {
        parts.push(
          `SQLite synapse table synced ${result.synapses.inserted} rows (skipped ${result.synapses.skippedDangling} dangling)`,
        );
      }
      fixes.push({
        kind: "index_rebuilt",
        path: cachePath,
        message: `Rebuilt derived indexes: ${parts.join(", ")}`,
        autoFixed: true,
      });
    } catch {
      // 失败不阻塞 — 让上层 doctor 继续扫 engram 文件层,问题留给用户
    }
  }

  // 2. merge driver 未配置 + 在 git repo → autoOnboardMergeDriver
  //    本文件在 dist/storage/infra-doctor.js,bundle 在上一级 dist/merge-driver.cjs
  const storageDir = dirname(fileURLToPath(import.meta.url));
  const coreDistDir = dirname(storageDir);
  const bundleSourcePath = resolveMergeDriverBundle(coreDistDir);
  if (bundleSourcePath) {
    const onboard = autoOnboardMergeDriver({ dataRoot, bundleSourcePath });
    if (onboard.attempted && !onboard.error) {
      // bundleUpgraded=true 表示版本不同(可能是首次安装或升级)
      // gitattributesUpdated=true 表示 .gitattributes 新加了条目
      // 二者任一为 true 才算"实际修复",避免每次 doctor 都报告
      if (onboard.bundleUpgraded || onboard.gitattributesUpdated) {
        fixes.push({
          kind: "merge_driver_installed",
          path: onboard.repoRoot,
          message: `Merge driver configured (bundle installed=${onboard.bundleUpgraded}, gitattributes updated=${onboard.gitattributesUpdated})`,
          autoFixed: true,
        });
      }
    }
  }

  return { fixes };
}

/**
 * 检测 graph.json 是否与磁盘 synapse 真相脱钩。
 *
 * 判定:graph.json 中 edges 数 ≠ collectAllSynapses 扫盘数 → stale。
 * 长期运行后,DELETE/cascade 路径边界可能让 graph.json 反映历史峰值
 * (例:edges=1827),而磁盘实际只剩少数 synapse 文件(例:15)。
 * 读 graph.json 的 cost 是一次 JSON.parse(~50ms),collectAllSynapses 走
 * 进程内 cache(扫盘只发生一次),整体廉价。
 */
function isGraphStale(repo: EngramRepository, graphPath: string): boolean {
  try {
    const raw = readFileSync(graphPath, "utf8");
    const graph = JSON.parse(raw) as { edges?: unknown[] };
    const graphEdgeCount = Array.isArray(graph.edges) ? graph.edges.length : 0;
    const diskSynapseCount = repo.collectAllSynapses().length;
    return graphEdgeCount !== diskSynapseCount;
  } catch {
    // graph.json 损坏或不可读 → 视为 stale,让上层触发重建
    return true;
  }
}
