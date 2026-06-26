import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  upsertSynapse,
  collectAllSynapses,
  readSynapseByEndpoints,
  readSynapseById,
  listSynapsesForEngram,
  deleteSynapsesTouching,
  synapseRelativePath,
  extractSynapseIdFromFilename,
  serializeSynapseFile,
  parseSynapseFile,
  SYNAPSES_DIR,
} from "../src/storage/synapse-store.js";
import { computeSynapseId, isSynapseId } from "../src/types/synapse-id.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-synapse-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const FROM = "01KVNJ9RN190DVHBKFB7NHDF9Q";
const TO = "01KVNJ9RN3GW1KWXKVJ56RGJ0W";
const NOW = "2026-06-22T10:00:00Z";

describe("synapse-store — upsert 幂等性", () => {
  it("首次 upsert 创建文件", () => {
    const syn = upsertSynapse(tmpDir, {
      from: FROM,
      to: TO,
      kind: "extends",
      weight: 0.8,
      createdBy: "alice",
      now: NOW,
    });
    const expectedId = computeSynapseId(FROM, TO, "extends");
    expect(syn.id).toBe(expectedId);
    const path = join(tmpDir, synapseRelativePath(syn.id, "extends"));
    expect(existsSync(path)).toBe(true);
  });

  it("相同 (from, to, kind) 生成相同 id", () => {
    const a = upsertSynapse(tmpDir, {
      from: FROM,
      to: TO,
      kind: "extends",
      createdBy: "alice",
      now: NOW,
    });
    const b = upsertSynapse(tmpDir, {
      from: FROM,
      to: TO,
      kind: "extends",
      createdBy: "bob",
      now: "2026-06-22T11:00:00Z",
    });
    expect(a.id).toBe(b.id);
  });

  it("重复 upsert 不创建新文件,而是合并 evidence", () => {
    upsertSynapse(tmpDir, {
      from: FROM,
      to: TO,
      kind: "extends",
      evidence: [{ description: "first evidence", addedBy: "alice" }],
      createdBy: "alice",
      now: NOW,
    });
    upsertSynapse(tmpDir, {
      from: FROM,
      to: TO,
      kind: "extends",
      evidence: [{ description: "second evidence", addedBy: "bob" }],
      createdBy: "alice",
      now: "2026-06-22T11:00:00Z",
    });

    const all = collectAllSynapses(tmpDir);
    expect(all.length).toBe(1);
    expect(all[0]!.evidence.length).toBe(2);
    expect(all[0]!.evidence.map((e) => e.description).sort()).toEqual([
      "first evidence",
      "second evidence",
    ]);
  });

  it("重复 upsert 同 evidence 去重", () => {
    upsertSynapse(tmpDir, {
      from: FROM,
      to: TO,
      kind: "extends",
      evidence: [{ description: "same", addedBy: "alice" }],
      createdBy: "alice",
      now: NOW,
    });
    upsertSynapse(tmpDir, {
      from: FROM,
      to: TO,
      kind: "extends",
      evidence: [{ description: "same", addedBy: "alice" }],
      createdBy: "alice",
      now: "2026-06-22T11:00:00Z",
    });

    const all = collectAllSynapses(tmpDir);
    expect(all[0]!.evidence.length).toBe(1);
  });

  it("weight 覆盖,新值优先", () => {
    upsertSynapse(tmpDir, {
      from: FROM,
      to: TO,
      kind: "extends",
      weight: 0.3,
      createdBy: "alice",
      now: NOW,
    });
    const updated = upsertSynapse(tmpDir, {
      from: FROM,
      to: TO,
      kind: "extends",
      weight: 0.9,
      createdBy: "alice",
      now: "2026-06-22T11:00:00Z",
    });
    expect(updated.weight).toBe(0.9);
  });

  it("createdAt 保留首次创建时间", () => {
    upsertSynapse(tmpDir, {
      from: FROM,
      to: TO,
      kind: "extends",
      createdBy: "alice",
      now: "2026-06-22T10:00:00Z",
    });
    const updated = upsertSynapse(tmpDir, {
      from: FROM,
      to: TO,
      kind: "extends",
      createdBy: "alice",
      now: "2026-06-22T11:00:00Z",
    });
    expect(updated.createdAt).toBe("2026-06-22T10:00:00Z");
    expect(updated.updatedAt).toBe("2026-06-22T11:00:00Z");
  });
});

describe("synapse-store — bidirectional 对称性", () => {
  it("(A,B,similar_to,bidir) 和 (B,A,similar_to,bidir) 同 id", () => {
    const ab = upsertSynapse(tmpDir, {
      from: FROM,
      to: TO,
      kind: "similar_to",
      direction: "bidirectional",
      createdBy: "alice",
      now: NOW,
    });
    const ba = upsertSynapse(tmpDir, {
      from: TO,
      to: FROM,
      kind: "similar_to",
      direction: "bidirectional",
      createdBy: "alice",
      now: NOW,
    });
    expect(ab.id).toBe(ba.id);
  });

  it("(A,B,extends,dir) 和 (B,A,extends,dir) 不同 id", () => {
    const ab = upsertSynapse(tmpDir, {
      from: FROM,
      to: TO,
      kind: "extends",
      direction: "directional",
      createdBy: "alice",
      now: NOW,
    });
    const ba = upsertSynapse(tmpDir, {
      from: TO,
      to: FROM,
      kind: "extends",
      direction: "directional",
      createdBy: "alice",
      now: NOW,
    });
    expect(ab.id).not.toBe(ba.id);
  });
});

describe("synapse-store — collectAllSynapses", () => {
  it("空目录返回空数组", () => {
    expect(collectAllSynapses(tmpDir)).toEqual([]);
  });

  it("按 kind 子目录分组扫描", () => {
    upsertSynapse(tmpDir, {
      from: FROM,
      to: TO,
      kind: "extends",
      createdBy: "alice",
      now: NOW,
    });
    upsertSynapse(tmpDir, {
      from: FROM,
      to: TO,
      kind: "contradicts",
      createdBy: "alice",
      now: NOW,
    });
    const all = collectAllSynapses(tmpDir);
    expect(all.length).toBe(2);
    expect(all.map((s) => s.kind).sort()).toEqual(["contradicts", "extends"]);
  });

  it("损坏文件不阻塞扫描", () => {
    upsertSynapse(tmpDir, {
      from: FROM,
      to: TO,
      kind: "extends",
      createdBy: "alice",
      now: NOW,
    });
    // 写入损坏文件
    const { writeFileSync, mkdirSync } = require("node:fs");
    mkdirSync(join(tmpDir, "synapses", "similar_to"), { recursive: true });
    writeFileSync(
      join(tmpDir, "synapses", "similar_to", "syn-corrupt00000000.yaml"),
      "not yaml",
    );
    const corrupted: string[] = [];
    const all = collectAllSynapses(tmpDir, (path) => corrupted.push(path));
    expect(all.length).toBe(1);
    expect(corrupted.length).toBe(1);
  });
});

describe("synapse-store — 端点查询", () => {
  it("readSynapseByEndpoints 命中", () => {
    upsertSynapse(tmpDir, {
      from: FROM,
      to: TO,
      kind: "extends",
      createdBy: "alice",
      now: NOW,
    });
    const found = readSynapseByEndpoints(tmpDir, FROM, TO, "extends");
    expect(found).toBeDefined();
    expect(found!.from).toBe(FROM);
  });

  it("readSynapseByEndpoints 未命中返回 undefined", () => {
    expect(readSynapseByEndpoints(tmpDir, FROM, TO, "extends")).toBeUndefined();
  });

  it("readSynapseById 命中", () => {
    const syn = upsertSynapse(tmpDir, {
      from: FROM,
      to: TO,
      kind: "extends",
      createdBy: "alice",
      now: NOW,
    });
    const found = readSynapseById(tmpDir, syn.id);
    expect(found).toBeDefined();
    expect(found!.id).toBe(syn.id);
  });

  it("listSynapsesForEngram 返回出+入", () => {
    upsertSynapse(tmpDir, {
      from: FROM,
      to: TO,
      kind: "extends",
      createdBy: "alice",
      now: NOW,
    });
    upsertSynapse(tmpDir, {
      from: "01KVNJ9RN3SHB480QSCT7DZ63Q",
      to: FROM,
      kind: "similar_to",
      createdBy: "alice",
      now: NOW,
    });
    const { outgoing, incoming } = listSynapsesForEngram(tmpDir, FROM);
    expect(outgoing.length).toBe(1);
    expect(incoming.length).toBe(1);
    expect(outgoing[0]!.kind).toBe("extends");
    expect(incoming[0]!.kind).toBe("similar_to");
  });
});

describe("synapse-store — 级联删除", () => {
  it("deleteSynapsesTouching 删除所有触及 engram 的 edge", () => {
    upsertSynapse(tmpDir, {
      from: FROM,
      to: TO,
      kind: "extends",
      createdBy: "alice",
      now: NOW,
    });
    upsertSynapse(tmpDir, {
      from: FROM,
      to: "01KVNJ9RN3SHB480QSCT7DZ63Q",
      kind: "similar_to",
      createdBy: "alice",
      now: NOW,
    });
    upsertSynapse(tmpDir, {
      from: "01KVNJ9RN3SHB480QSCT7DZ63Q",
      to: FROM,
      kind: "derives_from",
      createdBy: "alice",
      now: NOW,
    });
    const deleted = deleteSynapsesTouching(tmpDir, FROM);
    expect(deleted).toBe(3);
    expect(collectAllSynapses(tmpDir).length).toBe(0);
  });

  it("未触及的 edge 保留", () => {
    upsertSynapse(tmpDir, {
      from: FROM,
      to: TO,
      kind: "extends",
      createdBy: "alice",
      now: NOW,
    });
    upsertSynapse(tmpDir, {
      from: "01KVNJ9RN3VZ6MJTQ7G0A2H4QJ",
      to: "01KVNJ9RN3FVN4S77KHGEJQCJ1",
      kind: "extends",
      createdBy: "alice",
      now: NOW,
    });
    const deleted = deleteSynapsesTouching(tmpDir, FROM);
    expect(deleted).toBe(1);
    expect(collectAllSynapses(tmpDir).length).toBe(1);
  });
});

describe("synapse-store — 工具函数", () => {
  it("synapseRelativePath 生成 synapses/{kind}/{id}.yaml", () => {
    const path = synapseRelativePath("syn-a1b2c3d4e5f67890", "extends");
    expect(path).toBe(join("synapses", "extends", "syn-a1b2c3d4e5f67890.yaml"));
  });

  it("SYNAPSES_DIR 是 synapses", () => {
    expect(SYNAPSES_DIR).toBe("synapses");
  });

  it("extractSynapseIdFromFilename 合法 id", () => {
    expect(extractSynapseIdFromFilename("syn-a1b2c3d4e5f67890.yaml")).toBe(
      "syn-a1b2c3d4e5f67890",
    );
  });

  it("extractSynapseIdFromFilename 非法 id 返回 undefined", () => {
    expect(extractSynapseIdFromFilename("not-a-syn-id.yaml")).toBeUndefined();
  });
});

describe("synapse-store — 中文字段名(zh 模式)", () => {
  const sampleSyn = {
    id: computeSynapseId(
      "01KVVS933R7KPB9VHSR0VQ6CFG" as never,
      "01KVVS933R7KPB9VHSR0VQ6CFG2" as never,
      "causes",
    ),
    from: "01KVVS933R7KPB9VHSR0VQ6CFG",
    to: "01KVVS933R7KPB9VHSR0VQ6CFG2",
    kind: "causes" as const,
    weight: 0.7,
    direction: "directional" as const,
    evidence: [
      {
        description: "实验证据",
        source: "paper-2024",
        confidence: 0.9,
        addedAt: "2026-06-24T10:00:00Z",
        addedBy: "alice",
      },
    ],
    createdBy: "alice",
    createdAt: "2026-06-24T10:00:00Z",
    updatedAt: "2026-06-24T10:00:00Z",
    retrievalWeight: 0.5,
  };

  // sanity check(确保 fixture id 合法)
  it("fixture:sampleSyn.id 是合法 synapse id", () => {
    expect(isSynapseId(sampleSyn.id)).toBe(true);
  });

  it("zh 模式:YAML keys 全部中文化(顶层)", () => {
    const raw = serializeSynapseFile(sampleSyn, "zh");
    expect(raw).toContain("标识:");
    expect(raw).toContain("起点:");
    expect(raw).toContain("终点:");
    expect(raw).toContain("类型:");
    expect(raw).toContain("权重:");
    expect(raw).toContain("方向:");
    // 不含英文 keys
    expect(raw).not.toMatch(/^id:/m);
    expect(raw).not.toMatch(/^from:/m);
    expect(raw).not.toMatch(/^to:/m);
  });

  it("zh 模式:嵌套字段(evidence)也中文化", () => {
    const raw = serializeSynapseFile(sampleSyn, "zh");
    expect(raw).toContain("证据:");
    expect(raw).toContain("描述:");
    expect(raw).toContain("来源:");
    expect(raw).toContain("置信度:");
    expect(raw).toContain("添加者:");
    expect(raw).toContain("添加时间:");
  });

  it("zh 模式:__语言: zh 标记存在", () => {
    const raw = serializeSynapseFile(sampleSyn, "zh");
    expect(raw).toMatch(/__语言:\s*zh/);
  });

  it("zh 模式:枚举值保持英文(类型系统约束)", () => {
    const raw = serializeSynapseFile(sampleSyn, "zh");
    expect(raw).toContain("类型: causes");
    expect(raw).toContain("方向: directional");
  });

  it("zh 模式 round-trip:数据无损还原", () => {
    const raw = serializeSynapseFile(sampleSyn, "zh");
    const parsed = parseSynapseFile(raw);
    expect(parsed.id).toBe(sampleSyn.id);
    expect(parsed.from).toBe(sampleSyn.from);
    expect(parsed.to).toBe(sampleSyn.to);
    expect(parsed.kind).toBe("causes");
    expect(parsed.weight).toBe(0.7);
    expect(parsed.evidence[0]!.description).toBe("实验证据");
    expect(parsed.evidence[0]!.addedBy).toBe("alice");
    // __语言 标记不进入运行时对象
    expect(
      (parsed as unknown as Record<string, unknown>)["__语言"],
    ).toBeUndefined();
  });

  it("向后兼容:旧英文 keys 文件 parse 正常", () => {
    const legacyRaw = `
id: ${sampleSyn.id}
from: ${sampleSyn.from}
to: ${sampleSyn.to}
kind: causes
weight: 0.7
direction: directional
createdBy: alice
createdAt: 2026-06-24T10:00:00Z
updatedAt: 2026-06-24T10:00:00Z
retrievalWeight: 0.5
`;
    const parsed = parseSynapseFile(legacyRaw);
    expect(parsed.id).toBe(sampleSyn.id);
    expect(parsed.kind).toBe("causes");
    expect(parsed.weight).toBe(0.7);
  });
});
