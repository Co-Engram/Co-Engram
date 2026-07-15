import { describe, it, expect } from "vitest";
import { ContradictionResolveInputSchema } from "../src/tools/schemas.js";

describe("contradiction_resolve synapseId 大小写(修 toUpperCase bug)", () => {
  it("synapseId 保持小写 syn-xxx,不被 ULID toUpperCase", () => {
    const parsed = ContradictionResolveInputSchema.parse({
      fromId: "01KXJ5YM033DMMYMMQ97JJEE7B",
      synapseId: "syn-79ab8bcb4298e7e3",
      verdict: "keep_new",
      rationale: "test",
      resolvedBy: "tester",
    });
    expect(parsed.synapseId).toBe("syn-79ab8bcb4298e7e3");
    expect(parsed.fromId).toBe("01KXJ5YM033DMMYMMQ97JJEE7B"); // engramId 仍 ULID 大写
  });
});
