import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngramRepository } from "../src/storage/repository.js";
import { closeLearningLoop } from "../src/learning/loop.js";

let tmpDir: string;
let repo: EngramRepository;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-learning-"));
  repo = new EngramRepository({ rootPath: tmpDir });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeEngram(input: {
  title?: string;
  importance?: number;
  createdBy?: string;
}) {
  return repo.createEngram({
    title: input.title ?? "A",
    content: "a",
    kind: "observation",
    domainTags: ["t"],
    createdBy: input.createdBy ?? "y",
    importance: input.importance ?? 0.5,
  });
}

function link(
  fromId: string,
  toId: string,
  kind: "similar_to" | "contradicts" | "derives_from" = "similar_to",
): void {
  repo.addOutgoingSynapse(fromId, {
    id: `s-${fromId}-${toId}`,
    from: fromId,
    to: toId,
    kind,
    weight: 0.5,
    direction: "directional",
    evidence: [],
    createdBy: "y",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    retrievalWeight: 0.5,
  });
}

// ============================================================
// success outcome
// ============================================================

describe("closeLearningLoop > success", () => {
  it("LTP 强化 importance", () => {
    const e = makeEngram({ importance: 0.5 });
    const before = repo.readEngram(e.id).importance;
    const result = closeLearningLoop(repo, {
      engramId: e.id,
      outcome: "success",
      reportedBy: "agent",
    });
    expect(result.importanceDelta).toBeGreaterThan(0);
    expect(result.importance).toBeGreaterThan(before);
    expect(result.effectiveRetrievals).toBe(1);
    expect(result.failedUses).toBe(0);
  });

  it("success 默认 effectiveness=1", () => {
    const e = makeEngram({ importance: 0.5 });
    const result = closeLearningLoop(repo, {
      engramId: e.id,
      outcome: "success",
      reportedBy: "agent",
    });
    // D1: effectiveness=1 → importanceDelta = dynamics.updateOnReinforce(0.5,1) - 0.5 = 0.1
    expect(result.importanceDelta).toBeCloseTo(0.1, 5);
  });

  it("Hebbian 邻居被强化", () => {
    const a = makeEngram({ title: "A" });
    const b = makeEngram({ title: "B" });
    link(a.id, b.id, "similar_to");
    const result = closeLearningLoop(repo, {
      engramId: a.id,
      outcome: "success",
      reportedBy: "agent",
    });
    expect(result.hebbianReinforcement.triggered).toBe(true);
    expect(result.hebbianReinforcement.reinforcedNeighborIds).toContain(b.id);
    // b 的 importance 也提升
    const bAfter = repo.readEngram(b.id).importance;
    expect(bAfter).toBeGreaterThan(0.5);
  });

  it("Hebbian 跳过 contradicts 邻居", () => {
    const a = makeEngram({ title: "A" });
    const c = makeEngram({ title: "C" });
    link(a.id, c.id, "contradicts");
    const result = closeLearningLoop(repo, {
      engramId: a.id,
      outcome: "success",
      reportedBy: "agent",
    });
    expect(result.hebbianReinforcement.reinforcedNeighborIds).not.toContain(
      c.id,
    );
    expect(result.hebbianReinforcement.skipped).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================
// partial outcome
// ============================================================

describe("closeLearningLoop > partial", () => {
  it("effectiveness 必填，默认 0.5", () => {
    const e = makeEngram({ importance: 0.5 });
    const result = closeLearningLoop(repo, {
      engramId: e.id,
      outcome: "partial",
      reportedBy: "agent",
    });
    expect(result.importanceDelta).toBeCloseTo(0.05, 5); // D1: 0.5 × dynamics.LTP_GAIN(0.1)
  });

  it("自定义 effectiveness", () => {
    const e = makeEngram({ importance: 0.5 });
    const result = closeLearningLoop(repo, {
      engramId: e.id,
      outcome: "partial",
      effectiveness: 0.3,
      reportedBy: "agent",
    });
    expect(result.importanceDelta).toBeCloseTo(0.03, 5); // D1: 0.3 × dynamics.LTP_GAIN(0.1)
  });

  it("partial 也触发 Hebbian", () => {
    const a = makeEngram({ title: "A" });
    const b = makeEngram({ title: "B" });
    link(a.id, b.id);
    const result = closeLearningLoop(repo, {
      engramId: a.id,
      outcome: "partial",
      effectiveness: 0.5,
      reportedBy: "agent",
    });
    expect(result.hebbianReinforcement.triggered).toBe(true);
  });
});

// ============================================================
// failure outcome
// ============================================================

describe("closeLearningLoop > failure", () => {
  it("LTD 削弱 importance", () => {
    const e = makeEngram({ importance: 0.5 });
    const before = repo.readEngram(e.id).importance;
    const result = closeLearningLoop(repo, {
      engramId: e.id,
      outcome: "failure",
      reason: "内容过时",
      reportedBy: "agent",
    });
    expect(result.importanceDelta).toBeLessThan(0);
    expect(result.importance).toBeLessThan(before);
    expect(result.failedUses).toBe(1);
    expect(result.effectiveRetrievals).toBe(0);
  });

  it("failure 不触发 Hebbian（避免反向放大）", () => {
    const a = makeEngram({ title: "A" });
    const b = makeEngram({ title: "B" });
    link(a.id, b.id);
    const beforeB = repo.readEngram(b.id).importance;
    const result = closeLearningLoop(repo, {
      engramId: a.id,
      outcome: "failure",
      reportedBy: "agent",
    });
    expect(result.hebbianReinforcement.triggered).toBe(false);
    expect(result.hebbianReinforcement.reinforcedNeighborIds).toEqual([]);
    // b 的 importance 没变
    expect(repo.readEngram(b.id).importance).toBe(beforeB);
  });

  it("failure 累积触发 shouldArchive", () => {
    const e = makeEngram({ title: "A" });
    // 连续失败 3 次
    for (let i = 0; i < 3; i++) {
      closeLearningLoop(repo, {
        engramId: e.id,
        outcome: "failure",
        reportedBy: "agent",
      });
    }
    const result = closeLearningLoop(repo, {
      engramId: e.id,
      outcome: "failure",
      reportedBy: "agent",
    });
    expect(result.failedUses).toBeGreaterThanOrEqual(3);
    // archiveThreshold 默认 3，第四次失败 shouldArchive=true
    expect(result.shouldArchive).toBe(true);
  });

  it("failure 高累积触发 shouldForget", () => {
    const e = makeEngram({ title: "A" });
    for (let i = 0; i < 5; i++) {
      closeLearningLoop(repo, {
        engramId: e.id,
        outcome: "failure",
        reportedBy: "agent",
      });
    }
    const result = closeLearningLoop(repo, {
      engramId: e.id,
      outcome: "failure",
      reportedBy: "agent",
    });
    expect(result.shouldForget).toBe(true);
  });
});

// ============================================================
// Provenance 回调
// ============================================================

describe("closeLearningLoop > provenance callback", () => {
  it("未配置 → triggered=false", () => {
    const e = makeEngram({});
    const result = closeLearningLoop(repo, {
      engramId: e.id,
      outcome: "success",
      reportedBy: "agent",
    });
    expect(result.provenanceUpdate.triggered).toBe(false);
    expect(result.provenanceUpdate.message).toMatch(/not configured/);
  });

  it("配置 onProvenanceUpdate → 触发", () => {
    const e = makeEngram({});
    const calls: Array<{ id: string; outcome: string; eff: number }> = [];
    const result = closeLearningLoop(
      repo,
      {
        engramId: e.id,
        outcome: "success",
        reportedBy: "agent",
      },
      {
        onProvenanceUpdate: (id, outcome, eff) => {
          calls.push({ id, outcome, eff: eff });
        },
      },
    );
    expect(result.provenanceUpdate.triggered).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0]!.id).toBe(e.id);
    expect(calls[0]!.outcome).toBe("success");
    expect(calls[0]!.eff).toBe(1);
  });

  it("failure 也触发 provenance（penalty 信号）", () => {
    const e = makeEngram({});
    const calls: Array<{ outcome: string }> = [];
    closeLearningLoop(
      repo,
      {
        engramId: e.id,
        outcome: "failure",
        reportedBy: "agent",
      },
      {
        onProvenanceUpdate: (_id, outcome) => calls.push({ outcome }),
      },
    );
    expect(calls[0]!.outcome).toBe("failure");
  });
});

// ============================================================
// 错误处理
// ============================================================

describe("closeLearningLoop > errors", () => {
  it("engram 不存在 → 抛错", () => {
    expect(() =>
      closeLearningLoop(repo, {
        engramId: "no/such",
        outcome: "success",
        reportedBy: "agent",
      }),
    ).toThrow(/not found/);
  });

  it("effectiveness 越界 → 抛错", () => {
    const e = makeEngram({});
    expect(() =>
      closeLearningLoop(repo, {
        engramId: e.id,
        outcome: "success",
        effectiveness: 1.5,
        reportedBy: "agent",
      }),
    ).toThrow(/\[0,1\]/);
  });
});

// ============================================================
// spec 验收：所有相关字段准确更新
// ============================================================

describe("spec 验收：闭合学习回路", () => {
  it("success 后：importance/reinforcement/effectiveRetrievals 全部更新", () => {
    const e = makeEngram({ importance: 0.5 });
    const before = repo.readEngram(e.id);
    expect(before.reinforcementScore).toBe(0);
    expect(before.effectiveRetrievals).toBe(0);
    expect(before.lastEffectiveAt).toBeUndefined();

    const result = closeLearningLoop(repo, {
      engramId: e.id,
      outcome: "success",
      effectiveness: 0.8,
      reportedBy: "agent",
    });

    const after = repo.readEngram(e.id);
    expect(after.importance).toBeGreaterThan(before.importance);
    expect(after.reinforcementScore).toBe(0.8);
    expect(after.effectiveRetrievals).toBe(1);
    expect(after.lastEffectiveAt).toBeDefined();
    expect(result.importanceDelta).toBeCloseTo(0.08, 5); // D1: 0.8 × dynamics.LTP_GAIN(0.1)
  });

  it("failure 后：failedUses/retrievalCount 全部更新", () => {
    const e = makeEngram({ importance: 0.5 });
    const before = repo.readEngram(e.id);
    expect(before.failedUses).toBe(0);

    closeLearningLoop(repo, {
      engramId: e.id,
      outcome: "failure",
      reason: "test",
      reportedBy: "agent",
    });

    const after = repo.readEngram(e.id);
    expect(after.failedUses).toBe(1);
    expect(after.retrievalCount).toBe(1);
    expect(after.importance).toBeLessThan(before.importance);
  });

  it("端到端：创建 → 使用成功 → 强化邻居 → 反馈 provenance", () => {
    const a = makeEngram({ title: "核心" });
    const b = makeEngram({ title: "相关 1" });
    const c = makeEngram({ title: "相关 2" });
    link(a.id, b.id, "similar_to");
    link(a.id, c.id, "derives_from");

    const provenanceCalls: string[] = [];
    const result = closeLearningLoop(
      repo,
      {
        engramId: a.id,
        outcome: "success",
        effectiveness: 1,
        reportedBy: "agent",
      },
      {
        onProvenanceUpdate: (id) => provenanceCalls.push(id),
      },
    );

    expect(result.importanceDelta).toBeGreaterThan(0);
    expect(result.hebbianReinforcement.reinforcedNeighborIds).toContain(b.id);
    expect(result.hebbianReinforcement.reinforcedNeighborIds).toContain(c.id);
    expect(result.provenanceUpdate.triggered).toBe(true);
    expect(provenanceCalls).toEqual([a.id]);

    // b 和 c 的 importance 都应该提升
    expect(repo.readEngram(b.id).importance).toBeGreaterThan(0.5);
    expect(repo.readEngram(c.id).importance).toBeGreaterThan(0.5);
  });
});
