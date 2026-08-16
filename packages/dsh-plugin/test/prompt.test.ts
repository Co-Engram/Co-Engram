import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDshRuntime } from "../src/bootstrap.js";
import { createCoEngramPromptSection } from "../src/prompt.js";

describe("createCoEngramPromptSection", () => {
  it("段名/order 契约 + text 为函数 + 输出含记忆引导", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "dsh-prompt-"));
    try {
      const rt = createDshRuntime({ dataRootOverrideForTest: dataRoot });
      const section = createCoEngramPromptSection(rt);
      expect(section.name).toBe("memory:co-engram");
      expect(section.order).toBe(120);
      expect(typeof section.text).toBe("function");
      const text = (section.text as (c: unknown) => string)({});
      expect(text.length).toBeGreaterThan(50);
      expect(text).toMatch(/engram/i);
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it("signals 动态性:写入带 tag 的 engram 后 topTags 即时出现在文本", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "dsh-prompt2-"));
    try {
      const rt = createDshRuntime({ dataRootOverrideForTest: dataRoot });
      const before = (createCoEngramPromptSection(rt).text as (c: unknown) => string)({});
      expect(before).not.toContain("dsh-dynamic-check");
      const create = rt.tools.find((t) => t.name === "engram_create");
      expect(create).toBeDefined();
      await create!.execute(
        {
          title: "动态性验证",
          content: "topTags 动态注入验证。",
          kind: "observation",
          domainTags: ["dsh-dynamic-check"],
          visibility: "team",
        },
        rt.ctx,
      );
      // 同一 runtime 实例上,text provider 实时取 repository——不重启即反映新写入
      const after = (createCoEngramPromptSection(rt).text as (c: unknown) => string)({});
      expect(after).toContain("dsh-dynamic-check");
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});
