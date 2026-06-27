import { describe, it, expect } from "vitest";
import { arbitrateByUpdatedAt } from "./arbitration.js";

describe("arbitrateByUpdatedAt", () => {
  it("returns ours when ours.updatedAt is strictly newer", () => {
    expect(
      arbitrateByUpdatedAt({
        oursUpdatedAt: "2026-06-25T10:00:00Z",
        theirsUpdatedAt: "2026-06-25T09:00:00Z",
      }),
    ).toBe("ours");
  });

  it("returns theirs when theirs.updatedAt is strictly newer", () => {
    expect(
      arbitrateByUpdatedAt({
        oursUpdatedAt: "2026-06-25T09:00:00Z",
        theirsUpdatedAt: "2026-06-25T10:00:00Z",
      }),
    ).toBe("theirs");
  });

  it("tiebreaker: ours wins when only ours changed contentHash", () => {
    expect(
      arbitrateByUpdatedAt({
        oursUpdatedAt: "2026-06-25T10:00:00Z",
        theirsUpdatedAt: "2026-06-25T10:00:00Z",
        baseContentHash: "abc",
        oursContentHash: "def",
        theirsContentHash: "abc",
      }),
    ).toBe("ours");
  });

  it("tiebreaker: theirs wins when only theirs changed contentHash", () => {
    expect(
      arbitrateByUpdatedAt({
        oursUpdatedAt: "2026-06-25T10:00:00Z",
        theirsUpdatedAt: "2026-06-25T10:00:00Z",
        baseContentHash: "abc",
        oursContentHash: "abc",
        theirsContentHash: "xyz",
      }),
    ).toBe("theirs");
  });

  it("escalates when both sides changed contentHash (no LLM in Phase 1)", () => {
    expect(
      arbitrateByUpdatedAt({
        oursUpdatedAt: "2026-06-25T10:00:00Z",
        theirsUpdatedAt: "2026-06-25T10:00:00Z",
        baseContentHash: "abc",
        oursContentHash: "def",
        theirsContentHash: "xyz",
      }),
    ).toBe("escalate");
  });

  it("escalates when neither side changed contentHash (ambiguous)", () => {
    expect(
      arbitrateByUpdatedAt({
        oursUpdatedAt: "2026-06-25T10:00:00Z",
        theirsUpdatedAt: "2026-06-25T10:00:00Z",
        baseContentHash: "abc",
        oursContentHash: "abc",
        theirsContentHash: "abc",
      }),
    ).toBe("escalate");
  });

  it("escalates when timestamps equal and no contentHash available", () => {
    expect(
      arbitrateByUpdatedAt({
        oursUpdatedAt: "2026-06-25T10:00:00Z",
        theirsUpdatedAt: "2026-06-25T10:00:00Z",
      }),
    ).toBe("escalate");
  });
});
