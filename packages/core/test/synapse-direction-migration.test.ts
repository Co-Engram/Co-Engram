import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { EngramRepository } from "../src/storage/repository.js";
import { computeSynapseId } from "../src/types/synapse-id.js";
import { synapseRelativePath } from "../src/storage/synapse-store.js";
import type { SynapseId } from "../src/types/engram.js";
import type { SynapseKind } from "../src/types/synapse.js";

/**
 * doctor 自愈迁移测试(方案 A:对称性回归 kind 的派生属性)
 *
 * 覆盖 runDoctor 的两段自愈逻辑:
 *   - 4.57 清理 synapse yaml 死字段 direction/方向
 *   - 4.58 对称 kind(similar_to/contradicts)端点规范化(from>to → 交换 + 重算 id)
 *
 * 用手写旧格式 yaml(含 `方向:` 字段,模拟 direction 移除前的存量数据)驱动。
 */
describe("doctor — synapse direction 迁移(方案 A)", () => {
  let tmpDir: string;
  let repo: EngramRepository;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "co-engram-syn-mig-"));
    repo = new EngramRepository({ rootPath: tmpDir });
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  /** 写旧格式 synapse yaml(含 `方向:` 字段,模拟 direction 移除前的存量) */
  function writeLegacySynapse(opts: {
    kind: SynapseKind;
    from: string;
    to: string;
    id: SynapseId;
    direction?: string;
  }): string {
    const abs = join(tmpDir, synapseRelativePath(opts.id, opts.kind));
    mkdirSync(dirname(abs), { recursive: true });
    const lines = [
      `标识: ${opts.id}`,
      `起点: ${opts.from}`,
      `终点: ${opts.to}`,
      `类型: ${opts.kind}`,
      `权重: 0.6`,
      ...(opts.direction ? [`方向: ${opts.direction}`] : []),
      `证据: []`,
      `创建者: tester`,
      `创建时间: 2026-01-01T00:00:00.000Z`,
      `更新时间: 2026-01-01T00:00:00.000Z`,
      `__语言: zh`,
    ];
    writeFileSync(abs, lines.join("\n") + "\n", "utf8");
    return abs;
  }

  it("4.57 清理 direction/方向 死字段(有向 kind,id 不变)", () => {
    const a = repo.createEngram({
      title: "A",
      content: "a",
      kind: "fact",
      domainTags: ["t"],
      createdBy: "tester",
    });
    const b = repo.createEngram({
      title: "B",
      content: "b",
      kind: "fact",
      domainTags: ["t"],
      createdBy: "tester",
    });
    const [lo, hi] = [a.id, b.id].sort();
    // extends 有向:新算法 id = hash(lo|hi|extends),doctor 不改 id,只清 direction
    const id = computeSynapseId(lo, hi, "extends");
    const abs = writeLegacySynapse({
      kind: "extends",
      from: lo,
      to: hi,
      id,
      direction: "directional",
    });
    expect(readFileSync(abs, "utf8")).toMatch(/^方向:/m);

    repo.runDoctor();

    const raw = readFileSync(abs, "utf8");
    expect(raw).not.toMatch(/^方向:/m);
    expect(raw).not.toMatch(/^direction:/m);
    // 有向 kind 端点不变(未触发 4.58)
    expect(existsSync(abs)).toBe(true);
  });

  it("4.58 对称 kind(similar_to)端点规范化:from>to → 交换 + 重算 id", () => {
    const a = repo.createEngram({
      title: "A",
      content: "a",
      kind: "fact",
      domainTags: ["t"],
      createdBy: "tester",
    });
    const b = repo.createEngram({
      title: "B",
      content: "b",
      kind: "fact",
      domainTags: ["t"],
      createdBy: "tester",
    });
    const [lo, hi] = [a.id, b.id].sort();
    // 旧 similar_to:from=hi,to=lo(from>to,旧 directional 算法不规范化)。
    // legacyId 用不同 kind 计算,保证 ≠ similar_to 的新 canonicalId。
    const legacyId = computeSynapseId(hi, lo, "causes");
    const oldAbs = writeLegacySynapse({
      kind: "similar_to",
      from: hi,
      to: lo,
      id: legacyId,
      direction: "directional",
    });
    expect(existsSync(oldAbs)).toBe(true);

    repo.runDoctor();

    // canonicalId = 新算法(对称 kind 规范化端点为 min/max)
    const canonicalId = computeSynapseId(hi, lo, "similar_to");
    const newAbs = join(
      tmpDir,
      synapseRelativePath(canonicalId, "similar_to"),
    );
    expect(existsSync(newAbs)).toBe(true);
    expect(existsSync(oldAbs)).toBe(false); // 旧 id 文件已删
    const raw = readFileSync(newAbs, "utf8");
    expect(raw).not.toMatch(/^方向:/m);
    // 端点规范化:from=min(lo), to=max(hi)
    expect(raw).toContain(`起点: ${lo}`);
    expect(raw).toContain(`终点: ${hi}`);
  });

  it("幂等:再跑 doctor 不产生 direction 清理 / 端点规范化 修复", () => {
    const a = repo.createEngram({
      title: "A",
      content: "a",
      kind: "fact",
      domainTags: ["t"],
      createdBy: "tester",
    });
    const b = repo.createEngram({
      title: "B",
      content: "b",
      kind: "fact",
      domainTags: ["t"],
      createdBy: "tester",
    });
    const [lo, hi] = [a.id, b.id].sort();
    const legacyId = computeSynapseId(hi, lo, "causes");
    writeLegacySynapse({
      kind: "similar_to",
      from: hi,
      to: lo,
      id: legacyId,
      direction: "directional",
    });

    repo.runDoctor(); // 首次迁移
    const report2 = repo.runDoctor(); // 二次:应幂等
    const migrationFixes = report2.fixes.filter(
      (f) =>
        f.message.includes("direction") ||
        f.message.includes("normalized") ||
        f.message.includes("canonical"),
    );
    expect(migrationFixes).toHaveLength(0);
  });
});
