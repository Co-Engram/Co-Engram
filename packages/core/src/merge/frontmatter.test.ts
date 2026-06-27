import { describe, it, expect, vi } from "vitest";
import type { EngramFrontmatter } from "../storage/engram-store.js";
import { mergeFrontmatter, mergeFrontmatterAsync } from "./frontmatter.js";
import { LlmArbiter } from "./llm-arbiter.js";
import type { LlmClient } from "../observability/necessity-evaluator.js";
import type { LlmMergeOutput } from "./llm-contract.js";

function makeFrontmatter(
  overrides: Partial<EngramFrontmatter>,
): EngramFrontmatter {
  return {
    id: "01HXXX",
    title: "base title",
    kind: "observation",
    createdBy: "user-a",
    createdAt: "2026-01-01T00:00:00Z",
    updatedBy: "user-a",
    updatedAt: "2026-01-01T00:00:00Z",
    version: 1,
    domainTags: ["AIOS"],
    ...overrides,
  } as EngramFrontmatter;
}

describe("mergeFrontmatter", () => {
  it("additive-merges retrievalCount from both sides", () => {
    const base = makeFrontmatter({ retrievalCount: 5 });
    const ours = makeFrontmatter({
      retrievalCount: 7,
      updatedAt: "2026-06-01T00:00:00Z",
    });
    const theirs = makeFrontmatter({
      retrievalCount: 6,
      updatedAt: "2026-06-02T00:00:00Z",
    });

    const outcome = mergeFrontmatter({ base, ours, theirs });

    expect(outcome.merged.retrievalCount).toBe(8); // 5 + (7-5) + (6-5)
  });

  it("max-merges updatedAt and version", () => {
    const base = makeFrontmatter({ version: 3 });
    const ours = makeFrontmatter({
      version: 4,
      updatedAt: "2026-06-01T00:00:00Z",
    });
    const theirs = makeFrontmatter({
      version: 5,
      updatedAt: "2026-06-02T00:00:00Z",
    });

    const outcome = mergeFrontmatter({ base, ours, theirs });

    expect(outcome.merged.version).toBe(5);
    expect(outcome.merged.updatedAt).toBe("2026-06-02T00:00:00Z");
  });

  it("arbitrates title by updatedAt when both sides changed", () => {
    const base = makeFrontmatter({
      title: "base",
      updatedAt: "2026-06-01T00:00:00Z",
    });
    const ours = makeFrontmatter({
      title: "ours-title",
      updatedAt: "2026-06-02T00:00:00Z",
    });
    const theirs = makeFrontmatter({
      title: "theirs-title",
      updatedAt: "2026-06-03T00:00:00Z",
    });

    const outcome = mergeFrontmatter({ base, ours, theirs });

    expect(outcome.merged.title).toBe("theirs-title");
    expect(outcome.arbitratedWinner).toBe("theirs");
    expect(outcome.escalatedFields).toEqual([]);
  });

  it("escalates when updatedAt collides and both sides changed", () => {
    const base = makeFrontmatter({
      title: "base",
      contentHash: "abc",
      updatedAt: "2026-06-01T00:00:00Z",
    });
    const ours = makeFrontmatter({
      title: "ours-title",
      contentHash: "def",
      updatedAt: "2026-06-01T00:00:00Z",
    });
    const theirs = makeFrontmatter({
      title: "theirs-title",
      contentHash: "xyz",
      updatedAt: "2026-06-01T00:00:00Z",
    });

    const outcome = mergeFrontmatter({ base, ours, theirs });

    expect(outcome.escalatedFields).toContain("title");
    expect(outcome.arbitratedWinner).toBeNull();
  });

  it("drops legacy_derived fields", () => {
    const base = makeFrontmatter({
      outgoingSynapseCount: 3,
    } as Partial<EngramFrontmatter>);
    const ours = makeFrontmatter({
      outgoingSynapseCount: 4,
    } as Partial<EngramFrontmatter>);
    const theirs = makeFrontmatter({
      outgoingSynapseCount: 5,
    } as Partial<EngramFrontmatter>);

    const outcome = mergeFrontmatter({ base, ours, theirs });

    expect(outcome.merged.outgoingSynapseCount).toBeUndefined();
  });

  it("escalates when ours changes an immutable field", () => {
    const base = makeFrontmatter({});
    const ours = makeFrontmatter({
      id: "01HYYY",
    } as Partial<EngramFrontmatter>);
    const theirs = makeFrontmatter({});

    const outcome = mergeFrontmatter({ base, ours, theirs });

    expect(outcome.escalatedFields).toContain("id");
    expect(outcome.merged.id).toBe("01HXXX"); // base value preserved
  });

  it("excludes contentHash and contentSize from merged (recomputed later)", () => {
    const base = makeFrontmatter({
      contentHash: "abc",
      contentSize: 100,
    } as Partial<EngramFrontmatter>);
    const ours = makeFrontmatter({
      contentHash: "def",
      contentSize: 110,
    } as Partial<EngramFrontmatter>);
    const theirs = makeFrontmatter({
      contentHash: "xyz",
      contentSize: 120,
    } as Partial<EngramFrontmatter>);

    const outcome = mergeFrontmatter({ base, ours, theirs });

    expect(outcome.merged.contentHash).toBeUndefined();
    expect(outcome.merged.contentSize).toBeUndefined();
  });

  it("produces a human-readable strategy string", () => {
    const base = makeFrontmatter({ retrievalCount: 5 });
    const ours = makeFrontmatter({
      retrievalCount: 7,
      updatedAt: "2026-06-01T00:00:00Z",
    });
    const theirs = makeFrontmatter({
      retrievalCount: 6,
      updatedAt: "2026-06-02T00:00:00Z",
    });

    const outcome = mergeFrontmatter({ base, ours, theirs });

    expect(outcome.strategy).toMatch(/^frontmatter:/);
    expect(outcome.strategy).toContain("additive");
  });
});

/**
 * 构造一个 mock LlmClient,返回指定的 LlmMergeOutput 序列(用于多次调用)。
 */
function makeLlmClientReturning(...outputs: LlmMergeOutput[]): LlmClient {
  let i = 0;
  return {
    complete: vi.fn().mockImplementation(() => {
      const out = outputs[i] ?? outputs[outputs.length - 1];
      i++;
      return Promise.resolve(JSON.stringify(out));
    }),
  };
}

describe("mergeFrontmatterAsync (LLM Layer B)", () => {
  const meta = {
    oursUpdatedAt: "2026-06-01T00:00:00Z",
    theirsUpdatedAt: "2026-06-02T00:00:00Z",
    oursUpdatedBy: "alice",
    theirsUpdatedBy: "bob",
  };

  it("returns Layer A outcome unchanged when no field escalates", async () => {
    const client = makeLlmClientReturning({
      verdict: "ours",
      rationale: "x",
      confidence: 0.9,
    });
    const arbiter = new LlmArbiter({ client });
    const base = makeFrontmatter({ retrievalCount: 5 });
    const ours = makeFrontmatter({
      retrievalCount: 7,
      updatedAt: "2026-06-01T00:00:00Z",
    });
    const theirs = makeFrontmatter({
      retrievalCount: 6,
      updatedAt: "2026-06-02T00:00:00Z",
    });
    const outcome = await mergeFrontmatterAsync({
      base,
      ours,
      theirs,
      arbiter,
      path: "engrams/AIOS/x.md",
      meta,
    });
    expect(outcome.escalatedFields).toEqual([]);
    expect(client.complete).not.toHaveBeenCalled();
  });

  it("resolves escalated field via LLM verdict=merge", async () => {
    const client = makeLlmClientReturning({
      verdict: "merge",
      mergedValue: ["AIOS", "performance", "security"],
      rationale: "union of both tag sets",
      confidence: 0.9,
    });
    const arbiter = new LlmArbiter({ client });
    const base = makeFrontmatter({
      domainTags: ["AIOS"],
      updatedAt: "2026-06-01T00:00:00Z",
    });
    const ours = makeFrontmatter({
      domainTags: ["AIOS", "performance"],
      updatedAt: "2026-06-01T00:00:00Z",
    });
    const theirs = makeFrontmatter({
      domainTags: ["AIOS", "security"],
      updatedAt: "2026-06-01T00:00:00Z",
    });
    const outcome = await mergeFrontmatterAsync({
      base,
      ours,
      theirs,
      arbiter,
      path: "engrams/AIOS/d.md",
      meta,
    });
    expect(outcome.escalatedFields).toEqual([]);
    expect(outcome.merged.domainTags).toEqual([
      "AIOS",
      "performance",
      "security",
    ]);
    expect(outcome.strategy).toContain("llm");
  });

  it("resolves escalated field via LLM verdict=ours", async () => {
    const client = makeLlmClientReturning({
      verdict: "ours",
      rationale: "ours is correct",
      confidence: 0.85,
    });
    const arbiter = new LlmArbiter({ client });
    const base = makeFrontmatter({
      title: "base",
      updatedAt: "2026-06-01T00:00:00Z",
    });
    const ours = makeFrontmatter({
      title: "ours-title",
      updatedAt: "2026-06-01T00:00:00Z",
    });
    const theirs = makeFrontmatter({
      title: "theirs-title",
      updatedAt: "2026-06-01T00:00:00Z",
    });
    const outcome = await mergeFrontmatterAsync({
      base,
      ours,
      theirs,
      arbiter,
      path: "engrams/x.md",
      meta,
    });
    expect(outcome.escalatedFields).toEqual([]);
    expect(outcome.merged.title).toBe("ours-title");
  });

  it("preserves escalate when LLM returns escalate (low confidence)", async () => {
    const client = makeLlmClientReturning({
      verdict: "ours",
      rationale: "guess",
      confidence: 0.3,
    });
    const arbiter = new LlmArbiter({ client });
    const base = makeFrontmatter({
      title: "base",
      updatedAt: "2026-06-01T00:00:00Z",
    });
    const ours = makeFrontmatter({
      title: "ours",
      updatedAt: "2026-06-01T00:00:00Z",
    });
    const theirs = makeFrontmatter({
      title: "theirs",
      updatedAt: "2026-06-01T00:00:00Z",
    });
    const outcome = await mergeFrontmatterAsync({
      base,
      ours,
      theirs,
      arbiter,
      path: "engrams/x.md",
      meta,
    });
    expect(outcome.escalatedFields).toContain("title");
  });

  it("preserves escalate when LLM call fails", async () => {
    const client: LlmClient = {
      complete: vi.fn().mockRejectedValue(new Error("network down")),
    };
    const arbiter = new LlmArbiter({ client });
    const base = makeFrontmatter({
      title: "base",
      updatedAt: "2026-06-01T00:00:00Z",
    });
    const ours = makeFrontmatter({
      title: "ours",
      updatedAt: "2026-06-01T00:00:00Z",
    });
    const theirs = makeFrontmatter({
      title: "theirs",
      updatedAt: "2026-06-01T00:00:00Z",
    });
    const outcome = await mergeFrontmatterAsync({
      base,
      ours,
      theirs,
      arbiter,
      path: "engrams/x.md",
      meta,
    });
    expect(outcome.escalatedFields).toContain("title");
  });

  it("partially resolves multiple escalated fields", async () => {
    // 2 escalate 字段:第一个 LLM 解决,第二个 LLM escalate
    const client: LlmClient = {
      complete: vi
        .fn()
        .mockResolvedValueOnce(
          JSON.stringify({
            verdict: "merge",
            mergedValue: ["a", "b"],
            rationale: "union",
            confidence: 0.9,
          }),
        )
        .mockResolvedValueOnce(
          JSON.stringify({
            verdict: "ours",
            rationale: "low conf",
            confidence: 0.3,
          }),
        ),
    };
    const arbiter = new LlmArbiter({ client });
    const base = makeFrontmatter({
      title: "base",
      domainTags: ["x"],
      updatedAt: "2026-06-01T00:00:00Z",
    } as Partial<EngramFrontmatter>);
    const ours = makeFrontmatter({
      title: "ours",
      domainTags: ["a"],
      updatedAt: "2026-06-01T00:00:00Z",
    } as Partial<EngramFrontmatter>);
    const theirs = makeFrontmatter({
      title: "theirs",
      domainTags: ["b"],
      updatedAt: "2026-06-01T00:00:00Z",
    } as Partial<EngramFrontmatter>);
    const outcome = await mergeFrontmatterAsync({
      base,
      ours,
      theirs,
      arbiter,
      path: "engrams/x.md",
      meta,
    });
    // One of the two should still escalate; the other should be resolved.
    expect(outcome.escalatedFields.length).toBe(1);
    expect(client.complete).toHaveBeenCalledTimes(2);
  });
});
