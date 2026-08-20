// 种子空兜底(缺陷 D,2026-08-17):seedEngramIds 为空时,buildTask 用问题
// 文本对全库 FTS 检索取 top-K active 记忆作为运行时种子;incubateOnce 留审计。
// 此前种子空 → 任务包零记忆上下文,L1(无工具)草稿必然 "no sourceIds" 全灭
// (2026-08-16 重放实测 7/7)。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { EngramRepository } from "../src/storage/repository.js";
import { Incubator } from "../src/maintenance/insight/incubator.js";

function setup(opts: { withMemories?: boolean } = {}) {
  const dataRoot = mkdtempSync(join(tmpdir(), "inc-seed-"));
  const repo = new EngramRepository({ rootPath: dataRoot });
  if (opts.withMemories) {
    repo.createEngram({
      title: "co-engram 审计轮转修复记录",
      content: "audit.jsonl 轮转:首跑 + append 背压 + 空文件噪声停写。",
      kind: "fact",
      domainTags: ["co-engram", "audit"],
      createdBy: "test",
    });
    repo.createEngram({
      title: "夜思实验室设计原则",
      content: "全资源盘点式多夜孵化:记忆图谱 + 行为日志 + 技能库。",
      kind: "pattern",
      domainTags: ["co-engram", "incubation"],
      createdBy: "test",
    });
    repo.createEngram({
      title: "无关领域记忆(不应命中)",
      content: "安卓无线调试配置流程。",
      kind: "observation",
      domainTags: ["android"],
      createdBy: "test",
    });
  }
  const audits: Array<{ action: string; metadata?: Record<string, unknown> }> = [];
  const incubator = new Incubator({
    repository: repo,
    proposalEngine: {
      proposeInsight: () => true,
      listAll: () => [],
      findProposalByEntityId: () => undefined,
    },
    dataRoot,
    auditLog: {
      append: (e: { action: string; metadata?: Record<string, unknown> }) => {
        audits.push({ action: e.action, metadata: e.metadata });
      },
    },
  });
  return { incubator, repo, audits, dataRoot };
}

describe("种子空兜底(buildTask,缺陷 D)", () => {
  it("seedEngramIds 为空 + 库中有相关记忆 → FTS 检索兜底,种子非空且命中相关条目", async () => {
    const { incubator } = setup({ withMemories: true });
    const e = incubator.create({ question: "co-engram 夜思如何改进" });
    const task = await incubator.buildTask(e.id);
    expect(task.seedDigests.length).toBeGreaterThan(0);
    const titles = task.seedDigests.map((s) => s.title).join("\n");
    expect(titles).toContain("审计轮转");
    expect(titles).toContain("夜思");
    // 无关记忆不应挤占兜底位(相关性排序)
    expect(titles).not.toContain("安卓");
  });

  it("seedEngramIds 非空 → 走显式种子,不触发兜底检索", async () => {
    const { incubator, repo } = setup({ withMemories: true });
    const all = repo.listEngrams();
    const target = all.find((x) => x.title.includes("设计原则"))!;
    const e = incubator.create({
      question: "co-engram 夜思如何改进",
      seedEngramIds: [target.id],
    });
    const task = await incubator.buildTask(e.id);
    expect(task.seedDigests).toHaveLength(1);
    expect(task.seedDigests[0]?.id).toBe(target.id);
  });

  it("库为空/问题无命中 → 兜底返回空(不伪造种子)", async () => {
    const { incubator } = setup({ withMemories: false });
    const e = incubator.create({ question: "zzz qqq 无关问题" });
    expect((await incubator.buildTask(e.id)).seedDigests).toEqual([]);
  });

  it("incubateOnce 兜底生效时留审计(night_thinking_seed_fallback)", async () => {
    const { incubator, audits } = setup({ withMemories: true });
    const e = incubator.create({ question: "co-engram 夜思如何改进" });
    // 走真实 incubateOnce:无 llmClient/executor → runL1 抛错 → incubateOnce 抛错,
    // 但审计留痕发生在 buildTask 之后、执行之前,仍应已记录
    await expect(
      incubator.incubateOnce(e.id, "manual"),
    ).rejects.toThrow();
    const entry = audits.find((a) => a.action === "contemplation_seed_fallback");
    expect(entry?.metadata).toMatchObject({ incubationId: e.id, seeded: expect.any(Number) });
    // 释放 in-flight(LLM 缺失抛错路径已由 catch 内 releaseInFlight 处理,无残留)
    expect(incubator.get(e.id)?.thinkingAt).toBeUndefined();
  });
});
