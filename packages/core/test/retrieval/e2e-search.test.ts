// packages/core/test/retrieval/e2e-search.test.ts
//
// T7 端到端:repo.createEngram 真实写入 → syncEngramToIndex 投影 SQLite →
// createSearchEngine(sqlite)→ search → 四因子重排。
//
// 补 sqlite-orchestrator.test.ts 的缺口:后者用 db.upsertEngram 直接写 SQLite,
// 跳过了 repo 写入 + syncEngramToIndex 投影环节。本文件经完整真实路径,验证
// importance / verificationStatus 真的从 frontmatter 一路到四因子排序生效。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngramRepository } from "../../src/storage/repository.js";
import { IndexDb } from "../../src/storage/index-db.js";
import { createSearchEngine } from "../../src/retrieval/search-engine.js";

let tmpDir: string;
let indexDb: IndexDb;
let repo: EngramRepository;
let engine: ReturnType<typeof createSearchEngine>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-e2e-search-"));
  mkdirSync(join(tmpDir, ".co-engram"), { recursive: true });
  indexDb = new IndexDb({ dbPath: join(tmpDir, ".co-engram", "index.db") });
  indexDb.open();
  repo = new EngramRepository({ rootPath: tmpDir }, indexDb);
  engine = createSearchEngine({ type: "sqlite", indexDb });
});

afterEach(() => {
  indexDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("T7 端到端:repo 写入投影 → SQLite 检索 → 四因子重排", () => {
  it("importance 经 repo.createEngram 投影,search 四因子让高 importance 排前", () => {
    const high = repo.createEngram({
      title: "高重要性样本",
      content: "共享关键词 相同内容",
      kind: "fact",
      domainTags: ["demo"],
      importance: 0.9,
      confidence: 0.85,
      createdBy: "tester",
    });
    const low = repo.createEngram({
      title: "低重要性样本",
      content: "共享关键词 相同内容",
      kind: "fact",
      domainTags: ["demo"],
      importance: 0.1,
      confidence: 0.85,
      createdBy: "tester",
    });

    const results = engine.search("共享关键词");
    expect(results.length).toBe(2);
    // 两条 content 相同 → bm25 相近 → relevance 相近;四因子 effImp(importance × truthFactor)
    // 让 importance=0.9 排在 0.1 前。链路:repo.createEngram → syncEngramToIndex 投影
    // importance 列 → searchByFts SELECT e.importance → computeFourFactorScore,全程真实。
    expect(results[0]!.id).toBe(high.id);
    expect(results[1]!.id).toBe(low.id);
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
  });

  it("verificationStatus 投影生效:verified 靠 truthFactor 排前(同 importance)", () => {
    const verified = repo.createEngram({
      title: "已验证样本",
      content: "共享关键词 相同内容",
      kind: "fact",
      domainTags: ["demo"],
      importance: 0.5,
      confidence: 0.85,
      createdBy: "tester",
    });
    const unverified = repo.createEngram({
      title: "未验证样本",
      content: "共享关键词 相同内容",
      kind: "fact",
      domainTags: ["demo"],
      importance: 0.5,
      confidence: 0.85,
      createdBy: "tester",
    });
    // 直接设 verificationStatus(绕过状态机,模拟外部已验证),syncEngramToIndex 投影 verification_status 列
    repo.updateVerificationStatus(verified.id, "verified");

    const results = engine.search("共享关键词");
    expect(results.length).toBe(2);
    // 同 importance(0.5):verified truthFactor=1.0 → effImp=0.5;unverified truthFactor=0.3 → effImp≈0.255
    // effImp 差主导 → verified 排前。证明 verificationStatus 进了 SQLite 排序(T7 前 refuted/verified 都不进)。
    expect(results[0]!.id).toBe(verified.id);
  });
});
