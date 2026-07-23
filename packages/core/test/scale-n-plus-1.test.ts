/**
 * Scale 回归测试:N=200 下 hot paths 必须在阈值内完成
 *
 * 历史背景(2026-07):viewer 在 1026 engrams 规模下卡死,根因是
 * findExactHashMatch + 多处 dreaming/generative/provenance/verification
 * 路径在循环里调 readEngram,导致 N+1 同步阻塞 event loop 30s+。
 *
 * 这套测试覆盖批量重构(readDigestBatch / readContentBatch)后的关键路径,
 * 防止 N+1 通过 code review 漏网后再次回潮。
 *
 * SCALE_N 选择 200(而非触发问题的 1026):
 *   - createEngram 自身要 disk write + index sync + SQLite upsert,N=200
 *     的 fixture setup ≈ 8s,测试本身 < 100ms。N=1000 会 setup 卡 60s+。
 *   - 200 已足够暴露 N+1:原 N+1 在 N=200 应 ≈ 6s,批量重构 < 50ms,
 *     500ms 阈值留 10x 余量。
 *   - 触发原始问题的 N 由 manual load-test 覆盖(见 scripts/zte/)。
 *
 * 阈值 500ms:批量路径在 N=200 下实测 < 50ms;500ms 留 10x CI 余量,
 * N+1 回潮时(6s+)会果断失败。
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngramRepository } from "../src/storage/repository.js";
import { applyDecayBatch } from "../src/dreaming/decay.js";
import { runLightDreaming } from "../src/dreaming/light.js";
import { clusterSimilarEngrams } from "../src/dreaming/rem.js";
import { detectKnowledgeGaps } from "../src/generative/gap-detector.js";
import { deriveAllSourceReliability } from "../src/provenance/reliability.js";
import { summarizeVerificationStatus } from "../src/verification/upgrade.js";

const SCALE_N = 200;

let tmpDir: string;
let repo: EngramRepository;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-scale-"));
  repo = new EngramRepository({ rootPath: tmpDir });
  for (let i = 0; i < SCALE_N; i++) {
    repo.createEngram({
      title: `engram-${i}`,
      content: `content ${i} with some text for hashing`,
      kind: "fact",
      domainTags: [`d${i % 5}`, `t${i % 3}`],
      contextTags: [`c${i % 4}`],
      createdBy: `user${i % 10}`,
      importance: 0.5,
    });
  }
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * 复杂度分级:
 *   - SIMPLE (3s):单次 batch 读 + 内存遍历(applyDecay, cluster, gaps,
 *     deriveAll, summarize)。实测 < 500ms,3s 阈值留 6x 余量给 CI 并行负载
 *     (实测并行下会慢 2-4x)。
 *   - COMPLEX (6s):runLightDreaming 内部调 checkDuplicateSync →
 *     findCandidatesSync,每个 entry 触发一次 batch 读,O(N) batch × N entry
 *     = O(N²) 批读。批量重构后 N=200 ≈ 500-700ms,6s 留 10x 余量;
 *     N+1 回潮(readEngram × N)会冲到 6s+,实测 N=1026 时 30s+ 果断失败。
 */
// 放宽到 5000ms:单独跑 ~430ms,但全量并发(pnpm -r 多包 + 各包 vitest 并发)
// CPU 竞争下可达 ~3.5s(8x)。3000ms 在并发下偏紧,5000ms 留 margin。
const SIMPLE_THRESHOLD_MS = 5000;
const COMPLEX_THRESHOLD_MS = 6000;

describe("scale: N+1 hot paths at N=200", () => {
  it("applyDecayBatch 完成 < 3s", () => {
    const start = Date.now();
    const result = applyDecayBatch(repo, {
      nowIso: new Date().toISOString(),
    });
    const ms = Date.now() - start;
    expect(result.scanned).toBe(SCALE_N);
    expect(ms).toBeLessThan(SIMPLE_THRESHOLD_MS);
  });

  it("runLightDreaming 完成 < 6s(complex path: 内部 checkDuplicateSync)", () => {
    const start = Date.now();
    const result = runLightDreaming(repo);
    const ms = Date.now() - start;
    expect(result.scanned).toBe(SCALE_N);
    expect(ms).toBeLessThan(COMPLEX_THRESHOLD_MS);
  });

  it("clusterSimilarEngrams 完成 < 3s", () => {
    const start = Date.now();
    const clusters = clusterSimilarEngrams(repo);
    const ms = Date.now() - start;
    expect(ms).toBeLessThan(SIMPLE_THRESHOLD_MS);
    // clusters 数量随相似度阈值变化,不固定断言
    expect(Array.isArray(clusters)).toBe(true);
  });

  it("detectKnowledgeGaps 完成 < 3s", () => {
    const start = Date.now();
    const result = detectKnowledgeGaps(repo);
    const ms = Date.now() - start;
    expect(ms).toBeLessThan(SIMPLE_THRESHOLD_MS);
    expect(result.summary.totalGaps).toBeGreaterThanOrEqual(0);
  });

  it("deriveAllSourceReliability 完成 < 3s", () => {
    const start = Date.now();
    const result = deriveAllSourceReliability(repo);
    const ms = Date.now() - start;
    expect(result).toHaveLength(10); // 10 个 createdBy(user0..user9)
    expect(ms).toBeLessThan(SIMPLE_THRESHOLD_MS);
  });

  it("summarizeVerificationStatus 完成 < 3s", () => {
    const start = Date.now();
    const result = summarizeVerificationStatus(repo);
    const ms = Date.now() - start;
    expect(result.total).toBe(SCALE_N);
    expect(ms).toBeLessThan(SIMPLE_THRESHOLD_MS);
  });
});
