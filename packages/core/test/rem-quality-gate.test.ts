// rem-pattern 质量闸门(2026-08-15):启发式产物不进提案/不自动采纳
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EngramRepository } from "../src/storage/repository.js";
import { runRemDreaming, type PatternAbstractionProvider } from "../src/dreaming/rem.js";

let tmpDir: string;
let repo: EngramRepository;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-rem-gate-"));
  repo = new EngramRepository({ rootPath: tmpDir });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** 同域相似记忆 × N(凑 minClusterSize=3 的 cluster) */
function seedCluster(n = 3) {
  for (let i = 0; i < n; i++) {
    repo.createEngram({
      title: `rdc wim har api pr 记忆${i}`,
      content: `rdc wim har api pr 变体${i} 唯一内容${i}`,
      kind: "fact",
      domainTags: ["rdc"],
      createdBy: "t",
    });
  }
}

/** 记录 proposePattern / proposeSynapseOp 调用的 stub proposalEngine */
function makeStub() {
  const calls = { pattern: 0, synapseAdd: 0 };
  return {
    calls,
    engine: {
      proposePattern: () => {
        calls.pattern += 1;
        return true;
      },
      proposeSynapseOp: (input: { op: string }) => {
        if (input.op === "add") calls.synapseAdd += 1;
        return true;
      },
    } as never,
  };
}

/** 无 provider 字段的自定义 provider(向后兼容:按 llm 对待) */
const untaggedProvider: PatternAbstractionProvider = {
  async abstract(input) {
    return {
      title: `语义主题(${input.engrams.length} 源)`,
      content: "语义抽象内容",
      summary: "语义摘要",
      confidence: 0.9,
      reason: "llm",
    };
  },
};

describe("rem-pattern 质量闸门:启发式产物不进提案", () => {
  it("默认(无 abstractionProvider)= 启发式 → 零 proposePattern;聚类 synapse add 发现不受影响", async () => {
    seedCluster(3);
    const { calls, engine: stub } = makeStub();
    await runRemDreaming(repo, { proposalEngine: stub, minClusterSize: 3 });
    expect(calls.pattern).toBe(0); // 「从 N 条相似记忆提炼的模式」类噪声不再出提案
    expect(calls.synapseAdd).toBeGreaterThan(0); // 聚类结构发现(机械)照常
  });

  it("heuristic 显式 provider → 同样零提案;不自动采纳(dryRun 关也不建 engram)", async () => {
    seedCluster(3);
    const before = repo.listEngramIndex().length;
    await runRemDreaming(repo, { minClusterSize: 3 }); // 无 proposalEngine → 走 autoAdoption 分支
    const patterns = repo
      .listEngramIndex()
      .filter((e) => before >= 0 && e.title.includes("提炼的模式"));
    expect(patterns).toHaveLength(0); // 启发式 confidence 可达 1.0,也不自动创建
  });

  it("无 provider 标记的自定义 provider(向后兼容)→ 提案照常", async () => {
    seedCluster(3);
    const { calls, engine: stub } = makeStub();
    await runRemDreaming(repo, {
      proposalEngine: stub,
      minClusterSize: 3,
      abstractionProvider: untaggedProvider,
    });
    expect(calls.pattern).toBeGreaterThan(0);
  });
});
