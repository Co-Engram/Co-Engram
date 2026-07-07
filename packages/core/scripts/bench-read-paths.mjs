// packages/core/scripts/bench-read-paths.mjs
//
// 验证 schema v4 + readDigestBatch / readContentBatch / queryEngramsBySortKey
// 等批量 API 的延迟收益。
//
// 跑法:node packages/core/scripts/bench-read-paths.mjs
//
// 注意:首次跑会触发 SCHEMA_VERSION 3→4 migration(DROP+rebuild),耗时 ~10s。
// 第二次跑才是真实测量值。

import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";
import { bootstrapRepositoryAndSearch } from "../dist/storage/bootstrap.js";
import { EffectivenessTracker } from "../dist/observability/effectiveness-tracker.js";
import { AuditLog } from "../dist/observability/audit-log.js";
import { TokenJaccardSimilarityEngine } from "../dist/dedup/similar.js";
import { loadView } from "../dist/disclosure/tier-loader.js";
import { reinforceRelated } from "../dist/reinforcement/related.js";

const require = createRequire(import.meta.url);

const DATA_ROOT = "/home/10192021@zte.intra/AIOS/team-memory/team-memory";

function fmtMs(ms) {
  return ms < 1000 ? `${ms.toFixed(1)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

function bench(label, fn, runs = 3) {
  // 预热 1 次(让 SQLite 缓存就位),再正式跑 runs 次取中位数
  fn();
  const samples = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  console.log(`  ${label.padEnd(60)} ${fmtMs(median).padStart(10)}`);
  return median;
}

async function main() {
  console.log(`[bench] dataRoot: ${DATA_ROOT}`);
  console.log(`[bench] bootstrapping (will trigger schema v4 migration if needed)...`);
  const t0 = performance.now();
  const { repository, searchEngine, engineType, indexDb } = bootstrapRepositoryAndSearch({
    dataRoot: DATA_ROOT,
    language: "zh",
    env: process.env,
  });
  console.log(`[bench] bootstrap done in ${fmtMs(performance.now() - t0)} (engine: ${engineType})`);

  if (engineType !== "sqlite") {
    console.warn("[bench] ⚠️ engine is memory, not sqlite — benchmark results not representative");
  }

  const auditLog = new AuditLog(DATA_ROOT);
  await auditLog.init?.();
  const tracker = new EffectivenessTracker(DATA_ROOT, auditLog);

  // 收集 ids 用于后续 batch 测试
  const allIds = repository.listEngrams().map((e) => e.id);
  console.log(`[bench] total engrams: ${allIds.length}`);
  const sampleIds = allIds.slice(0, 20);
  const sampleFilterIds = allIds.slice(0, 100);

  console.log("\n[bench] === 关键路径延迟(中位数,3 次正式跑)===");

  // 1. engram_list 主路径(SQL filter + SortKey cursor)
  bench("engram_list (limit=50, default filter)", () => {
    repository.queryEngramsForMcpList({ limit: 50 });
  });

  // 2. engram_list 带 cursor(模拟翻第二页)
  const firstPage = repository.queryEngramsForMcpList({ limit: 50 });
  if (firstPage.nextCursor) {
    bench("engram_list (limit=50, with cursor)", () => {
      repository.queryEngramsForMcpList({ limit: 50, cursor: firstPage.nextCursor });
    });
  }

  // 3. engram_list 带 domainTags filter
  bench("engram_list (filter: domainTags=['co-engram'])", () => {
    repository.queryEngramsForMcpList({
      limit: 50,
      filter: { domainTags: ["co-engram"] },
    });
  });

  // 4. readDigestBatch 20 ids
  bench("readDigestBatch (20 ids)", () => {
    repository.readDigestBatch(sampleIds);
  });

  // 5. readDigestBatch 100 ids
  bench("readDigestBatch (100 ids)", () => {
    repository.readDigestBatch(sampleFilterIds);
  });

  // 6. readContentBatch 100 ids (dedup 用)
  bench("readContentBatch (100 ids)", () => {
    repository.readContentBatch(sampleFilterIds);
  });

  // 7. listDigestByVerificationStatus(maintenance 用)
  bench("listDigestByVerificationStatus (4 statuses + active)", () => {
    repository.listDigestByVerificationStatus(
      ["unverified", "plausible", "probable", "verified"],
      { lifecycleStatuses: ["active"] },
    );
  });

  // 8. findCandidatesSync(dedup 主路径)
  //    原 N+1 在 1026 engram 规模下 ~18s;v4 + readContentBatch 期望 < 500ms
  const dedupEngine = new TokenJaccardSimilarityEngine(repository);
  bench("findCandidatesSync full scan (1026 engrams)", () => {
    dedupEngine.findCandidatesSync(
      "co-engram SQLite schema migration N+1 性能优化",
      { topK: 10, minSimilarity: 0.05 },
    );
  }, 3);

  // 9. 全文检索(对照组,不是本次优化重点,但作为 baseline)
  bench("engram_search (FTS5, baseline)", () => {
    searchEngine.search("co-engram 性能优化", undefined, 20);
  });

  // === P3 synapse cache 验证 ===
  // collectAllSynapses 的 6 个 caller 在 1026 engram 规模下,
  // 每次调用都扫 synapses/ 目录(~1826 文件)。Phase 3 cache 后,
  // 只有第一次扫盘,后续命中 cache。
  console.log("\n[bench] === P3 synapse cache 路径 ===");

  // 10. collectAllSynapses 首次(扫盘)
  bench("collectAllSynapses 首次(扫盘)", () => {
    // 模拟"cache 失效后第一次调用",通过 createSynapse 之类触发 invalidate
    // 这里直接清 cache 再测
    repository.invalidateSynapseCache();
    repository.collectAllSynapses();
  }, 1);

  // 11. collectAllSynapses 命中(后续读)
  // 先填 cache
  repository.collectAllSynapses();
  bench("collectAllSynapses 命中(cache)", () => {
    repository.collectAllSynapses();
  });

  // 12. engram_get → tier-loader.collectIncoming → collectAllSynapses
  // 选一个有 incoming synapse 的 id;loadView 内部走 collectIncoming
  const firstEngramId = allIds[0];
  if (firstEngramId) {
    bench("engram_get (loadView, cache 命中)", () => {
      loadView(repository, firstEngramId, { tier: "content" });
    });
  }

  // 13. reinforceRelated → collectAllSynapses
  if (firstEngramId) {
    bench("reinforceRelated (collectAllSynapses × 1)", () => {
      reinforceRelated(repository, firstEngramId, 0.8);
    });
  }

  // 14. readSynapses → 原 listSynapsesForEngram 模块函数(绕过 cache)
  //     20 个 caller(loadView/contradiction/evolution/generative/lineage/perspectives)
  if (firstEngramId) {
    bench("readSynapses (cache 命中,20 caller 共享)", () => {
      repository.readSynapses(firstEngramId);
    });
  }

  // 15. loadView tier=synapses(完整 engram_get tier=synapses 路径)
  if (firstEngramId) {
    bench("engram_get tier=synapses (loadView, cache 命中)", () => {
      loadView(repository, firstEngramId, { tier: "synapses" });
    });
  }

  console.log("\n[bench] done.");
}

main().catch((err) => {
  console.error("[bench] failed:", err);
  process.exit(1);
});
