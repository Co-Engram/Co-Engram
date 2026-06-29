import { describe, it, expect } from "vitest";
import * as M from "../src/index.js";

describe("@co-engram/contracts-test skeleton", () => {
  it("exports 4 contract test runners", () => {
    expect(typeof M.runProfileContractTests).toBe("function");
    expect(typeof M.runI18nContractTests).toBe("function");
    expect(typeof M.runConfigSchemaContractTests).toBe("function");
    expect(typeof M.runHelpTextContractTests).toBe("function");
  });
});
