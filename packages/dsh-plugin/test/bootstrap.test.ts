import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDshRuntime } from "../src/bootstrap.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("createDshRuntime", () => {
  it("组装成功:host 标识 dsh-plugin、standard profile 工具就绪、dataRoot 自动创建", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "dsh-boot-"));
    roots.push(dataRoot);
    const rt = await createDshRuntime({ dataRootOverrideForTest: dataRoot });
    expect(rt.ctx.host).toBe("dsh-plugin");
    expect(rt.tools.length).toBeGreaterThanOrEqual(38);
    expect(rt.tools.every((t) => !t.name.startsWith("mcp__"))).toBe(true);
    expect(existsSync(dataRoot)).toBe(true);
    rt.stop();
  });

  it("ProcessLock 释放幂等(stop 两次不抛)", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "dsh-boot2-"));
    roots.push(dataRoot);
    const rt = await createDshRuntime({ dataRootOverrideForTest: dataRoot });
    rt.stop();
    expect(() => rt.stop()).not.toThrow();
  });
});
