import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Incubator } from "../src/maintenance/insight/incubator.js";
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

describe("incubation schedule", () => {
  afterEach(() => vi.useRealTimers());

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
});
