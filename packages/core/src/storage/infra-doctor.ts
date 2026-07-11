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
 * 2026-07 二次升级(index-no-truth 修复):count match 但内容 drift
 * (createdBy / weight / kind 等字段级变化)检测不到。改为 **总是重建**:
 * 只要 doctor 被触发,就重建 graph.json + SQLite synapse 表。
 * cost 可接受(graph 重建 ~60ms / 1000 synapse,doctor 不频繁)。
 *
 * 设计:
 *   - 纯函数,不持有状态;接受 repo + dataRoot
 *   - 失败不抛错(返回空 fixes),让上层 doctor 主流程继续
 *   - 幂等(连跑两次,第二次产生相同 graph.json + SQLite 行)
 *
 * @module @co-engram/core/storage
 */

import { existsSync } from "node:fs";
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
 *      - digest.jsonl 缺失 → 全量重建
 *      - graph.json 缺失或存在 → 总是重建(覆盖字段级 drift,详见上文注释)
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

  // 1. 派生索引:digest 缺失或 graph 任意状态 → 全量重建。
  //   - digest 缺失:增量逻辑无法启动,必须 fullRebuild
  //   - graph 缺失:必须 rebuild
  //   - graph 存在:总是 rebuild 覆盖字段级 drift(index-no-truth 修复)
  // 性能:fullRebuild 含 digest + graph + SQLite synapse 三层,~200ms/1000 engram。
  const digestPath = join(cachePath, "digest.jsonl");
  const graphPath = join(cachePath, "graph.json");
  const digestMissing = !existsSync(digestPath);
  const graphMissing = !existsSync(graphPath);
  // graph.json 存在时也总是重建(覆盖 count 一致但字段 drift 的场景)
  const graphNeedsRebuild = true;
  if (digestMissing || graphMissing || graphNeedsRebuild) {
    try {
      const orchestrator = new IndexOrchestrator(repo, cachePath);
      const result = orchestrator.fullRebuild();
      const parts: string[] = [];
      if (digestMissing) {
        parts.push(`digest.jsonl (${result.digest.total} entries)`);
      }
      if (graphMissing) {
        parts.push(`graph.json (${result.graph.nodes} nodes, ${result.graph.edges} edges)`);
      } else {
        parts.push(
          `graph.json resynced (${result.graph.nodes} nodes / ${result.graph.edges} edges, index-no-truth 防护)`,
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
