// openclaw 宿主 wiring:ctx.incubator 存在且 L1 降级(executor 未注入,降级矩阵记录)
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";

import { createCoEngramContext } from "../src/plugin-entry.js";

let tmpDir: string;

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe("openclaw incubator wiring", () => {
  it("createCoEngramContext 注入 incubator(无 executor → L1 降级路径)", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "co-engram-oc-incub-"));
    const ctx = createCoEngramContext({ dataRoot: tmpDir });
    expect(ctx.incubator).toBeDefined();
    // 无 executor 注入:runDue/incubateOnce 走 L1(无 llmClient 时报错,
    // 由调用方 catch —— 即降级矩阵记录的行为)
    const entries = ctx.incubator!.list();
    expect(entries).toEqual([]);
  });
});
