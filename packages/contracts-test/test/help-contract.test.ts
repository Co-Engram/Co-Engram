import { describe, it, expect } from "vitest";
import { runHelpTextContractTests } from "../src/help-contract.js";

describe("runHelpTextContractTests", () => {
  it("viewer help / mcp instructions / prompt-builder 三处核心概念一致", async () => {
    const result = await runHelpTextContractTests();
    if (!result.passed) {
      console.error("help contract failures:\n" +
        result.diffs.map((d) => `  - [${d.kind}] ${d.detail}`).join("\n"));
    }
    expect(result.passed).toBe(true);
    expect(result.diffs).toEqual([]);
  });
});
