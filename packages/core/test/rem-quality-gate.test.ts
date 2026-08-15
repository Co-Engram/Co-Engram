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

// ============================================================
// 占位标签判定(2026-08-15:真实库发现 domainTags=["...","..."] 存量)
// ============================================================
import { refreshDomainTagsOnDrift } from "../src/maintenance/tag-refresh.js";
import { bootstrapRepositoryAndSearch } from "../src/storage/bootstrap.js";

describe("占位标签(含纯点号)全量重提", () => {
  it("domainTags=['...'] 的 engram 豁免 unchanged/below-threshold,走 LLM 重提(真实 LLM 太慢,用可记录调用的假 client 验证候选被选中)", async () => {
    const { repository } = bootstrapRepositoryAndSearch({ dataRoot: tmpDir });
    repository.createEngram({
      title: "点号占位记忆",
      content: "一些真实内容,涉及知识管理域",
      kind: "observation",
      domainTags: ["..."],
      createdBy: "t",
    });
    const called: string[] = [];
    const fakeLlm = {
      complete: async (p: string) => {
        called.push(p.slice(0, 40));
        return JSON.stringify({
          title: "知识管理", summary: "s", content: "c",
          domainTags: ["知识管理"], kind: "observation", importance: 0.5,
        });
      },
    } as never;
    const proposals: Array<{ engramId: string; newTags: readonly string[] }> = [];
    const sink = {
      proposeTagRefresh: (i: { engramId: string; newTags: readonly string[] }) => {
        proposals.push(i);
        return true;
      },
      findProposalByEntityId: () => undefined,
    } as never;
    // 跑两轮:第二轮内容未变 —— 若占位判定失效,会被 unchanged 短路
    await refreshDomainTagsOnDrift(repository, undefined, fakeLlm, sink);
    await refreshDomainTagsOnDrift(repository, undefined, fakeLlm, sink);
    expect(proposals.length).toBeGreaterThanOrEqual(1);
    expect(proposals.some((p) => p.newTags.includes("知识管理"))).toBe(true);
    expect(called.length).toBeGreaterThanOrEqual(2); // 两轮都触达 LLM(占位豁免)
  });
});
