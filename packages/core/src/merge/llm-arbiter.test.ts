import { describe, it, expect, vi } from "vitest";
import {
  LlmArbiter,
  DEFAULT_LLM_CONFIDENCE_THRESHOLD,
  DEFAULT_LLM_TIMEOUT_MS,
  DEFAULT_LLM_MAX_OUTPUT_TOKENS,
} from "./llm-arbiter.js";
import type { LlmClient } from "../observability/necessity-evaluator.js";
import type { LlmMergeInput } from "./llm-contract.js";

/**
 * 构造一个最小可用的 LlmMergeInput fixture。
 * 测试用例只关心 fieldName/conflictType,base/ours/theirs 用简单字符串。
 */
function makeInput(overrides: Partial<LlmMergeInput> = {}): LlmMergeInput {
  return {
    conflictType: "engram_frontmatter",
    path: "engrams/AIOS/decision.md",
    fieldName: "domainTags",
    base: ["AIOS"],
    ours: ["AIOS", "performance"],
    theirs: ["AIOS", "security"],
    meta: {
      oursUpdatedAt: "2026-06-01T00:00:00Z",
      theirsUpdatedAt: "2026-06-02T00:00:00Z",
      oursUpdatedBy: "alice",
      theirsUpdatedBy: "bob",
    },
    ...overrides,
  };
}

/**
 * 创建一个 mock LlmClient,complete 返回值由参数决定。
 */
function makeLlmClient(raw: string): LlmClient & {
  complete: ReturnType<typeof vi.fn>;
} {
  return {
    complete: vi.fn().mockResolvedValue(raw),
  };
}

/**
 * 创建一个 mock AuditLog,记录所有 append 调用以便断言。
 */
function makeAuditLog() {
  const entries: Array<{ action: string; metadata: Record<string, unknown> }> =
    [];
  return {
    append: vi.fn(
      (e: { action: string; metadata: Record<string, unknown> }) => {
        entries.push(e);
      },
    ),
    entries,
  };
}

describe("LlmArbiter defaults", () => {
  it("exposes spec-defined default constants", () => {
    expect(DEFAULT_LLM_CONFIDENCE_THRESHOLD).toBe(0.7);
    expect(DEFAULT_LLM_TIMEOUT_MS).toBe(15_000);
    expect(DEFAULT_LLM_MAX_OUTPUT_TOKENS).toBe(200);
  });
});

describe("LlmArbiter.arbitrate — success path", () => {
  it("returns resolved verdict when LLM returns high-confidence merge", async () => {
    const raw = JSON.stringify({
      verdict: "merge",
      mergedValue: ["AIOS", "performance", "security"],
      rationale: "union of both tag sets",
      confidence: 0.9,
    });
    const client = makeLlmClient(raw);
    const arbiter = new LlmArbiter({ client });
    const result = await arbiter.arbitrate(makeInput());

    expect(result.verdict.kind).toBe("resolved");
    if (result.verdict.kind === "resolved") {
      expect(result.verdict.output.verdict).toBe("merge");
      expect(result.verdict.output.mergedValue).toEqual([
        "AIOS",
        "performance",
        "security",
      ]);
      expect(result.verdict.output.confidence).toBe(0.9);
    }
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.rawResponse).toBe(raw);
    expect(result.promptHash).toMatch(/^[0-9a-f]{12}$/);
  });

  it("passes default opts (maxTokens, temperature, timeoutMs) to client", async () => {
    const raw = JSON.stringify({
      verdict: "ours",
      rationale: "ok",
      confidence: 0.95,
    });
    const client = makeLlmClient(raw);
    const arbiter = new LlmArbiter({ client });
    await arbiter.arbitrate(makeInput());

    expect(client.complete).toHaveBeenCalledOnce();
    const [, opts] = client.complete.mock.calls[0]!;
    expect(opts).toMatchObject({
      maxTokens: DEFAULT_LLM_MAX_OUTPUT_TOKENS,
      timeoutMs: DEFAULT_LLM_TIMEOUT_MS,
      temperature: 0.1,
    });
  });

  it("respects custom confidenceThreshold", async () => {
    const raw = JSON.stringify({
      verdict: "ours",
      rationale: "ok",
      confidence: 0.65,
    });
    const client = makeLlmClient(raw);
    const arbiter = new LlmArbiter({ client, confidenceThreshold: 0.5 });
    const result = await arbiter.arbitrate(makeInput());
    expect(result.verdict.kind).toBe("resolved");
  });

  it("respects custom maxOutputTokens / timeoutMs / temperature", async () => {
    const raw = JSON.stringify({
      verdict: "ours",
      rationale: "ok",
      confidence: 0.9,
    });
    const client = makeLlmClient(raw);
    const arbiter = new LlmArbiter({
      client,
      maxOutputTokens: 500,
      timeoutMs: 30_000,
      temperature: 0,
    });
    await arbiter.arbitrate(makeInput());
    const [, opts] = client.complete.mock.calls[0]!;
    expect(opts).toMatchObject({
      maxTokens: 500,
      timeoutMs: 30_000,
      temperature: 0,
    });
  });

  it("audit logs merge_llm_arbitrated on success", async () => {
    const raw = JSON.stringify({
      verdict: "ours",
      rationale: "ok",
      confidence: 0.9,
    });
    const client = makeLlmClient(raw);
    const audit = makeAuditLog();
    const arbiter = new LlmArbiter({
      client,
      auditLog: audit as unknown as never,
      providerName: "anthropic",
    });
    await arbiter.arbitrate(makeInput());

    expect(audit.append).toHaveBeenCalledOnce();
    const entry = audit.entries[0]!;
    expect(entry.action).toBe("merge_llm_arbitrated");
    expect(entry.metadata.provider).toBe("anthropic");
    expect(entry.metadata.path).toBe("engrams/AIOS/decision.md");
    expect(entry.metadata.conflictType).toBe("engram_frontmatter");
    expect(entry.metadata.verdict).toBe("ours");
    expect(entry.metadata.confidence).toBe(0.9);
    expect(entry.metadata.latencyMs).toBeGreaterThanOrEqual(0);
    expect(entry.metadata.promptHash).toMatch(/^[0-9a-f]{12}$/);
    expect(entry.metadata.escalated).toBeUndefined();
  });
});

describe("LlmArbiter.arbitrate — escalation paths", () => {
  it("escalates with llm_call_failed when client throws", async () => {
    const client: LlmClient = {
      complete: vi.fn().mockRejectedValue(new Error("network timeout")),
    };
    const audit = makeAuditLog();
    const arbiter = new LlmArbiter({
      client,
      auditLog: audit as unknown as never,
    });
    const result = await arbiter.arbitrate(makeInput());

    expect(result.verdict).toEqual({
      kind: "escalated",
      reason: "llm_call_failed",
    });
    expect(result.promptHash).toMatch(/^[0-9a-f]{12}$/);
    expect(result.rawResponse).toBeUndefined();

    expect(audit.append).toHaveBeenCalledOnce();
    const entry = audit.entries[0]!;
    expect(entry.action).toBe("merge_llm_arbitrated_failed");
    expect(entry.metadata.error).toContain("network timeout");
    expect(entry.metadata.provider).toBeUndefined();
  });

  it("escalates with llm_call_failed for non-Error thrown values", async () => {
    const client: LlmClient = {
      complete: vi.fn().mockRejectedValue("string error"),
    };
    const arbiter = new LlmArbiter({ client });
    const result = await arbiter.arbitrate(makeInput());
    expect(result.verdict).toEqual({
      kind: "escalated",
      reason: "llm_call_failed",
    });
  });

  it("escalates with parse_failed on empty response", async () => {
    const client = makeLlmClient("");
    const arbiter = new LlmArbiter({ client });
    const result = await arbiter.arbitrate(makeInput());
    expect(result.verdict.kind).toBe("escalated");
    if (result.verdict.kind === "escalated") {
      expect(result.verdict.reason).toBe("parse_failed");
    }
    expect(result.rawResponse).toBe("");
    expect(result.parseFailure).toBeDefined();
    if (result.parseFailure) {
      expect(result.parseFailure.ok).toBe(false);
      expect(result.parseFailure.reason).toBe("empty_response");
    }
  });

  it("escalates with parse_failed on invalid JSON", async () => {
    const client = makeLlmClient("not json at all");
    const audit = makeAuditLog();
    const arbiter = new LlmArbiter({
      client,
      auditLog: audit as unknown as never,
    });
    const result = await arbiter.arbitrate(makeInput());

    expect(result.verdict.kind).toBe("escalated");
    if (result.verdict.kind === "escalated") {
      expect(result.verdict.reason).toBe("parse_failed");
    }
    const entry = audit.entries[0]!;
    expect(entry.action).toBe("merge_llm_arbitrated_failed");
    expect(entry.metadata.error).toContain("parse_failed");
    expect(entry.metadata.rawResponseLength).toBe("not json at all".length);
  });

  it("escalates with parse_failed on missing verdict field", async () => {
    const client = makeLlmClient(
      JSON.stringify({ rationale: "ok", confidence: 0.9 }),
    );
    const arbiter = new LlmArbiter({ client });
    const result = await arbiter.arbitrate(makeInput());
    expect(result.verdict).toEqual({
      kind: "escalated",
      reason: "parse_failed",
    });
    expect(result.parseFailure?.reason).toBe("missing_verdict");
  });

  it("escalates with verdict_escalate when LLM chooses escalate", async () => {
    const raw = JSON.stringify({
      verdict: "escalate",
      rationale: "ambiguous context",
      confidence: 0.4,
    });
    const client = makeLlmClient(raw);
    const audit = makeAuditLog();
    const arbiter = new LlmArbiter({
      client,
      auditLog: audit as unknown as never,
    });
    const result = await arbiter.arbitrate(makeInput());

    expect(result.verdict).toEqual({
      kind: "escalated",
      reason: "verdict_escalate",
    });
    expect(result.rawResponse).toBe(raw);
    expect(audit.append).toHaveBeenCalledOnce();
    const entry = audit.entries[0]!;
    expect(entry.action).toBe("merge_llm_arbitrated_escalated");
    expect(entry.metadata.verdict).toBe("escalate");
    expect(entry.metadata.escalated).toBe(true);
    expect(entry.metadata.lowConfidence).toBeUndefined();
  });

  it("escalates with low_confidence when below default threshold (0.7)", async () => {
    const raw = JSON.stringify({
      verdict: "ours",
      rationale: "guess",
      confidence: 0.69,
    });
    const client = makeLlmClient(raw);
    const audit = makeAuditLog();
    const arbiter = new LlmArbiter({
      client,
      auditLog: audit as unknown as never,
    });
    const result = await arbiter.arbitrate(makeInput());

    expect(result.verdict).toEqual({
      kind: "escalated",
      reason: "low_confidence",
    });
    const entry = audit.entries[0]!;
    expect(entry.action).toBe("merge_llm_arbitrated_escalated");
    expect(entry.metadata.lowConfidence).toBe(true);
    expect(entry.metadata.escalated).toBe(true);
  });

  it("escalates with low_confidence at confidence=0", async () => {
    const raw = JSON.stringify({
      verdict: "merge",
      mergedValue: "x",
      rationale: "no idea",
      confidence: 0,
    });
    const client = makeLlmClient(raw);
    const arbiter = new LlmArbiter({ client });
    const result = await arbiter.arbitrate(makeInput());
    expect(result.verdict.kind).toBe("escalated");
    if (result.verdict.kind === "escalated") {
      expect(result.verdict.reason).toBe("low_confidence");
    }
  });

  it("succeeds at exactly confidence === threshold (boundary)", async () => {
    const raw = JSON.stringify({
      verdict: "ours",
      rationale: "ok",
      confidence: 0.7,
    });
    const client = makeLlmClient(raw);
    const arbiter = new LlmArbiter({ client });
    const result = await arbiter.arbitrate(makeInput());
    expect(result.verdict.kind).toBe("resolved");
  });

  it("respects custom confidenceThreshold = 0.9 (stricter)", async () => {
    const raw = JSON.stringify({
      verdict: "ours",
      rationale: "ok",
      confidence: 0.75,
    });
    const client = makeLlmClient(raw);
    const arbiter = new LlmArbiter({ client, confidenceThreshold: 0.9 });
    const result = await arbiter.arbitrate(makeInput());
    expect(result.verdict.kind).toBe("escalated");
    if (result.verdict.kind === "escalated") {
      expect(result.verdict.reason).toBe("low_confidence");
    }
  });

  it("escalates with low_confidence when verdict=merge but confidence low (even though merge requires mergedValue)", async () => {
    const raw = JSON.stringify({
      verdict: "merge",
      mergedValue: { combined: true },
      rationale: "best effort merge",
      confidence: 0.5,
    });
    const client = makeLlmClient(raw);
    const arbiter = new LlmArbiter({ client });
    const result = await arbiter.arbitrate(makeInput());
    expect(result.verdict.kind).toBe("escalated");
    if (result.verdict.kind === "escalated") {
      expect(result.verdict.reason).toBe("low_confidence");
    }
  });
});

describe("LlmArbiter — audit invariants", () => {
  it("does not call audit when auditLog is absent (success)", async () => {
    const raw = JSON.stringify({
      verdict: "ours",
      rationale: "ok",
      confidence: 0.9,
    });
    const client = makeLlmClient(raw);
    const arbiter = new LlmArbiter({ client });
    await arbiter.arbitrate(makeInput());
    // No assertion needed — the call should just not throw.
  });

  it("does not call audit when auditLog is absent (failure)", async () => {
    const client: LlmClient = {
      complete: vi.fn().mockRejectedValue(new Error("boom")),
    };
    const arbiter = new LlmArbiter({ client });
    const result = await arbiter.arbitrate(makeInput());
    expect(result.verdict.kind).toBe("escalated");
  });

  it("promptHash is stable for identical prompts", async () => {
    const raw = JSON.stringify({
      verdict: "ours",
      rationale: "ok",
      confidence: 0.9,
    });
    const client = makeLlmClient(raw);
    const arbiter = new LlmArbiter({ client });
    const r1 = await arbiter.arbitrate(makeInput());
    const r2 = await arbiter.arbitrate(makeInput());
    expect(r1.promptHash).toBe(r2.promptHash);
  });

  it("promptHash differs when input differs", async () => {
    const raw = JSON.stringify({
      verdict: "ours",
      rationale: "ok",
      confidence: 0.9,
    });
    const client = makeLlmClient(raw);
    const arbiter = new LlmArbiter({ client });
    const r1 = await arbiter.arbitrate(makeInput());
    const r2 = await arbiter.arbitrate(
      makeInput({ fieldName: "differentField" }),
    );
    expect(r1.promptHash).not.toBe(r2.promptHash);
  });

  it("records providerName in failure audit when configured", async () => {
    const client: LlmClient = {
      complete: vi.fn().mockRejectedValue(new Error("rate limited")),
    };
    const audit = makeAuditLog();
    const arbiter = new LlmArbiter({
      client,
      auditLog: audit as unknown as never,
      providerName: "openai-compatible",
    });
    await arbiter.arbitrate(makeInput());
    const entry = audit.entries[0]!;
    expect(entry.metadata.provider).toBe("openai-compatible");
  });
});
