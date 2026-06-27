import { describe, it, expect, vi } from "vitest";
import { mergeContent, mergeContentAsync } from "./content.js";
import { LlmArbiter } from "./llm-arbiter.js";
import type { LlmClient } from "../observability/necessity-evaluator.js";

describe("mergeContent", () => {
  it("returns clean merge when git 3-way succeeds", () => {
    const base = "Paragraph 1\n\nParagraph 2\n";
    const ours = "Paragraph 1 edited\n\nParagraph 2\n";
    const theirs = "Paragraph 1\n\nParagraph 2\nNew paragraph 3\n";

    const outcome = mergeContent({
      base,
      ours,
      theirs,
      oursUpdatedAt: "2026-06-01T00:00:00Z",
      theirsUpdatedAt: "2026-06-02T00:00:00Z",
    });

    expect(outcome.strategy).toBe("git-3way-clean");
    expect(outcome.conflictMarkersPresent).toBe(false);
    expect(outcome.merged).toContain("Paragraph 1 edited");
    expect(outcome.merged).toContain("New paragraph 3");
  });

  it("falls back to theirs when both edited same paragraph and theirs is newer", () => {
    const base = "Original paragraph\n";
    const ours = "Our revision\n";
    const theirs = "Their revision\n";

    const outcome = mergeContent({
      base,
      ours,
      theirs,
      oursUpdatedAt: "2026-06-01T00:00:00Z",
      theirsUpdatedAt: "2026-06-02T00:00:00Z",
    });

    expect(outcome.strategy).toBe("updatedAt-fallback");
    expect(outcome.winner).toBe("theirs");
    expect(outcome.merged).toBe("Their revision\n");
    expect(outcome.conflictMarkersPresent).toBe(false);
  });

  it("falls back to ours when both edited same paragraph and ours is newer", () => {
    const base = "Original paragraph\n";
    const ours = "Our revision\n";
    const theirs = "Their revision\n";

    const outcome = mergeContent({
      base,
      ours,
      theirs,
      oursUpdatedAt: "2026-06-03T00:00:00Z",
      theirsUpdatedAt: "2026-06-02T00:00:00Z",
    });

    expect(outcome.strategy).toBe("updatedAt-fallback");
    expect(outcome.winner).toBe("ours");
    expect(outcome.merged).toBe("Our revision\n");
  });

  it("escalates when both edited same paragraph and updatedAt collides", () => {
    const base = "Original paragraph\n";
    const ours = "Our revision\n";
    const theirs = "Their revision\n";

    const outcome = mergeContent({
      base,
      ours,
      theirs,
      oursUpdatedAt: "2026-06-01T00:00:00Z",
      theirsUpdatedAt: "2026-06-01T00:00:00Z",
    });

    expect(outcome.strategy).toBe("escalate");
    expect(outcome.winner).toBeNull();
    expect(outcome.conflictMarkersPresent).toBe(true);
    expect(outcome.merged).toContain("<<<<<<<");
    expect(outcome.merged).toContain(">>>>>>>");
  });
});

describe("mergeContentAsync (LLM Layer B)", () => {
  function makeLlmClientReturning(raw: string): LlmClient {
    return { complete: vi.fn().mockResolvedValue(raw) };
  }

  const baseContent = "Original paragraph\n";
  const oursContent = "Our revision\n";
  const theirsContent = "Their revision\n";
  const collisionArgs = {
    base: baseContent,
    ours: oursContent,
    theirs: theirsContent,
    oursUpdatedAt: "2026-06-01T00:00:00Z",
    theirsUpdatedAt: "2026-06-01T00:00:00Z",
    path: "engrams/AIOS/x.md",
  };

  it("returns Layer A outcome when strategy != escalate", async () => {
    const client = makeLlmClientReturning(
      JSON.stringify({
        verdict: "merge",
        mergedValue: "irrelevant",
        rationale: "x",
        confidence: 0.9,
      }),
    );
    const arbiter = new LlmArbiter({ client });
    const outcome = await mergeContentAsync({
      ...collisionArgs,
      oursUpdatedAt: "2026-06-03T00:00:00Z", // theirs older → updatedAt-fallback
      theirsUpdatedAt: "2026-06-01T00:00:00Z",
      arbiter,
    });
    expect(outcome.strategy).toBe("updatedAt-fallback");
    expect(client.complete).not.toHaveBeenCalled();
  });

  it("resolves with merged value when LLM returns verdict=merge + string", async () => {
    const client = makeLlmClientReturning(
      JSON.stringify({
        verdict: "merge",
        mergedValue: "Combined paragraph including both revisions\n",
        rationale: "preserve both",
        confidence: 0.85,
      }),
    );
    const arbiter = new LlmArbiter({ client });
    const outcome = await mergeContentAsync({ ...collisionArgs, arbiter });
    expect(outcome.strategy).toBe("llm-resolved");
    expect(outcome.merged).toBe(
      "Combined paragraph including both revisions\n",
    );
    expect(outcome.conflictMarkersPresent).toBe(false);
    expect(outcome.winner).toBeNull();
  });

  it("resolves with ours when LLM returns verdict=ours", async () => {
    const client = makeLlmClientReturning(
      JSON.stringify({
        verdict: "ours",
        rationale: "ours is richer",
        confidence: 0.8,
      }),
    );
    const arbiter = new LlmArbiter({ client });
    const outcome = await mergeContentAsync({ ...collisionArgs, arbiter });
    expect(outcome.strategy).toBe("llm-resolved");
    expect(outcome.merged).toBe(oursContent);
    expect(outcome.winner).toBe("ours");
  });

  it("resolves with theirs when LLM returns verdict=theirs", async () => {
    const client = makeLlmClientReturning(
      JSON.stringify({
        verdict: "theirs",
        rationale: "theirs is correct",
        confidence: 0.8,
      }),
    );
    const arbiter = new LlmArbiter({ client });
    const outcome = await mergeContentAsync({ ...collisionArgs, arbiter });
    expect(outcome.strategy).toBe("llm-resolved");
    expect(outcome.merged).toBe(theirsContent);
    expect(outcome.winner).toBe("theirs");
  });

  it("falls back to escalate when LLM verdict=escalate", async () => {
    const client = makeLlmClientReturning(
      JSON.stringify({
        verdict: "escalate",
        rationale: "ambiguous",
        confidence: 0.3,
      }),
    );
    const arbiter = new LlmArbiter({ client });
    const outcome = await mergeContentAsync({ ...collisionArgs, arbiter });
    expect(outcome.strategy).toBe("escalate");
    expect(outcome.conflictMarkersPresent).toBe(true);
  });

  it("falls back to escalate when LLM confidence below threshold", async () => {
    const client = makeLlmClientReturning(
      JSON.stringify({
        verdict: "merge",
        mergedValue: "x",
        rationale: "guess",
        confidence: 0.4,
      }),
    );
    const arbiter = new LlmArbiter({ client });
    const outcome = await mergeContentAsync({ ...collisionArgs, arbiter });
    expect(outcome.strategy).toBe("escalate");
  });

  it("falls back to escalate when LLM call fails", async () => {
    const client: LlmClient = {
      complete: vi.fn().mockRejectedValue(new Error("network down")),
    };
    const arbiter = new LlmArbiter({ client });
    const outcome = await mergeContentAsync({ ...collisionArgs, arbiter });
    expect(outcome.strategy).toBe("escalate");
  });

  it("falls back to escalate when LLM merge verdict but mergedValue not string", async () => {
    const client = makeLlmClientReturning(
      JSON.stringify({
        verdict: "merge",
        mergedValue: { not: "a string" },
        rationale: "x",
        confidence: 0.9,
      }),
    );
    const arbiter = new LlmArbiter({ client });
    const outcome = await mergeContentAsync({ ...collisionArgs, arbiter });
    expect(outcome.strategy).toBe("escalate");
  });
});
