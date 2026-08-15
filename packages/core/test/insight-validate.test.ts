import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EngramRepository } from "../src/storage/repository.js";
import { buildSubgraph } from "../src/maintenance/insight/spread.js";
import { validateInsightDraft, type ProposalLike } from "../src/maintenance/insight/validate.js";
import type { InsightDraft, InsightSubgraph } from "../src/maintenance/insight/types.js";

let tmpDir: string;
let repo: EngramRepository;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-insight-validate-"));
  repo = new EngramRepository({ rootPath: tmpDir });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const PAST = new Date(Date.now() - 60_000).toISOString();

function make(title: string, domainTags: readonly string[], summaryish = true) {
  return repo.createEngram({
    title,
    content: summaryish ? `${title} specific content alpha beta gamma` : "x",
    kind: "fact",
    domainTags: [...domainTags],
    createdBy: "tester",
  });
}

function draft(over: Partial<InsightDraft> = {}): InsightDraft {
  return {
    mode: "integration",
    type: "theme",
    title: "跨情境主题",
    content: "共性结构说明",
    summary: "s",
    sourceIds: [],
    domainTags: ["t"],
    reason: "r",
    ...over,
  };
}

function subOf(ids: readonly string[]): InsightSubgraph {
  return buildSubgraph(repo, { lastRemAt: PAST, maxNodes: 30, extraSeeds: [...ids] });
}

describe("validateInsightDraft", () => {
  it("引用闭合:sourceIds ⊄ 子图 → reject;repo 不存在 → reject", () => {
    const a = make("A", ["域A"]);
    const b = make("B", ["域A"]);
    const sub = subOf([a.id, b.id]);
    const outside = make("C", ["域A"]); // 不在子图种子内?createdAt>PAST 会在……
    // C 也是新记忆,会作为事件种子入子图;改用不存在的 id 测子图外引用
    const r1 = validateInsightDraft(
      draft({ sourceIds: ["nonexistent-id"] }),
      sub,
      repo,
      [],
    );
    expect(r1).toEqual({ ok: false, reason: expect.stringContaining("not in input subgraph") });
  });

  it("结构完整:title/content/sourceIds 空 → reject", () => {
    const a = make("A", ["域A"]);
    const b = make("B", ["域A"]);
    const sub = subOf([a.id, b.id]);
    expect(validateInsightDraft(draft({ title: " ", sourceIds: [a.id, b.id] }), sub, repo, []).ok).toBe(false);
    expect(validateInsightDraft(draft({ content: " ", sourceIds: [a.id, b.id] }), sub, repo, []).ok).toBe(false);
    expect(validateInsightDraft(draft({ sourceIds: [] }), sub, repo, []).ok).toBe(false);
  });

  it("theme:单来源 → reject(跨情境性 ≥2 来源)", () => {
    const a = make("A", ["域A"]);
    const sub = subOf([a.id]);
    const r = validateInsightDraft(draft({ sourceIds: [a.id] }), sub, repo, []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("cross-contextuality");
  });

  it("lesson:AAR 四要素缺一即 reject;齐则 pass", () => {
    const a = make("A", ["域A"]);
    const b = make("B", ["域A"]);
    const sub = subOf([a.id, b.id]);
    const aar3 = { expected: "e", actual: "a", cause: "c" } as const;
    const r1 = validateInsightDraft(
      draft({ type: "lesson", mode: "retrospective", sourceIds: [a.id, b.id], aar: aar3 }),
      sub,
      repo,
      [],
    );
    expect(r1.ok).toBe(false);
    const r2 = validateInsightDraft(
      draft({
        type: "lesson",
        mode: "retrospective",
        sourceIds: [a.id, b.id],
        aar: { expected: "e", actual: "a", cause: "c", improvement: "i" },
      }),
      sub,
      repo,
      [],
    );
    expect(r2.ok).toBe(true);
  });

  it("analogy:两源域相交 → reject;只剩笼统标签 → reject;不相交且低 Jaccard → pass", () => {
    const a = make("源A", ["域甲", "imported"], true);
    // 让两源内容词面不同(title+summary Jaccard 低,结构映射才是联系)
    const b = repo.createEngram({
      title: "源B",
      content: "完全不同的内容:雷达扫描 蜂群编队 信号脱锁",
      kind: "fact",
      domainTags: ["域乙"],
      createdBy: "tester",
    });
    const c = make("源C", ["域甲", "域乙"]); // 与谁都相交
    const d = make("源D", ["uncategorized"]); // 只剩笼统标签
    // 相交
    const subAB = subOf([a.id, b.id]);
    const bad = make("bad", ["域甲"]);
    const r1 = validateInsightDraft(
      draft({ type: "analogy", mode: "inspiration", sourceIds: [a.id, bad.id] }),
      subOf([a.id, bad.id]),
      repo,
      [],
    );
    expect(r1.ok).toBe(false);
    void subAB;
    // 笼统标签
    const r2 = validateInsightDraft(
      draft({ type: "analogy", mode: "inspiration", sourceIds: [a.id, d.id] }),
      subOf([a.id, d.id]),
      repo,
      [],
    );
    expect(r2.ok).toBe(false);
    // 不相交 + 低表面相似 → pass
    const r3 = validateInsightDraft(
      draft({ type: "analogy", mode: "inspiration", sourceIds: [a.id, b.id] }),
      subOf([a.id, b.id]),
      repo,
      [],
    );
    expect(r3.ok).toBe(true);
    // 高表面相似(同词汇堆叠)→ reject
    const e1 = make("alpha beta gamma delta epsilon", ["域甲"]);
    const e2 = make("alpha beta gamma delta epsilon zeta", ["域乙"]);
    const r4 = validateInsightDraft(
      draft({ type: "analogy", mode: "inspiration", sourceIds: [e1.id, e2.id] }),
      subOf([e1.id, e2.id]),
      repo,
      [],
    );
    expect(r4.ok).toBe(false);
    void c;
  });

  it("hypothesis:无可证伪说明 → reject;含「若真/若假」→ pass", () => {
    const a = make("A", ["域A"]);
    const b = make("B", ["域A"]);
    const sub = subOf([a.id, b.id]);
    const r1 = validateInsightDraft(
      draft({ type: "hypothesis", sourceIds: [a.id, b.id], content: "某解释性假设,无证伪条件" }),
      sub,
      repo,
      [],
    );
    expect(r1.ok).toBe(false);
    const r2 = validateInsightDraft(
      draft({ type: "hypothesis", sourceIds: [a.id, b.id], content: "假设 H。若真应观察到 X;若假应观察到 Y" }),
      sub,
      repo,
      [],
    );
    expect(r2.ok).toBe(true);
  });

  it("查重:与已有 rem-insight 提案 Jaccard ≥ 0.65 → reject", () => {
    const a = make("A", ["域A"]);
    const b = make("B", ["域A"]);
    const sub = subOf([a.id, b.id]);
    const existing: readonly ProposalLike[] = [
      {
        source: "rem-insight",
        payload: { title: "跨情境主题", content: "共性结构说明 alpha beta" },
      },
    ];
    const r = validateInsightDraft(
      draft({ title: "跨情境主题", content: "共性结构说明 alpha beta gamma delta", sourceIds: [a.id, b.id] }),
      sub,
      repo,
      existing,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("existing rem-insight");
  });

  it("查重:与已有 pattern engram Jaccard ≥ 0.65 → reject", () => {
    const a = make("A", ["域A"]);
    const b = make("B", ["域A"]);
    repo.createEngram({
      title: "跨情境主题",
      content: "共性结构说明 alpha beta gamma delta",
      kind: "pattern",
      domainTags: ["t"],
      createdBy: "t",
    });
    const sub = subOf([a.id, b.id]);
    const r = validateInsightDraft(
      draft({ title: "跨情境主题", content: "共性结构说明 alpha beta gamma delta", sourceIds: [a.id, b.id] }),
      sub,
      repo,
      [],
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("pattern engram");
  });
});
