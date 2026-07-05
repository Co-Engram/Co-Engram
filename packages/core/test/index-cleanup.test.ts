import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngramRepository } from "../src/storage/repository.js";
import { cleanupDanglingIndexReferences } from "../src/storage/index-cleanup.js";
import { defaultCachePath } from "../src/index/orchestrator.js";

let tmpDir: string;
let repo: EngramRepository;
let cachePath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-index-cleanup-"));
  repo = new EngramRepository({ rootPath: tmpDir });
  cachePath = defaultCachePath(tmpDir);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("cleanupDanglingIndexReferences — observation-windows.jsonl", () => {
  it("文件不存在时返回空 fixes", () => {
    const result = cleanupDanglingIndexReferences({
      repo,
      dataRoot: tmpDir,
      canonicalIds: new Set(["any"]),
    });
    expect(result.fixes).toEqual([]);
  });

  it("删除 engramId 不在 canonicalIds 中的行,保留合法行", () => {
    mkdirSync(cachePath, { recursive: true });
    const windowsPath = join(cachePath, "observation-windows.jsonl");
    const canonical = "01KW7KZKCC72Z7931GRA9350CD";
    const ghost = "01GHOST00000000000000000000";
    writeFileSync(
      windowsPath,
      [
        JSON.stringify({
          id: "rec-1",
          engramId: canonical,
          query: "q1",
          score: 0.9,
          hitAt: "2026-06-28T16:08:33.006Z",
          deadline: "2026-06-30T16:08:33.006Z",
          kind: "fact",
          status: "closed_by_timeout",
        }),
        JSON.stringify({
          id: "rec-2",
          engramId: ghost,
          query: "q2",
          score: 0.5,
          hitAt: "2026-06-29T10:00:00.000Z",
          deadline: "2026-07-01T10:00:00.000Z",
          kind: "pattern",
          status: "open",
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    const result = cleanupDanglingIndexReferences({
      repo,
      dataRoot: tmpDir,
      canonicalIds: new Set([canonical]),
    });

    const windowsFix = result.fixes.find((f) =>
      f.path?.endsWith("observation-windows.jsonl"),
    );
    expect(windowsFix).toBeDefined();
    expect(windowsFix?.kind).toBe("dangling_index_reference");
    expect(windowsFix?.autoFixed).toBe(true);
    expect(windowsFix?.message).toMatch(/Removed 1 dangling/);

    const after = readFileSync(windowsPath, "utf8");
    expect(after).toContain(canonical);
    expect(after).not.toContain(ghost);
  });

  it("无 dangling 时不写文件、返回空 fixes", () => {
    mkdirSync(cachePath, { recursive: true });
    const windowsPath = join(cachePath, "observation-windows.jsonl");
    const canonical = "01KW7KZKCC72Z7931GRA9350CD";
    const original = JSON.stringify({
      id: "rec-1",
      engramId: canonical,
      query: "q",
      score: 0.9,
      hitAt: "2026-06-28T16:08:33.006Z",
      deadline: "2026-06-30T16:08:33.006Z",
      kind: "fact",
      status: "open",
    });
    writeFileSync(windowsPath, original + "\n", "utf8");

    const result = cleanupDanglingIndexReferences({
      repo,
      dataRoot: tmpDir,
      canonicalIds: new Set([canonical]),
    });

    expect(result.fixes).toEqual([]);
    expect(readFileSync(windowsPath, "utf8")).toBe(original + "\n");
  });

  it("保留无法解析的行(让别处报问题,不擅自删)", () => {
    mkdirSync(cachePath, { recursive: true });
    const windowsPath = join(cachePath, "observation-windows.jsonl");
    writeFileSync(
      windowsPath,
      [
        "this is not valid json",
        JSON.stringify({
          id: "rec-1",
          engramId: "01GHOST00000000000000000000",
          query: "q",
          score: 0.5,
          hitAt: "2026-06-29T10:00:00.000Z",
          deadline: "2026-07-01T10:00:00.000Z",
          kind: "fact",
          status: "open",
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    cleanupDanglingIndexReferences({
      repo,
      dataRoot: tmpDir,
      canonicalIds: new Set(["01CANONICAL0000000000000000"]),
    });

    const after = readFileSync(windowsPath, "utf8");
    expect(after).toContain("this is not valid json");
  });
});

describe("cleanupDanglingIndexReferences — digest.jsonl + graph.json", () => {
  it("digest 含 dangling 时触发 fullRebuild,重建后行数 == canonical", () => {
    const engram = repo.createEngram({
      title: "Alive",
      content: "still here",
      kind: "fact",
      domainTags: ["test"],
      createdBy: "tester",
    });

    mkdirSync(cachePath, { recursive: true });
    const digestPath = join(cachePath, "digest.jsonl");
    writeFileSync(
      digestPath,
      [
        JSON.stringify({
          id: engram.id,
          title: "Alive",
          kind: "fact",
          kinds: ["fact"],
          summary: "",
          domainTags: ["test"],
          contextTags: [],
          importance: 0.5,
          freshness: "fresh",
          status: "active",
          sourceType: "firsthand",
          createdBy: "tester",
          createdAt: "2026-06-28T16:08:33.006Z",
          updatedAt: "2026-06-28T16:08:33.006Z",
          lastRetrievedAt: null,
          lastEffectiveAt: null,
          retrievalCount: 0,
          effectiveRetrievals: 0,
          failedUses: 0,
          reinforcementScore: 0,
          contentSize: 10,
          contentHash: "x",
          outgoingSynapseCount: 0,
          incomingSynapseCount: 0,
          activeContradictionCount: 0,
        }),
        JSON.stringify({
          id: "01GHOST00000000000000000000",
          title: "Ghost",
          kind: "fact",
          kinds: ["fact"],
          summary: "",
          domainTags: [],
          contextTags: [],
          importance: 0.5,
          freshness: "fresh",
          status: "active",
          sourceType: "firsthand",
          createdBy: "tester",
          createdAt: "2026-06-28T16:08:33.006Z",
          updatedAt: "2026-06-28T16:08:33.006Z",
          lastRetrievedAt: null,
          lastEffectiveAt: null,
          retrievalCount: 0,
          effectiveRetrievals: 0,
          failedUses: 0,
          reinforcementScore: 0,
          contentSize: 5,
          contentHash: "y",
          outgoingSynapseCount: 0,
          incomingSynapseCount: 0,
          activeContradictionCount: 0,
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    const result = cleanupDanglingIndexReferences({
      repo,
      dataRoot: tmpDir,
      canonicalIds: new Set([engram.id]),
    });

    const rebuildFix = result.fixes.find(
      (f) => f.kind === "dangling_index_reference" && f.path === cachePath,
    );
    expect(rebuildFix).toBeDefined();
    expect(rebuildFix?.message).toMatch(/Rebuilt stale derived indexes/);
    expect(rebuildFix?.message).toMatch(/digest had 1 dangling/);

    const after = readFileSync(digestPath, "utf8");
    expect(after).toContain(engram.id);
    expect(after).not.toContain("01GHOST00000000000000000000");

    const graphPath = join(cachePath, "graph.json");
    expect(existsSync(graphPath)).toBe(true);
    const graph = JSON.parse(readFileSync(graphPath, "utf8"));
    expect(graph.nodes.map((n: { id: string }) => n.id)).toContain(engram.id);
    expect(graph.nodes.map((n: { id: string }) => n.id)).not.toContain(
      "01GHOST00000000000000000000",
    );
  });

  it("graph 含 dangling 节点时触发 fullRebuild", () => {
    const engram = repo.createEngram({
      title: "Alive",
      content: "still here",
      kind: "fact",
      domainTags: ["test"],
      createdBy: "tester",
    });

    mkdirSync(cachePath, { recursive: true });
    const graphPath = join(cachePath, "graph.json");
    const ghost = "01GHOST00000000000000000000";
    writeFileSync(
      graphPath,
      JSON.stringify(
        {
          nodes: [
            { id: engram.id, title: "Alive", kind: "fact", importance: 0.5, outgoingCount: 0, incomingCount: 0 },
            { id: ghost, title: "Ghost", kind: "fact", importance: 0.5, outgoingCount: 0, incomingCount: 0 },
          ],
          edges: [],
          outgoingAdjacency: { [engram.id]: [], [ghost]: [] },
          incomingAdjacency: { [engram.id]: [], [ghost]: [] },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = cleanupDanglingIndexReferences({
      repo,
      dataRoot: tmpDir,
      canonicalIds: new Set([engram.id]),
    });

    const rebuildFix = result.fixes.find(
      (f) => f.kind === "dangling_index_reference" && f.path === cachePath,
    );
    expect(rebuildFix).toBeDefined();
    expect(rebuildFix?.message).toMatch(/graph had 1 dangling/);

    const after = JSON.parse(readFileSync(graphPath, "utf8"));
    expect(after.nodes.map((n: { id: string }) => n.id)).toContain(engram.id);
    expect(after.nodes.map((n: { id: string }) => n.id)).not.toContain(ghost);
  });

  it("digest/graph 与 canonical 完全一致时不触发 rebuild、返回空 fixes", () => {
    const engram = repo.createEngram({
      title: "Alive",
      content: "still here",
      kind: "fact",
      domainTags: ["test"],
      createdBy: "tester",
    });

    mkdirSync(cachePath, { recursive: true });
    const digestPath = join(cachePath, "digest.jsonl");
    const graphPath = join(cachePath, "graph.json");
    writeFileSync(
      digestPath,
      JSON.stringify({
        id: engram.id,
        title: "Alive",
        kind: "fact",
        kinds: ["fact"],
        summary: "",
        domainTags: ["test"],
        contextTags: [],
        importance: 0.5,
        freshness: "fresh",
        status: "active",
        sourceType: "firsthand",
        createdBy: "tester",
        createdAt: "2026-06-28T16:08:33.006Z",
        updatedAt: "2026-06-28T16:08:33.006Z",
        lastRetrievedAt: null,
        lastEffectiveAt: null,
        retrievalCount: 0,
        effectiveRetrievals: 0,
        failedUses: 0,
        reinforcementScore: 0,
        contentSize: 10,
        contentHash: "x",
        outgoingSynapseCount: 0,
        incomingSynapseCount: 0,
        activeContradictionCount: 0,
      }) + "\n",
      "utf8",
    );
    writeFileSync(
      graphPath,
      JSON.stringify({
        nodes: [
          { id: engram.id, title: "Alive", kind: "fact", importance: 0.5, outgoingCount: 0, incomingCount: 0 },
        ],
        edges: [],
        outgoingAdjacency: { [engram.id]: [] },
        incomingAdjacency: { [engram.id]: [] },
      }),
      "utf8",
    );

    const result = cleanupDanglingIndexReferences({
      repo,
      dataRoot: tmpDir,
      canonicalIds: new Set([engram.id]),
    });

    expect(result.fixes).toEqual([]);
  });

  it("end-to-end:同时清 observation-windows 和触发 digest/graph 重建", () => {
    const engram = repo.createEngram({
      title: "Alive",
      content: "still here",
      kind: "fact",
      domainTags: ["test"],
      createdBy: "tester",
    });
    const ghost = "01GHOST00000000000000000000";

    mkdirSync(cachePath, { recursive: true });
    const windowsPath = join(cachePath, "observation-windows.jsonl");
    const digestPath = join(cachePath, "digest.jsonl");
    writeFileSync(
      windowsPath,
      [
        JSON.stringify({ id: "w1", engramId: engram.id, query: "q", score: 0.9, hitAt: "2026-06-28T16:00:00.000Z", deadline: "2026-06-30T16:00:00.000Z", kind: "fact", status: "open" }),
        JSON.stringify({ id: "w2", engramId: ghost, query: "q", score: 0.5, hitAt: "2026-06-28T16:00:00.000Z", deadline: "2026-06-30T16:00:00.000Z", kind: "fact", status: "open" }),
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      digestPath,
      [
        JSON.stringify({ id: ghost, title: "Ghost", kind: "fact" }),
        "",
      ].join("\n"),
      "utf8",
    );

    const result = cleanupDanglingIndexReferences({
      repo,
      dataRoot: tmpDir,
      canonicalIds: new Set([engram.id]),
    });

    const kinds = new Set(result.fixes.map((f) => f.kind));
    expect(kinds.has("dangling_index_reference")).toBe(true);
    expect(result.fixes.length).toBe(2);

    expect(readFileSync(windowsPath, "utf8")).not.toContain(ghost);
    expect(readFileSync(digestPath, "utf8")).not.toContain(ghost);
  });
});
