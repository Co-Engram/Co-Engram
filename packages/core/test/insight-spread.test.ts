import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EngramRepository } from "../src/storage/repository.js";
import type { Synapse } from "../src/types/synapse.js";
import {
  buildBaselineSubgraph,
  buildSubgraph,
} from "../src/maintenance/insight/spread.js";

let tmpDir: string;
let repo: EngramRepository;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-insight-spread-"));
  repo = new EngramRepository({ rootPath: tmpDir });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function make(title: string, domainTags: readonly string[] = ["t"], importance = 0.5) {
  return repo.createEngram({
    title,
    content: `content of ${title}`,
    kind: "fact",
    domainTags: [...domainTags],
    createdBy: "tester",
    importance,
  });
}

function link(from: string, to: string, weight = 0.8) {
  const ts = new Date().toISOString();
  const syn: Synapse = {
    id: randomUUID(),
    from,
    to,
    kind: "similar_to",
    weight,
    evidence: [],
    createdBy: "tester",
    createdAt: ts,
    updatedAt: ts,
    visibility: "public",
  };
  return repo.addOutgoingSynapse(from, syn);
}

/** lastRemAt 在未来 → 事件种子为空;只有 extraSeeds 生效(测试确定性手段) */
const FUTURE = new Date(Date.now() + 60_000).toISOString();
const PAST = new Date(Date.now() - 60_000).toISOString();

describe("buildSubgraph:种子收集", () => {
  it("新记忆(createdAt > lastRemAt)全部作为种子入子图", () => {
    const a = make("A");
    const b = make("B");
    const sub = buildSubgraph(repo, { lastRemAt: PAST, maxNodes: 30 });
    const ids = sub.nodes.map((n) => n.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    expect(sub.nodes.every((n) => n.isSeed)).toBe(true);
    expect(sub.globalStats.seedCount).toBe(2);
  });

  it("extraSeeds 绕过事件条件与 seedFilter(孵化语义)", () => {
    const a = make("A");
    make("B");
    const sub = buildSubgraph(repo, {
      lastRemAt: FUTURE, // 无事件
      maxNodes: 30,
      seedFilter: () => false, // 过滤掉一切事件种子
      extraSeeds: [a.id],
    });
    expect(sub.nodes).toHaveLength(1);
    expect(sub.nodes[0]!.id).toBe(a.id);
    expect(sub.nodes[0]!.isSeed).toBe(true);
  });

  it("seedFilter 约束事件种子(复盘:failedUses≥3)", () => {
    const normal = make("normal");
    const failing = make("failing");
    // 直接把 failedUses 写进 frontmatter 不可行;通过 failedUses 字段过滤需要真实 engram。
    // 这里用 title 模拟 seedFilter 的语义(过滤函数本身由模式模块提供)。
    const sub = buildSubgraph(repo, {
      lastRemAt: PAST,
      maxNodes: 30,
      seedFilter: (id) => id !== normal.id,
    });
    const ids = sub.nodes.map((n) => n.id);
    expect(ids).not.toContain(normal.id);
    expect(ids).toContain(failing.id);
  });

  it("无种子 → 空子图", () => {
    make("A");
    const sub = buildSubgraph(repo, { lastRemAt: FUTURE, maxNodes: 30 });
    expect(sub.nodes).toHaveLength(0);
    expect(sub.edges).toHaveLength(0);
  });
});

describe("buildSubgraph:扩散与剪枝", () => {
  it("一跳邻居经衰减入子图;二跳低激活被剪", () => {
    const seed = make("seed", ["t"], 0.9);
    const hop1n = make("hop1", ["t"], 0.5);
    const hop2n = make("hop2", ["t"], 0.5);
    link(seed.id, hop1n.id, 1.0); // hop1 act = seedAct×1×0.5
    link(hop1n.id, hop2n.id, 0.4); // hop2 act = hop1×0.4×0.25 = 0.05 < 0.1 → 剪
    const sub = buildSubgraph(repo, {
      lastRemAt: FUTURE,
      maxNodes: 30,
      extraSeeds: [seed.id],
    });
    const byTitle = new Map(sub.nodes.map((n) => [n.title, n]));
    expect(byTitle.has("seed")).toBe(true);
    expect(byTitle.has("hop1")).toBe(true);
    expect(byTitle.has("hop2")).toBe(false); // 激活 0.05 < minActivation 0.1
    expect(byTitle.get("hop1")!.isSeed).toBe(false);
    expect(byTitle.get("hop1")!.activation).toBeGreaterThan(0);
    // 子图内部边:seed—hop1 保留;hop1—hop2 因 hop2 不在子图被剪
    expect(sub.edges).toHaveLength(1);
  });

  it("maxNodes 截断:按 activation 排序保留,边只含两端都在子图的", () => {
    const seed = make("seed", ["t"], 0.9);
    const strong = make("strong", ["t"], 0.5);
    const weak = make("weak", ["t"], 0.5);
    link(seed.id, strong.id, 1.0); // hop1 = 0.5
    link(seed.id, weak.id, 0.5); // hop1 = 0.25
    link(strong.id, weak.id, 0.9);
    const sub = buildSubgraph(repo, {
      lastRemAt: FUTURE,
      maxNodes: 2, // seed + 一个邻居
      extraSeeds: [seed.id],
    });
    expect(sub.nodes).toHaveLength(2);
    const titles = sub.nodes.map((n) => n.title);
    expect(titles).toContain("seed");
    expect(titles).toContain("strong"); // 激活更高的邻居留下
    expect(sub.edges).toHaveLength(1); // seed—strong 保留;触到 weak 的两条边被剪
  });

  it("激活归一化:种子 importance×truth 与 activity 各自 min-max 后加权", () => {
    const hi = make("hi", ["t"], 0.95); // truth: unverified → 0.4 → 0.38
    const lo = make("lo", ["t"], 0.1); // 0.04
    const sub = buildSubgraph(repo, { lastRemAt: PAST, maxNodes: 30 });
    const byTitle = new Map(sub.nodes.map((n) => [n.title, n]));
    // 两个种子 activity 相同(都是新记忆=1)→ norm 全 0.5;imp norm: hi=1, lo=0
    expect(byTitle.get("hi")!.activation).toBeCloseTo(0.5 * 1 + 0.5 * 0.5, 5);
    expect(byTitle.get("lo")!.activation).toBeCloseTo(0.5 * 0 + 0.5 * 0.5, 5);
    expect(byTitle.get("hi")!.activation).toBeGreaterThan(
      byTitle.get("lo")!.activation,
    );
  });

  it("globalStats 含 topTags 与真值分布", () => {
    make("A", ["x", "y"]);
    make("B", ["x"]);
    const sub = buildSubgraph(repo, { lastRemAt: PAST, maxNodes: 30 });
    expect(String(sub.globalStats.topTags).startsWith("x")).toBe(true);
    expect(sub.globalStats.ver_unverified).toBe(2);
  });
});

describe("buildBaselineSubgraph(消融对照)", () => {
  it("与主路径同构:种子 + 1-hop 邻居,无二跳,可序列化对照", () => {
    const seed = make("seed", ["t"], 0.9);
    const hop1n = make("hop1", ["t"], 0.6);
    const hop2n = make("hop2", ["t"], 0.7);
    link(seed.id, hop1n.id, 1.0);
    link(hop1n.id, hop2n.id, 1.0);
    const base = buildBaselineSubgraph(repo, {
      lastRemAt: FUTURE,
      maxNodes: 30,
      extraSeeds: [seed.id],
    });
    const titles = base.nodes.map((n) => n.title);
    expect(titles).toContain("seed");
    expect(titles).toContain("hop1"); // 1-hop 邻居
    expect(titles).not.toContain("hop2"); // baseline 无二跳
    expect(base.globalStats.method).toBe("importance-baseline");
    // JSON 可序列化(对照数据落盘用)
    expect(() => JSON.stringify(base)).not.toThrow();
  });
});
