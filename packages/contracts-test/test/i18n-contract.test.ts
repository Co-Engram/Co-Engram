import { describe, it, expect } from "vitest";
import { runI18nContractTests } from "../src/i18n-contract.js";

describe("runI18nContractTests", () => {
  it("zh / en 字典 key parity 通过,无 hard-coded language ternary", async () => {
    const result = await runI18nContractTests();
    if (!result.passed) {
      console.error("i18n contract failures:\n" +
        result.diffs.map((d) => `  - [${d.kind}] ${d.detail}`).join("\n"));
    }
    expect(result.passed).toBe(true);
    expect(result.diffs).toEqual([]);
  });
});
