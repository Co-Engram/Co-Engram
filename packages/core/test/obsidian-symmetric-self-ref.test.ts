import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngramRepository } from "../src/storage/repository.js";
import { readEngramIndex } from "../src/storage/engram-index.js";

/**
 * Obsidian 派生段 — 对称 kind 自指回归(方案 A 连带修复)
 *
 * 背景:方案 A 让 listSynapsesForEngram 把对称 kind(similar_to/contradicts)
 * 双计入 outgoing + incoming。regenerateObsidianLinks 的 resolveTouching
 * 对 incoming 用 syn.from 解析 target——当 center 是对称边的 from 端时,
 * syn.from===center,target 解析成自己,产生 ← [[自己]] 自指 wikilink。
 *
 * 修复:resolveTouching 加 centerId 参数,过滤 s.to===center(outgoing 自指)
 * 与 s.from===center(incoming 自指)。对称边在每个端点只渲染一次(target=other)。
 */
describe("Obsidian 派生段 — 对称 kind 自指回归", () => {
  let dir: string;
  let repo: EngramRepository;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "obs-sym-"));
    repo = new EngramRepository({ rootPath: dir });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** 读 engram id 对应 .md 的派生段 wikilink target */
  function readDerivedTargets(id: string): {
    readonly outgoing: readonly string[];
    readonly incoming: readonly string[];
    readonly selfFile: string;
  } {
    const index = readEngramIndex(dir);
    const entry = index.entries.get(id as never)!;
    const selfFile = entry.path.split("/").pop()!.replace(/\.md$/i, "");
    const raw = readFileSync(join(dir, entry.path), "utf8");
    const outgoing = (raw.match(/- → \[\[([^\]|]+)/g) ?? []).map((m) =>
      m.replace(/- → \[\[/, ""),
    );
    const incoming = (raw.match(/- ← \[\[([^\]|]+)/g) ?? []).map((m) =>
      m.replace(/- ← \[\[/, ""),
    );
    return { outgoing, incoming, selfFile };
  }

  it("similar_to center=from:派生段只渲染 → other,无 ← [[自己]] 自指", () => {
    const a = repo.createEngram({
      title: "alpha",
      content: "c",
      kind: "fact",
      domainTags: ["x"],
      createdBy: "u",
    }).id;
    const b = repo.createEngram({
      title: "beta",
      content: "c",
      kind: "fact",
      domainTags: ["x"],
      createdBy: "u",
    }).id;
    repo.createSynapse({ from: a, to: b, kind: "similar_to", createdBy: "u" });

    const { outgoing, incoming, selfFile } = readDerivedTargets(a);
    // outgoing 指向 other(beta)
    expect(outgoing.some((t) => t.startsWith("beta"))).toBe(true);
    // 回归断言:对称边 center=from 的 incoming(自指)被过滤,应为空
    expect(incoming.length).toBe(0);
    // 显式:派生段不应出现 target=selfFile 的 wikilink
    expect([...outgoing, ...incoming]).not.toContain(selfFile);
  });

  it("similar_to center=to:派生段只渲染 ← other,无 → [[自己]] 自指", () => {
    const a = repo.createEngram({
      title: "alpha",
      content: "c",
      kind: "fact",
      domainTags: ["x"],
      createdBy: "u",
    }).id;
    const b = repo.createEngram({
      title: "beta",
      content: "c",
      kind: "fact",
      domainTags: ["x"],
      createdBy: "u",
    }).id;
    repo.createSynapse({ from: a, to: b, kind: "similar_to", createdBy: "u" });

    const { outgoing, incoming, selfFile } = readDerivedTargets(b);
    // incoming 指向 other(alpha)
    expect(incoming.some((t) => t.startsWith("alpha"))).toBe(true);
    // 回归断言:对称边 center=to 的 outgoing(自指)被过滤,应为空
    expect(outgoing.length).toBe(0);
    expect([...outgoing, ...incoming]).not.toContain(selfFile);
  });

  it("contradicts 对称:同样无自指", () => {
    const a = repo.createEngram({
      title: "alpha",
      content: "c",
      kind: "fact",
      domainTags: ["x"],
      createdBy: "u",
    }).id;
    const b = repo.createEngram({
      title: "beta",
      content: "c",
      kind: "fact",
      domainTags: ["x"],
      createdBy: "u",
    }).id;
    repo.createSynapse({ from: a, to: b, kind: "contradicts", createdBy: "u" });

    const viewA = readDerivedTargets(a);
    const viewB = readDerivedTargets(b);
    expect([...viewA.outgoing, ...viewA.incoming]).not.toContain(viewA.selfFile);
    expect([...viewB.outgoing, ...viewB.incoming]).not.toContain(viewB.selfFile);
    // 双方互指(contradicts 对称:A 视角 → beta 或 ← beta;B 视角指向 alpha)
    const aAll = [...viewA.outgoing, ...viewA.incoming];
    const bAll = [...viewB.outgoing, ...viewB.incoming];
    expect(aAll.some((t) => t.startsWith("beta"))).toBe(true);
    expect(bAll.some((t) => t.startsWith("alpha"))).toBe(true);
  });
});
