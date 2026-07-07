/**
 * 派生索引 dangling reference 自愈(post-doctor cleanup)。
 *
 * 触发场景:
 *   - 用户外部删除 .md 文件(git rm / rm / IDE 删除)
 *   - runDoctor 清理 engram-index.json(去除 missing_file entry)
 *   - **但**派生索引(observation-windows.jsonl / digest.jsonl / graph.json)
 *     仍保留被删 engram 的 id → engram_search 返回 stale 结果 / viewer 显示重影
 *
 * 本模块在 runDoctor 完成后运行,基于 canonicalIds 清除这些悬空引用。
 *
 * 设计:
 *   - 纯函数,失败不抛(返回空 issues),让上层 doctor 主流程继续
 *   - 幂等(过滤逻辑重复运行结果一致)
 *   - 廉价:observation-windows 直接过滤;digest/graph 检测到悬空才 fullRebuild
 *
 * 检查范围:
 *   1. observation-windows.jsonl  — filter in-place by engramId
 *   2. digest.jsonl + graph.json  — 检测到悬空则触发 IndexOrchestrator.fullRebuild
 *
 * 不检查(无 engram id 引用):
 *   - topic-clusters.jsonl — 引用 cluster.id(短 hash),与 engram 无关
 *   - proposals.jsonl      — entityId = cluster.id 或外部 .md path,非 engram id
 *   - prompt-signals.json  — 字段是 tag 字符串
 *   - audit.jsonl          — 历史日志,按 audit.rotation 策略独立清理
 *                            (AuditLog.startAutoRotation,与 doctor 解耦)
 *
 * @module @co-engram/core/storage
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { IndexOrchestrator, defaultCachePath } from "../index/orchestrator.js";
import type { EngramRepository } from "./repository.js";
import type { DoctorIssue } from "../types/repository-types.js";

export interface IndexCleanupResult {
  readonly fixes: readonly DoctorIssue[];
}

/**
 * 清除派生索引中对已不存在 engram 的引用。
 *
 * 在 runDoctor 完成后调用 —— 此时 engram-index.json 已被刷新,
 * canonicalIds 应来自 readEngramIndex(dataRoot).entries 或等价途径。
 */
export function cleanupDanglingIndexReferences(params: {
  readonly repo: EngramRepository;
  readonly dataRoot: string;
  readonly canonicalIds: ReadonlySet<string>;
}): IndexCleanupResult {
  const { repo, dataRoot, canonicalIds } = params;
  const fixes: DoctorIssue[] = [];
  const cachePath = defaultCachePath(dataRoot);

  const windowsFix = cleanupObservationWindows(cachePath, canonicalIds);
  if (windowsFix) fixes.push(windowsFix);

  const digestGraphFix = rebuildDigestGraphIfStale(
    repo,
    cachePath,
    canonicalIds,
  );
  if (digestGraphFix) fixes.push(digestGraphFix);

  return { fixes };
}

/**
 * 过滤 observation-windows.jsonl,删除 engramId 不在 canonicalIds 中的行。
 *
 * 文件格式:JSONL,每行 { id, engramId, query, score, hitAt, deadline, kind, status }。
 * 直接 in-place 重写(append-mostly 日志,过滤是正确语义)。
 */
function cleanupObservationWindows(
  cachePath: string,
  canonicalIds: ReadonlySet<string>,
): DoctorIssue | null {
  const filePath = join(cachePath, "observation-windows.jsonl");
  if (!existsSync(filePath)) return null;

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  const lines = raw.split("\n");
  let removed = 0;
  const kept: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let isDangling = false;
    try {
      const parsed = JSON.parse(trimmed) as { engramId?: unknown };
      if (
        typeof parsed.engramId === "string" &&
        !canonicalIds.has(parsed.engramId)
      ) {
        isDangling = true;
      }
    } catch {
      // 保留无法解析的行(让 audit / 人工检查)
    }
    if (isDangling) {
      removed++;
      continue;
    }
    kept.push(trimmed);
  }

  if (removed === 0) return null;

  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      kept.length > 0 ? kept.join("\n") + "\n" : "",
      "utf8",
    );
  } catch {
    return null;
  }

  return {
    kind: "dangling_index_reference",
    path: filePath,
    message: `Removed ${removed} dangling observation window(s) whose engramId no longer exists`,
    autoFixed: true,
  };
}

/**
 * 检测 digest.jsonl 与 graph.json 中的 dangling engram id。
 *
 * 若发现任何悬空,触发 IndexOrchestrator.fullRebuild
 * (fullRebuild 一次性重建 digest + graph,保证二者一致)。
 *
 * 检测代价:O(digest 行数 + graph 节点数 + graph 边数)。
 * 重建代价:仅在检测到悬空时才发生,常见路径(doctored 之后的稳态)开销为 0。
 */
function rebuildDigestGraphIfStale(
  repo: EngramRepository,
  cachePath: string,
  canonicalIds: ReadonlySet<string>,
): DoctorIssue | null {
  const digestPath = join(cachePath, "digest.jsonl");
  const graphPath = join(cachePath, "graph.json");

  let digestDangling = 0;
  let graphDangling = 0;

  if (existsSync(digestPath)) {
    try {
      const raw = readFileSync(digestPath, "utf8");
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as { id?: unknown };
          if (typeof parsed.id === "string" && !canonicalIds.has(parsed.id)) {
            digestDangling++;
          }
        } catch {
          // 跳过无效行(不是 dangling,只是损坏 — 让别处报)
        }
      }
    } catch {
      // 读失败:当作无 dangling,跳过
    }
  }

  if (existsSync(graphPath)) {
    try {
      const raw = readFileSync(graphPath, "utf8");
      const parsed = JSON.parse(raw) as {
        nodes?: ReadonlyArray<{ id?: unknown }>;
        edges?: ReadonlyArray<{ from?: unknown; to?: unknown }>;
      };
      for (const node of parsed.nodes ?? []) {
        if (typeof node.id === "string" && !canonicalIds.has(node.id)) {
          graphDangling++;
        }
      }
      for (const edge of parsed.edges ?? []) {
        if (typeof edge.from === "string" && !canonicalIds.has(edge.from)) {
          graphDangling++;
        }
        if (typeof edge.to === "string" && !canonicalIds.has(edge.to)) {
          graphDangling++;
        }
      }
    } catch {
      // 读失败:当作无 dangling,跳过
    }
  }

  if (digestDangling === 0 && graphDangling === 0) return null;

  try {
    const orchestrator = new IndexOrchestrator(repo, cachePath);
    const result = orchestrator.fullRebuild();
    return {
      kind: "dangling_index_reference",
      path: cachePath,
      message: `Rebuilt stale derived indexes (digest had ${digestDangling} dangling entr${digestDangling === 1 ? "y" : "ies"}, graph had ${graphDangling} dangling ref${graphDangling === 1 ? "" : "s"}; rebuild produced digest=${result.digest.total}, graph nodes=${result.graph.nodes}, edges=${result.graph.edges})`,
      autoFixed: true,
    };
  } catch {
    return {
      kind: "dangling_index_reference",
      path: cachePath,
      message: `Detected ${digestDangling} dangling digest entry/${graphDangling} dangling graph ref but fullRebuild failed (check logs)`,
      autoFixed: false,
    };
  }
}
