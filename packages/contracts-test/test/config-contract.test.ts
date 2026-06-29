import { describe, it, expect } from "vitest";
import { runConfigSchemaContractTests } from "../src/config-contract.js";

describe("runConfigSchemaContractTests", () => {
  it("host-only + deprecated 字段两端识别一致", async () => {
    const result = await runConfigSchemaContractTests();
    if (!result.passed) {
      console.error("config contract failures:\n" +
        result.diffs.map((d) => `  - [${d.kind}] ${d.detail}`).join("\n"));
    }
    expect(result.passed).toBe(true);
    expect(result.diffs).toEqual([]);
  });
});
