import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngramRepository } from "../../src/storage/repository.js";
import { IndexDb } from "../../src/storage/index-db.js";
import { refreshDomainTagsOnDrift } from "../../src/maintenance/tag-refresh.js";
import type { LlmClient } from "../../src/observability/necessity-evaluator.js";

/**
 * 标签漂移刷新三层过滤的单测。
 *
 * 覆盖:L0 contentHash 相等 skip / L1 drift<阈值 skip / L2 drift≥阈值刷新 /
 *      首次(baseline 不存在)无条件刷新 / 无 llmClient 时 failed / 无 indexDb noop。
 */
describe("refreshDomainTagsOnDrift", () => {
  let tmpDir: string;
  let repo: EngramRepository;
  let indexDb: IndexDb;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ce-tag-refresh-"));
    mkdirSync(join(tmpDir, ".co-engram"), { recursive: true });
    indexDb = new IndexDb({ dbPath: join(tmpDir, ".co-engram", "index.db") });
    indexDb.open();
    repo = new EngramRepository({ rootPath: tmpDir }, indexDb);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** mock LlmClient:总是返回固定的 domainTags(extractEngramFieldsWithLlm 解析) */
  function llmReturning(domainTags: string[]): LlmClient {
    return {
      async complete() {
        return JSON.stringify({
          title: "extracted-title",
          kind: "observation",
          domainTags,
          summary: "extracted summary",
        });
      },
    };
  }

  it("noop when indexDb absent (returns empty report, no scan)", async () => {
    const repoNoDb = new EngramRepository({ rootPath: tmpDir });
    const report = await refreshDomainTagsOnDrift(
      repoNoDb,
      undefined,
      undefined,
    );
    expect(report.scanned).toBe(0);
    expect(report.refreshed).toBe(0);
  });

  it("refreshes on first run (no baseline) and writes new tags + baseline", async () => {
    const eng = repo.createEngram({
      title: "Wireless ADB setup",
      content: "How to configure wireless adb debugging on android devices",
      kind: "fact",
      domainTags: ["uncategorized"],
      createdBy: "test",
    });
    const report = await refreshDomainTagsOnDrift(
      repo,
      undefined,
      llmReturning(["android", "adb", "testing"]),
    );
    expect(report.refreshed).toBe(1);
    expect(report.failed).toBe(0);
    const updated = repo.readEngram(eng.id);
    expect([...updated.domainTags]).toEqual(["android", "adb", "testing"]);
    // baseline 已写入(下轮 L0 能命中)
    expect(indexDb.readTagRefreshBaseline(eng.id)).toBeDefined();
  });

  it("L0 skips unchanged on second run (contentHash equal, zero LLM)", async () => {
    repo.createEngram({
      title: "A",
      content: "alpha beta gamma",
      kind: "fact",
      domainTags: ["uncategorized"],
      createdBy: "test",
    });
    const llm = llmReturning(["topic"]);
    await refreshDomainTagsOnDrift(repo, undefined, llm); // 首次,建 baseline
    const r2 = await refreshDomainTagsOnDrift(repo, undefined, llm);
    expect(r2.skippedUnchanged).toBe(1);
    expect(r2.refreshed).toBe(0);
  });

  it("L2 refreshes when content drifts above threshold (major rewrite)", async () => {
    const eng = repo.createEngram({
      title: "A",
      content: "alpha beta gamma",
      kind: "fact",
      domainTags: ["uncategorized"],
      createdBy: "test",
    });
    // 按调用次数返回不同标签:首次(占位符豁免,建 baseline)→ newtopic;
    // 第二轮(大改后)→ databasetopic。sameAsOld 优化要求漂移后标签确实变化才重提落盘。
    let callN = 0;
    const llm: LlmClient = {
      async complete() {
        callN += 1;
        const tags = callN === 1 ? ["newtopic"] : ["databasetopic"];
        return JSON.stringify({
          title: "t",
          kind: "observation",
          domainTags: tags,
          summary: "s",
        });
      },
    };
    await refreshDomainTagsOnDrift(repo, undefined, llm); // baseline(占位符豁免,落盘 newtopic)
    // 大改:完全不同的内容域,token 几乎不交 → drift ≈ 1 ≥ 0.3
    repo.updateEngram(eng.id, {
      content:
        "completely different subject about database networking and security",
      updatedBy: "test",
    });
    const r = await refreshDomainTagsOnDrift(repo, undefined, llm);
    expect(r.refreshed).toBe(1);
    expect(r.skippedBelowThreshold).toBe(0);
  });

  it("L1 skips below threshold on minor content change (drift < 0.3)", async () => {
    const eng = repo.createEngram({
      title: "A",
      content:
        "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda",
      kind: "fact",
      domainTags: ["uncategorized"],
      createdBy: "test",
    });
    const llm = llmReturning(["topic"]);
    await refreshDomainTagsOnDrift(repo, undefined, llm); // baseline(12 tokens)
    // 小改:仅加 1 个 token,Jaccard = 12/13 ≈ 0.92,drift ≈ 0.08 < 0.3
    repo.updateEngram(eng.id, {
      content:
        "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu",
      updatedBy: "test",
    });
    const r = await refreshDomainTagsOnDrift(repo, undefined, llm);
    expect(r.skippedBelowThreshold).toBe(1);
    expect(r.refreshed).toBe(0);
  });

  it("fails (no LLM call) when drift exceeds threshold but llmClient absent", async () => {
    repo.createEngram({
      title: "A",
      content: "some meaningful content here",
      kind: "fact",
      domainTags: ["uncategorized"],
      createdBy: "test",
    });
    const r = await refreshDomainTagsOnDrift(repo, undefined, undefined);
    // 首次 baseline 不存在 → drift=1 ≥ 阈值,但无 llm → failed(仍更新 baseline)
    expect(r.failed).toBe(1);
    expect(r.refreshed).toBe(0);
  });
});
