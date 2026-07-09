import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngramRepository } from "../src/storage/repository.js";
import {
  applyDecayBatch,
  DEFAULT_FORGET_IMPORTANCE_THRESHOLD,
} from "../src/dreaming/decay.js";
import { runLightDreaming } from "../src/dreaming/light.js";
import { runDeepDreaming } from "../src/dreaming/deep.js";
import { createDreamingScheduler } from "../src/dreaming/scheduler.js";
import { recordRetrievalSuccess } from "../src/reinforcement/ltp.js";

let tmpDir: string;
let repo: EngramRepository;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-dreaming-"));
  repo = new EngramRepository({ rootPath: tmpDir });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeEngram(input: {
  title: string;
  content: string;
  importance?: number;
  createdBy?: string;
  domainTags?: string[];
}) {
  return repo.createEngram({
    title: input.title,
    content: input.content,
    kind: "fact",
    domainTags: input.domainTags ?? ["t"],
    createdBy: input.createdBy ?? "y",
    importance: input.importance ?? 0.5,
  });
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

// ============================================================
// decay.ts
// ============================================================

describe("applyDecayBatch", () => {
  it("空仓库 → 空结果", () => {
    const result = applyDecayBatch(repo, { nowIso: new Date().toISOString() });
    expect(result.scanned).toBe(0);
    expect(result.forgotten).toEqual([]);
    expect(result.archived).toEqual([]);
  });

  it("fresh engram → 不动", () => {
    makeEngram({ title: "A", content: "a", importance: 0.5 });
    const result = applyDecayBatch(repo, { nowIso: new Date().toISOString() });
    expect(result.scanned).toBe(1);
    expect(result.byFreshness.fresh).toBe(1);
    expect(result.forgotten).toEqual([]);
    expect(result.archived).toEqual([]);
  });

  it("forgotten freshness(>4×halfLife 未强化)→ forget", () => {
    // importance=0.5 → halfLife≈14 天;500 天 >> 4×14=56 天 → forgotten
    const engram = makeEngram({
      title: "A",
      content: "a",
      importance: 0.5,
    });
    repo.bumpRetrievalStats(engram.id, { lastEffectiveAt: daysAgoIso(500) });
    const result = applyDecayBatch(repo, { nowIso: new Date().toISOString() });
    expect(result.forgotten).toContain(engram.id);
    expect(result.scanned).toBe(1);
    expect(repo.readEngram(engram.id).status).toBe("forgotten");
  });

  it("stale + 高 importance → archive", () => {
    // importance=0.5 → halfLife≈14 天;30 天前 → 2×14=28 < 30 ≤ 4×14=56 → stale
    const engram = makeEngram({
      title: "A",
      content: "a",
      importance: 0.5,
    });
    repo.bumpRetrievalStats(engram.id, { lastEffectiveAt: daysAgoIso(30) });
    const result = applyDecayBatch(repo, { nowIso: new Date().toISOString() });
    expect(result.archived).toContain(engram.id);
    expect(result.forgotten).toEqual([]);
    expect(repo.readEngram(engram.id).status).toBe("frozen");
  });

  it("stale + 低 importance → forget", () => {
    // importance=0.5 → halfLife≈14 天;30 天前 → stale(2×14=28 < 30 ≤ 4×14=56)
    // importance=0.1 < 默认阈值 0.2 → forget
    const engram = makeEngram({
      title: "A",
      content: "a",
      importance: 0.1,
    });
    repo.bumpRetrievalStats(engram.id, { lastEffectiveAt: daysAgoIso(30) });
    const result = applyDecayBatch(repo, { nowIso: new Date().toISOString() });
    expect(result.forgotten).toContain(engram.id);
    expect(result.archived).toEqual([]);
    expect(repo.readEngram(engram.id).status).toBe("forgotten");
  });

  it("自定义 forgetImportanceThreshold 生效", () => {
    // importance=0.4 → halfLife≈6.5 天;30 天前 → forgotten(>4×6.5=26)
    // 改成 importance=0.5 → halfLife≈14,stale;阈值 0.5,importance=0.4 < 0.5 → forget
    // 但更直接的:importance=0.5 + 30 天前 stale + 阈值提升到 0.6 → 0.5 < 0.6 → forget
    const engram = makeEngram({
      title: "A",
      content: "a",
      importance: 0.5,
    });
    repo.bumpRetrievalStats(engram.id, { lastEffectiveAt: daysAgoIso(30) });
    // 默认阈值 0.2,0.5 > 0.2 → archive;改成 0.6,0.5 < 0.6 → forget
    const result = applyDecayBatch(repo, {
      nowIso: new Date().toISOString(),
      forgetImportanceThreshold: 0.6,
    });
    expect(result.forgotten).toContain(engram.id);
  });

  it("跳过 archived/forgotten engram", () => {
    const engram = makeEngram({ title: "A", content: "a" });
    repo.updateLifecycle(engram.id, "archived");
    const result = applyDecayBatch(repo, { nowIso: new Date().toISOString() });
    expect(result.scanned).toBe(0); // 跳过非 active
  });

  it("dryRun=true 不落盘", () => {
    // importance=0.1 → halfLife≈0.32 天;25 天前 → forgotten
    const engram = makeEngram({
      title: "A",
      content: "a",
      importance: 0.1,
    });
    repo.bumpRetrievalStats(engram.id, { lastEffectiveAt: daysAgoIso(25) });
    const result = applyDecayBatch(repo, {
      nowIso: new Date().toISOString(),
      dryRun: true,
    });
    expect(result.forgotten).toContain(engram.id);
    expect(repo.readEngram(engram.id).status).toBe("active"); // 没落盘
  });

  it("DEFAULT_FORGET_IMPORTANCE_THRESHOLD 默认值", () => {
    expect(DEFAULT_FORGET_IMPORTANCE_THRESHOLD).toBe(0.2);
  });

  it("批量场景：混合多种状态", () => {
    // importance=0.9 → halfLife≈49 天;刚创建未生效 → fresh
    const fresh = makeEngram({
      title: "Fresh",
      content: "fresh",
      importance: 0.9,
    });
    // importance=0.5 → halfLife≈14 天;30 天前 → stale(2×14=28 < 30 ≤ 4×14=56)
    const stale1 = makeEngram({
      title: "Stale High",
      content: "stale hi",
      importance: 0.5,
    });
    // importance=0.05 → halfLife≈0.18;30 天前 → forgotten(>> 4×0.18)
    const stale2 = makeEngram({
      title: "Stale Low",
      content: "stale lo",
      importance: 0.05,
    });
    // importance=0.5 → halfLife≈14;500 天前 → forgotten
    const forgotten = makeEngram({
      title: "Forgotten",
      content: "forgotten",
      importance: 0.5,
    });
    repo.bumpRetrievalStats(stale1.id, { lastEffectiveAt: daysAgoIso(30) });
    repo.bumpRetrievalStats(stale2.id, { lastEffectiveAt: daysAgoIso(30) });
    repo.bumpRetrievalStats(forgotten.id, { lastEffectiveAt: daysAgoIso(500) });

    const result = applyDecayBatch(repo, { nowIso: new Date().toISOString() });
    expect(result.scanned).toBe(4);
    expect(result.archived).toContain(stale1.id);
    expect(result.forgotten).toContain(stale2.id);
    expect(result.forgotten).toContain(forgotten.id);
    expect(result.byFreshness.fresh).toBe(1);
    expect(result.byFreshness.stale).toBe(1);
    expect(result.byFreshness.forgotten).toBe(2);
  });
});

// ============================================================
// light.ts
// ============================================================

describe("runLightDreaming", () => {
  it("空仓库 → 空结果", () => {
    const result = runLightDreaming(repo);
    expect(result.scanned).toBe(0);
    expect(result.duplicatesHandled).toEqual([]);
    expect(result.updatesHandled).toEqual([]);
  });

  it("无重复 → 全部 NEW", () => {
    makeEngram({ title: "A", content: "内容 A 关于某个主题" });
    makeEngram({ title: "B", content: "内容 B 关于另一个主题" });
    const result = runLightDreaming(repo);
    expect(result.scanned).toBe(2);
    expect(result.newConsidered).toBe(2);
    expect(result.duplicatesHandled).toEqual([]);
    expect(result.updatesHandled).toEqual([]);
  });

  it("完全重复 → 强化 target + 删除 dup", () => {
    const first = makeEngram({
      title: "ADB 调试",
      content: "使用 adb wireless 调试 Android 设备",
    });
    // 第二个 engram 内容相同（但 title 不同避免 id 冲突）
    const second = makeEngram({
      title: "ADB 调试副本",
      content: "使用 adb wireless 调试 Android 设备",
    });

    const result = runLightDreaming(repo);
    expect(result.duplicatesHandled.length).toBe(1);
    // 第一个保留，第二个删除
    expect(repo.exists(first.id)).toBe(true);
    expect(repo.exists(second.id)).toBe(false);
    // 第一个被强化（retrievalCount 增加）
    const reinforced = repo.readEngram(first.id);
    expect(reinforced.retrievalCount).toBeGreaterThanOrEqual(1);
  });

  it("dryRun=true 不删除不强化", () => {
    makeEngram({
      title: "ADB 调试",
      content: "使用 adb wireless 调试 Android 设备",
    });
    const second = makeEngram({
      title: "ADB 调试副本",
      content: "使用 adb wireless 调试 Android 设备",
    });

    const result = runLightDreaming(repo, { dryRun: true });
    expect(result.duplicatesHandled.length).toBe(1);
    // dryRun 时不删除
    expect(repo.exists(second.id)).toBe(true);
  });

  it("跳过 archived/forgotten", () => {
    const archived = makeEngram({
      title: "Archie",
      content: "archived content",
    });
    repo.updateLifecycle(archived.id, "archived");
    makeEngram({ title: "Active", content: "active content" });

    const result = runLightDreaming(repo);
    expect(result.scanned).toBe(1); // 只扫描 active
  });

  it("stable：按 id 字典序处理", () => {
    // 创建多个 engram，验证 scanned 顺序稳定
    makeEngram({ title: "Z", content: "z 内容" });
    makeEngram({ title: "A", content: "a 内容" });
    makeEngram({ title: "M", content: "m 内容" });
    const result1 = runLightDreaming(repo);
    const result2 = runLightDreaming(repo);
    // 两次运行结果应该一致（虽然 listEngrams 顺序可能变，但内部排序后稳定）
    expect(result1.scanned).toBe(result2.scanned);
    expect(result1.newConsidered).toBe(result2.newConsidered);
  });
});

// ============================================================
// deep.ts
// ============================================================

describe("runDeepDreaming", () => {
  it("默认：先 light 后 decay", () => {
    // 一个重复（light 处理）+ 一个 stale（decay 处理）
    makeEngram({ title: "Dup A", content: "duplicate content" });
    makeEngram({ title: "Dup B", content: "duplicate content" });

    const stale = makeEngram({
      title: "Stale",
      content: "stale unique content",
      importance: 0.1,
    });
    repo.bumpRetrievalStats(stale.id, { lastEffectiveAt: daysAgoIso(30) });

    const result = runDeepDreaming(repo, {
      decay: { nowIso: new Date().toISOString() },
    });

    expect(result.light).not.toBeNull();
    expect(result.decay).not.toBeNull();
    expect(
      result.light!.duplicatesHandled.length +
        result.light!.updatesHandled.length,
    ).toBeGreaterThan(0);
    expect(
      result.decay!.forgotten.length + result.decay!.archived.length,
    ).toBeGreaterThan(0);
  });

  it("skipLight=true：只跑 decay", () => {
    makeEngram({ title: "Dup A", content: "duplicate content" });
    makeEngram({ title: "Dup B", content: "duplicate content" });
    const result = runDeepDreaming(repo, { skipLight: true });
    expect(result.light).toBeNull();
    expect(result.decay).not.toBeNull();
    // 没跑 light → 重复仍在
    expect(repo.listEngrams().length).toBe(2);
  });

  it("skipDecay=true：只跑 light", () => {
    makeEngram({ title: "Dup A", content: "duplicate content" });
    makeEngram({ title: "Dup B", content: "duplicate content" });
    const result = runDeepDreaming(repo, { skipDecay: true });
    expect(result.light).not.toBeNull();
    expect(result.decay).toBeNull();
  });
});

// ============================================================
// scheduler.ts
// ============================================================

describe("createDreamingScheduler", () => {
  it("trigger 立即执行指定阶段", () => {
    makeEngram({ title: "A", content: "a" });
    const scheduler = createDreamingScheduler(repo);
    const record = scheduler.trigger("light");
    expect(record.stage).toBe("light");
    expect(record.result).toBeDefined();
    expect(record.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("onRun handler 在 trigger 时被调用", () => {
    makeEngram({ title: "A", content: "a" });
    const scheduler = createDreamingScheduler(repo);
    const records: Array<{ stage: string; at: string }> = [];
    scheduler.onRun((r) => records.push({ stage: r.stage, at: r.at }));
    scheduler.trigger("light");
    scheduler.trigger("deep");
    expect(records.length).toBe(2);
    expect(records[0]!.stage).toBe("light");
    expect(records[1]!.stage).toBe("deep");
  });

  it("start/stop 正确切换 isRunning", () => {
    const scheduler = createDreamingScheduler(repo, {
      lightIntervalMs: 100,
      deepIntervalMs: 200,
    });
    expect(scheduler.isRunning()).toBe(false);
    scheduler.start();
    expect(scheduler.isRunning()).toBe(true);
    scheduler.stop();
    expect(scheduler.isRunning()).toBe(false);
  });

  it("多次 start 幂等", () => {
    const scheduler = createDreamingScheduler(repo);
    scheduler.start();
    scheduler.start(); // 不会重新创建 timer
    expect(scheduler.isRunning()).toBe(true);
    scheduler.stop();
  });

  it("handler 异常不影响后续调度", () => {
    makeEngram({ title: "A", content: "a" });
    const scheduler = createDreamingScheduler(repo);
    let callCount = 0;
    scheduler.onRun(() => {
      callCount += 1;
      throw new Error("handler 故意出错");
    });
    // 第一次 trigger：handler 抛错但 trigger 本身应该完成
    expect(() => scheduler.trigger("light")).not.toThrow();
    expect(callCount).toBe(1);
    // 第二次 trigger：handler 仍被调用（没被移除）
    scheduler.trigger("light");
    expect(callCount).toBe(2);
  });
});

// ============================================================
// 端到端：spec 验收（1000 engram + 50 重复）
// ============================================================

describe("spec 验收：模拟批量场景", () => {
  it("小规模：10 engram + 3 对重复，light 后重复为 0", () => {
    // 创建 7 个独立 engram
    for (let i = 0; i < 7; i++) {
      makeEngram({
        title: `Unique-${i}`,
        content: `唯一内容 ${i} 关于主题 ${i}`,
        domainTags: [`d${i}`],
      });
    }
    // 创建 3 对完全重复（title 不同但 content 相同）
    const dupContents = ["共享内容 A", "共享内容 B", "共享内容 C"];
    for (const c of dupContents) {
      makeEngram({ title: `${c}-1`, content: c, domainTags: ["dup"] });
      makeEngram({ title: `${c}-2`, content: c, domainTags: ["dup"] });
    }

    expect(repo.listEngrams().length).toBe(13); // 7 + 6

    const result = runLightDreaming(repo);
    expect(result.duplicatesHandled.length).toBe(3); // 每对删一个
    expect(repo.listEngrams().length).toBe(10); // 13 - 3
  });

  it("stale engram 全部归档（小规模）", () => {
    // 5 个 stale 高 importance（应该 archive）
    // importance=0.8 → halfLife≈37 天;30 天前 → fresh(< 37) → 改 80 天前(2×37=74 < 80 ≤ 4×37=148 → stale)
    for (let i = 0; i < 5; i++) {
      const e = makeEngram({
        title: `Stale-${i}`,
        content: `stale 内容 ${i}`,
        importance: 0.8,
      });
      repo.bumpRetrievalStats(e.id, { lastEffectiveAt: daysAgoIso(80) });
    }
    // 3 个 forgotten（应该 forget）
    // importance=0.5 → halfLife≈14 天;500 天前 → forgotten(>> 4×14=56)
    for (let i = 0; i < 3; i++) {
      const e = makeEngram({
        title: `Forgotten-${i}`,
        content: `forgotten 内容 ${i}`,
        importance: 0.5,
      });
      repo.bumpRetrievalStats(e.id, { lastEffectiveAt: daysAgoIso(500) });
    }

    const result = applyDecayBatch(repo, { nowIso: new Date().toISOString() });
    expect(result.archived.length).toBe(5);
    expect(result.forgotten.length).toBe(3);

    // 验证所有 frozen/forgotten 状态正确
    for (const entry of repo.listEngrams()) {
      // noplus1: test assertion, fixture 个验证用
      const engram = repo.readEngram(entry.id);
      expect(["frozen", "forgotten"]).toContain(engram.status);
    }
  });
});
