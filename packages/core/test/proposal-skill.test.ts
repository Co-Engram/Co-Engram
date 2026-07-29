import { describe, it, expect } from "vitest";
import { skillEntityId, SKILL_PROPOSAL_PREFIX } from "../src/observability/proposal-engine.js";

describe("skillEntityId", () => {
  it("前缀 skill: + 16 hex", () => {
    const id = skillEntityId("tools/a");
    expect(id.startsWith(SKILL_PROPOSAL_PREFIX)).toBe(true);
    expect(id.length).toBe(SKILL_PROPOSAL_PREFIX.length + 16);
  });
  it("稳定（同输入同输出）", () => {
    expect(skillEntityId("tools/a")).toBe(skillEntityId("tools/a"));
  });
  it("不同 sourcePath 不同 id", () => {
    expect(skillEntityId("tools/a")).not.toBe(skillEntityId("tools/b"));
  });
});
