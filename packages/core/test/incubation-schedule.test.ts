import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  Incubator,
  computeNextRunAt,
  isDue,
} from "../src/maintenance/insight/incubator.js";
import type { IncubationEntry } from "../src/maintenance/insight/incubator.js";
import { IncubationCreateInputSchema } from "../src/tools/schemas.js";

function makeIncubator() {
  const dataRoot = mkdtempSync(join(tmpdir(), "inc-sched-"));
  const incubator = new Incubator({
    repository: {} as never,
    proposalEngine: {
      proposeInsight: () => true,
      listAll: () => [],
      findProposalByEntityId: () => undefined,
    },
    dataRoot,
  });
  return { incubator, dataRoot };
}

function entry(over: Partial<IncubationEntry> = {}): IncubationEntry {
  return {
    id: "inc-x",
    question: "q",
    seedEngramIds: [],
    status: "active",
    rounds: 1,
    webResearchOptIn: false,
    createdAt: "2026-08-15T15:02:21.000Z",
    lastHatchedAt: "2026-08-15T15:12:16.000Z",
    timeline: [],
    schedule: "00:00",
    ...over,
  } as IncubationEntry;
}

describe("incubation schedule", () => {
  it("create 默认 schedule=00:00", () => {
    const { incubator } = makeIncubator();
    const e = incubator.create({ question: "测试问题ABC" });
    expect(e.schedule).toBe("00:00");
  });

  it("create 接受合法 HH:mm", () => {
    const { incubator } = makeIncubator();
    const e = incubator.create({ question: "测试问题ABC", schedule: "09:30" });
    expect(e.schedule).toBe("09:30");
  });

  it("旧数据(无 schedule)list 时按 00:00 处理", () => {
    const { incubator, dataRoot } = makeIncubator();
    const created = incubator.create({ question: "测试问题ABC" });
    // 手动抹掉 schedule 模拟旧数据
    const p = join(dataRoot, ".co-engram", "incubations.json");
    const raw = JSON.parse(readFileSync(p, "utf8")) as Array<Record<string, unknown>>;
    delete raw[0]!.schedule;
    writeFileSync(p, JSON.stringify(raw, null, 2));
    expect(incubator.get(created.id)?.schedule).toBe("00:00");
  });

  it("schema 拒绝非法 schedule(fail-loud)", () => {
    expect(IncubationCreateInputSchema.safeParse({ question: "测试问题ABC", schedule: "25:00" }).success).toBe(false);
    expect(IncubationCreateInputSchema.safeParse({ question: "测试问题ABC", schedule: "9:3" }).success).toBe(false);
    expect(IncubationCreateInputSchema.safeParse({ question: "测试问题ABC", schedule: "09:30" }).success).toBe(true);
  });

  it("schema 边界:23:59 通过,24:00 与 09:60 拒绝", () => {
    expect(IncubationCreateInputSchema.safeParse({ question: "测试问题ABC", schedule: "23:59" }).success).toBe(true);
    expect(IncubationCreateInputSchema.safeParse({ question: "测试问题ABC", schedule: "24:00" }).success).toBe(false);
    expect(IncubationCreateInputSchema.safeParse({ question: "测试问题ABC", schedule: "09:60" }).success).toBe(false);
  });

  it("create({schedule:\"09:30\"}) → get() 读回 09:30(round-trip)", () => {
    const { incubator } = makeIncubator();
    const created = incubator.create({ question: "测试问题ABC", schedule: "09:30" });
    expect(incubator.get(created.id)?.schedule).toBe("09:30");
  });
});

describe("锚点 due/nextRunAt(spec §四,红队修正 R4)", () => {
  // 本地时区 +08:00 固定用例
  it("00:10(本地)创建 → 今日锚点 < createdAt → 不 due,nextRunAt=次日 00:00 本地", () => {
    const e = entry({ createdAt: "2026-08-15T16:10:00.000Z", lastHatchedAt: null, schedule: "00:00" }); // 08-16 00:10+08
    const now = new Date("2026-08-15T16:30:00.000Z"); // 08-16 00:30+08
    expect(isDue(e, now)).toBe(false);
    expect(computeNextRunAt(e, now)).toBe(new Date("2026-08-16T16:00:00.000Z").toISOString()); // 08-17 00:00+08
  });

  it("23:50 创建 → 等次日锚点", () => {
    const e = entry({ createdAt: "2026-08-15T15:50:00.000Z", lastHatchedAt: null }); // 23:50+08
    const now = new Date("2026-08-15T15:55:00.000Z");
    expect(isDue(e, now)).toBe(false);
  });

  it("昨日 22:00 手动跑过 → 今日 00:00 锚点 > last → due(手动不消耗额度)", () => {
    const e = entry({ lastHatchedAt: "2026-08-15T14:00:00.000Z" }); // 昨 22:00+08
    const now = new Date("2026-08-15T16:05:00.000Z"); // 今 00:05+08
    expect(isDue(e, now)).toBe(true);
  });

  it("今日 00:30 手动跑过 → 今日锚点 < last → 当日不再自动", () => {
    const e = entry({ lastHatchedAt: "2026-08-15T16:30:00.000Z" }); // 今 00:30+08
    const now = new Date("2026-08-15T17:00:00.000Z");
    expect(isDue(e, now)).toBe(false);
    expect(computeNextRunAt(e, now)).toBe(new Date("2026-08-16T16:00:00.000Z").toISOString()); // 明 00:00+08
  });

  it("错过锚点(无进程)→ 补跑语义:昨日锚点后未跑,今日锚点已过 → due", () => {
    const e = entry({ lastHatchedAt: "2026-08-13T16:00:00.000Z" }); // 08-14 00:00+08(昨日锚点轮)
    const now = new Date("2026-08-15T05:00:00.000Z"); // 08-15 13:00+08
    expect(isDue(e, now)).toBe(true);
    expect(new Date(computeNextRunAt(e, now)!) < now).toBe(true);
  });

  it("resolved/paused 态无 nextRunAt", () => {
    expect(computeNextRunAt(entry({ status: "resolved" }))).toBeNull();
  });

  it("自定义 schedule 生效", () => {
    const e = entry({ schedule: "09:30", lastHatchedAt: "2026-08-15T01:00:00.000Z" }); // 09:00+08
    const now = new Date("2026-08-15T01:10:00.000Z");
    expect(computeNextRunAt(e, now)).toBe(new Date("2026-08-15T01:30:00.000Z").toISOString()); // 当日 09:30+08
  });
});
