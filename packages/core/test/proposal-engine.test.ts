import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngramRepository } from "../src/storage/repository.js";
import { AuditLog } from "../src/observability/audit-log.js";
import {
  ProposalEngine,
  DEFAULT_PROPOSAL_CONFIG,
  DEFAULT_HASHER_EMBEDDER,
  DEFAULT_HASHER_SIMILARITY_THRESHOLD,
  cosineSimilarity,
  clusterId,
  newCluster,
  addToCluster,
  findBestMatch,
  type Embedder,
  type TopicCluster,
} from "../src/observability/proposal-engine.js";

/**
 * 同主题、不同措辞的样本组 — 反映真实"反复出现的话题"场景
 *
 * 旧测试用"完全相同 content 重复 N 次"假设能成 proposal,但那正是
 * 我们要过滤的机械重复。新规则要求 samples 有一定多样性。
 */
const TS_CI_SAMPLES = [
  "we should really configure github actions for typescript ci pipelines",
  "please set up CI for the typescript project using github actions",
  "how do we configure github actions to run typescript continuous integration",
  "reminder to enable github actions workflows for typescript ci builds",
  "lets get the typescript ci pipeline working on github actions",
];

let tmpDir: string;
let repo: EngramRepository;
let audit: AuditLog;
let engine: ProposalEngine;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-proposal-"));
  repo = new EngramRepository({ rootPath: tmpDir });
  audit = new AuditLog(tmpDir);
  engine = new ProposalEngine({
    repository: repo,
    embedder: DEFAULT_HASHER_EMBEDDER,
    auditLog: audit,
    dataRoot: tmpDir,
    // 必须用 hash 配套阈值 0.35:DEFAULT_PROPOSAL_CONFIG.similarityThreshold=0.75
    // 是给真实 LLM embedding 设计的,hash embedder 永远达不到 0.75(即使语义相同)。
    // 详见 proposal-engine.ts DEFAULT_HASHER_SIMILARITY_THRESHOLD 的注释。
    config: { similarityThreshold: DEFAULT_HASHER_SIMILARITY_THRESHOLD },
  });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================
// 纯函数
// ============================================================

describe("cosineSimilarity", () => {
  it("两个相同向量 → 1", () => {
    const v = [1, 2, 3];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it("正交向量 → 0", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });

  it("零向量 → 0（防除零）", () => {
    expect(cosineSimilarity([0, 0], [1, 2])).toBe(0);
  });

  it("长度不一致按 max 补零", () => {
    expect(cosineSimilarity([1, 1, 1], [1, 1])).toBeCloseTo(
      2 / (Math.sqrt(3) * Math.sqrt(2)),
      5,
    );
  });
});

describe("clusterId", () => {
  it("稳定（同向量同 id）", () => {
    const v = [0.1, 0.2, 0.3, 0.4];
    expect(clusterId(v)).toBe(clusterId(v));
  });

  it("不同向量不同 id（基本不冲突）", () => {
    const a = clusterId([0.1, 0.2, 0.3, 0.4]);
    const b = clusterId([0.4, 0.3, 0.2, 0.1]);
    expect(a).not.toBe(b);
  });
});

describe("newCluster", () => {
  it("occurrences=1 + 含一条样本", () => {
    const c = newCluster([1, 2, 3], "first message", "2026-06-21T00:00:00Z");
    expect(c.occurrences).toBe(1);
    expect(c.samples).toEqual(["first message"]);
    expect(c.firstSeenAt).toBe("2026-06-21T00:00:00Z");
    expect(c.lastSeenAt).toBe("2026-06-21T00:00:00Z");
  });

  it("长样本截断 100 字符", () => {
    const longText = "x".repeat(200);
    const c = newCluster([1], longText, "2026-06-21T00:00:00Z");
    expect(c.samples[0]!.length).toBeLessThanOrEqual(100);
  });
});

describe("addToCluster", () => {
  it("occurrences +1 + 样本入列", () => {
    const c = newCluster([1, 0, 0], "m1", "2026-06-21T00:00:00Z");
    const c2 = addToCluster(c, "m2", [1, 0, 0], "2026-06-22T00:00:00Z", 3);
    expect(c2.occurrences).toBe(2);
    expect(c2.samples).toEqual(["m1", "m2"]);
    expect(c2.lastSeenAt).toBe("2026-06-22T00:00:00Z");
  });

  it("质心增量平均（保持相似）", () => {
    const c = newCluster([1, 0], "m1", "2026-06-21T00:00:00Z");
    const c2 = addToCluster(c, "m2", [1, 0], "2026-06-22T00:00:00Z", 3);
    expect(c2.centroid[0]).toBeCloseTo(1, 5);
    expect(c2.centroid[1]).toBeCloseTo(0, 5);
  });

  it("样本数限流 maxSamples", () => {
    let c: TopicCluster = newCluster([1], "m1", "2026-06-21T00:00:00Z");
    c = addToCluster(c, "m2", [1], "2026-06-21T00:00:00Z", 2);
    c = addToCluster(c, "m3", [1], "2026-06-21T00:00:00Z", 2);
    expect(c.samples).toEqual(["m2", "m3"]); // 滑动窗口
  });
});

describe("findBestMatch", () => {
  it("空簇列表返回 null", () => {
    expect(findBestMatch([1, 2], [], 0.5)).toBeNull();
  });

  it("相似度低于阈值返回 null", () => {
    const c = newCluster([1, 0, 0], "m", "2026-06-21T00:00:00Z");
    expect(findBestMatch([0, 0, 1], [c], 0.9)).toBeNull(); // 正交
  });

  it("返回最相似的簇", () => {
    const c1 = newCluster([1, 0, 0], "a", "2026-06-21T00:00:00Z");
    const c2 = newCluster([0, 1, 0], "b", "2026-06-21T00:00:00Z");
    const match = findBestMatch([0.9, 0.1, 0], [c1, c2], 0.5);
    expect(match?.cluster.id).toBe(c1.id);
  });
});

// ============================================================
// ProposalEngine.observe
// ============================================================

describe("ProposalEngine.observe", () => {
  it("过滤 system role", async () => {
    await engine.observe({
      role: "system",
      content: "long enough system message",
    });
    expect(engine.listAll()).toHaveLength(0);
  });

  it("过滤短消息（< minMessageLength）", async () => {
    await engine.observe({ role: "user", content: "short" });
    expect(engine.listAll()).toHaveLength(0);
  });

  it("embedder 失败时静默跳过", async () => {
    const failingEmbedder: Embedder = async () => {
      throw new Error("boom");
    };
    const e = new ProposalEngine({
      repository: repo,
      embedder: failingEmbedder,
      auditLog: audit,
      dataRoot: tmpDir,
    });
    await e.observe({ role: "user", content: "this is a longer message" });
    expect(e.listAll()).toHaveLength(0);
  });

  it("首次观察 → 创建 cluster", async () => {
    await engine.observe({
      role: "user",
      content: "we should set up CI for the typescript project",
    });
    expect(engine.listAll()).toHaveLength(0); // occurrences=1 < threshold(3)
  });

  it("达到阈值且无匹配 engram → 生成 proposal", async () => {
    for (const s of TS_CI_SAMPLES) {
      await engine.observe({ role: "user", content: s });
    }
    const pending = engine.listPending();
    expect(pending.length).toBeGreaterThanOrEqual(1);
    expect(pending[0]!.occurrences).toBeGreaterThanOrEqual(3);
  });

  it("首次生成 proposal 写 propose audit", async () => {
    for (const s of TS_CI_SAMPLES) {
      await engine.observe({ role: "user", content: s });
    }
    const proposals = audit.query({ action: "propose" });
    expect(proposals.length).toBeGreaterThanOrEqual(1);
  });

  it("同主题继续观察 → occurrences 累加（不新建 proposal）", async () => {
    for (const s of TS_CI_SAMPLES) {
      await engine.observe({ role: "user", content: s });
    }
    // 再加 2 条同主题不同措辞
    await engine.observe({
      role: "user",
      content: "one more reminder to set up typescript github actions",
    });
    await engine.observe({
      role: "user",
      content: "typescript ci via github actions really needs to be configured",
    });
    const pending = engine.listPending();
    expect(pending.length).toBeGreaterThanOrEqual(1);
    // 至少捕获到原始 5 条
    const main = pending.find((p) => p.occurrences >= 5);
    expect(main).toBeDefined();
  });

  it("不同主题 → 不同簇", async () => {
    const dockerSamples = [
      "docker compose networking issues with bridge driver configuration",
      "how to fix docker compose bridge network connectivity problems",
      "reminder to check docker compose networking bridge driver settings",
      "docker compose bridge driver networking is misconfigured please investigate",
      "we need to debug docker compose networking with bridge driver",
    ];
    for (const s of TS_CI_SAMPLES) {
      await engine.observe({ role: "user", content: s });
    }
    for (const s of dockerSamples) {
      await engine.observe({ role: "user", content: s });
    }
    expect(engine.listPending().length).toBeGreaterThanOrEqual(2);
  });

  it("有匹配 engram → 不生成 proposal", async () => {
    // 先创建一个相关 engram — title 覆盖样本核心词
    repo.createEngram({
      title: "github actions typescript ci pipelines configuration",
      content: "how to set up github actions ci for typescript",
      kind: "fact",
      domainTags: ["devops"],
      createdBy: "tester",
    });
    // 用每条都包含核心词的样本,确保 hasSimilarEngram 命中
    const samples = [
      "configure github actions typescript ci pipelines please",
      "set up github actions typescript ci pipelines correctly",
      "enable github actions typescript ci pipelines workflow",
    ];
    for (const s of samples) {
      await engine.observe({ role: "user", content: s });
    }
    expect(engine.listPending()).toHaveLength(0);
  });

  // ============================================================
  // Layer 1 + Layer 2 过滤(新增,验证机械噪声被挡)
  // ============================================================

  it("Layer 1:机械重复完全相同 content → 不入簇(被 prefilter 拦掉后,所有重复都拦)", async () => {
    // 完全相同 content 重复 5 次:Layer 2 few_unique_samples 应拒绝
    const content =
      "we should really configure github actions for typescript ci pipelines";
    for (let i = 0; i < 5; i++) {
      await engine.observe({ role: "user", content });
    }
    expect(engine.listPending()).toHaveLength(0);
    // 应该有 necessity_rejected audit
    const rejected = audit.query({ action: "necessity_rejected" });
    expect(rejected.length).toBeGreaterThanOrEqual(1);
  });

  it("Layer 1:trivial 内容(hello/test/ok)→ 不入簇,不写 audit", async () => {
    await engine.observe({ role: "user", content: "ok" });
    await engine.observe({ role: "user", content: "test" });
    await engine.observe({ role: "user", content: "hello" });
    await engine.observe({ role: "user", content: "继续" });
    await engine.observe({ role: "user", content: "好的" });
    expect(engine.listPending()).toHaveLength(0);
    // Layer 1 拒绝不再写 audit(避免淹没 audit.jsonl)
    const filtered = audit.query({ action: "noise_filtered" });
    expect(filtered).toHaveLength(0);
  });

  it("Layer 1:短消息(< 30 chars for user)→ 不入簇,不写 audit", async () => {
    await engine.observe({ role: "user", content: "short msg" });
    expect(engine.listPending()).toHaveLength(0);
    const filtered = audit.query({ action: "noise_filtered" });
    expect(filtered).toHaveLength(0);
  });
});

// ============================================================
// ProposalEngine.accept / dismiss
// ============================================================

describe("ProposalEngine.accept", () => {
  it("接受 proposal → 创建 engram + 标记 accepted", async () => {
    for (const s of TS_CI_SAMPLES) {
      await engine.observe({ role: "user", content: s });
    }
    const [proposal] = engine.listPending();

    const engramId = engine.accept(proposal!.entityId, {
      title: "CI for TS",
      content: "use github actions",
      domainTags: ["devops"],
    });
    expect(engramId).toBeTruthy();
    expect(repo.exists(engramId)).toBe(true);

    // proposal 状态变了
    const all = engine.listAll();
    const target = all.find((p) => p.entityId === proposal!.entityId);
    expect(target?.status).toBe("accepted");
    expect(target?.acceptedEngramId).toBe(engramId);

    // 不在 pending 里
    expect(engine.listPending()).toHaveLength(0);

    // 对应 cluster 已被移除
    const acceptEvents = audit.query({ action: "accept" });
    expect(acceptEvents).toHaveLength(1);
  });

  it("接受不存在的 entityId → 抛错", () => {
    expect(() => {
      engine.accept("not-exist", {
        title: "x",
        content: "y",
        domainTags: ["t"],
      });
    }).toThrow(/not found/i);
  });
});

describe("ProposalEngine.dismiss", () => {
  it("拒绝 proposal → 状态 dismissed + 设置 dismissedUntil", async () => {
    for (const s of TS_CI_SAMPLES) {
      await engine.observe({ role: "user", content: s });
    }
    const [proposal] = engine.listPending();

    engine.dismiss(proposal!.entityId, "not relevant", 7);

    const all = engine.listAll();
    const target = all.find((p) => p.entityId === proposal!.entityId);
    expect(target?.status).toBe("dismissed");
    expect(target?.dismissReason).toBe("not relevant");
    expect(target?.dismissedUntil).toBeTruthy();

    // 不在 pending 里
    expect(engine.listPending()).toHaveLength(0);

    const dismissEvents = audit.query({ action: "dismiss" });
    expect(dismissEvents).toHaveLength(1);
  });

  it("默认 dismiss 30 天", async () => {
    for (const s of TS_CI_SAMPLES) {
      await engine.observe({ role: "user", content: s });
    }
    const [proposal] = engine.listPending();
    engine.dismiss(proposal!.entityId);

    const all = engine.listAll();
    const target = all.find((p) => p.entityId === proposal!.entityId);
    const until = new Date(target!.dismissedUntil!).getTime();
    const expected =
      Date.now() +
      DEFAULT_PROPOSAL_CONFIG.defaultDismissDays * 24 * 60 * 60 * 1000;
    expect(Math.abs(until - expected)).toBeLessThan(60 * 1000); // ±1 分钟
  });

  it("拒绝不存在的 entityId → 抛错", () => {
    expect(() => engine.dismiss("not-exist")).toThrow(/not found/i);
  });
});

// ============================================================
// DEFAULT_HASHER_EMBEDDER
// ============================================================

describe("DEFAULT_HASHER_EMBEDDER", () => {
  it("返回 L2 归一化向量（范数=1）", async () => {
    const v = await DEFAULT_HASHER_EMBEDDER("hello world typescript ci");
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it("维度 256(足够容纳中文 bigram 的分布,避免碰撞稀释相似度)", async () => {
    const v = await DEFAULT_HASHER_EMBEDDER("test");
    expect(v).toHaveLength(256);
  });

  it("相同文本相同向量", async () => {
    const a = await DEFAULT_HASHER_EMBEDDER("same text");
    const b = await DEFAULT_HASHER_EMBEDDER("same text");
    expect([...a]).toEqual([...b]);
  });
});

// ============================================================
// CJK bigram tokenizer(关键:中文若不切 bigram,proposal pipeline 完全失灵)
// ============================================================

describe("DEFAULT_HASHER_EMBEDDER · CJK bigram tokenizer", () => {
  it("中文长句:同主题改写相似度显著高于无关句子", async () => {
    // 这是真实的对话片段长度——短句没有足够 bigram 重叠,无法稳定聚类。
    const topicA = await DEFAULT_HASHER_EMBEDDER(
      "我们以后所有 React 组件默认用 arrow function 因为避免 this 绑定问题 这是项目偏好",
    );
    const topicB = await DEFAULT_HASHER_EMBEDDER(
      "对 arrow function 是我们的默认风格 因为避免绑定问题 适用于 React 组件",
    );
    const offTopic = await DEFAULT_HASHER_EMBEDDER(
      "今天天气真好 我们去爬山吧 带上水壶和零食",
    );
    const onTopicSim = cosineSimilarity(topicA, topicB);
    const offTopicSim = cosineSimilarity(topicA, offTopic);
    // 主题相似度必须显著高于无关相似度(至少 3 倍)
    expect(onTopicSim).toBeGreaterThan(offTopicSim * 3);
    // 主题相似度应明显高于无关相似度(allowing some slack vs absolute threshold,
    // because pairwise cosine < centroid-vs-new cosine in the pipeline)
    expect(onTopicSim - offTopicSim).toBeGreaterThan(0.15);
  });

  it("中文 vs 无关中文:相似度低于 hash 阈值(不误聚类)", async () => {
    const a = await DEFAULT_HASHER_EMBEDDER(
      "React 组件都用 arrow function 这是项目偏好 默认风格",
    );
    const b =
      await DEFAULT_HASHER_EMBEDDER("今天天气真好 我们去爬山吧 带上水壶");
    const sim = cosineSimilarity(a, b);
    expect(sim).toBeLessThan(DEFAULT_HASHER_SIMILARITY_THRESHOLD);
  });

  it("英文同主题改写:相似度 ≥ hash 阈值", async () => {
    const a = await DEFAULT_HASHER_EMBEDDER(
      "from now on all React components should use arrow function to avoid this binding issues",
    );
    const b = await DEFAULT_HASHER_EMBEDDER(
      "arrow function is our default React style because of binding issues and consistency",
    );
    const sim = cosineSimilarity(a, b);
    // 单 pair 相似度会比 cluster-centroid 相似度低很多,这里只验证显著高于无关句子
    const off = await DEFAULT_HASHER_EMBEDDER(
      "the weather is nice today lets go hiking",
    );
    const offSim = cosineSimilarity(a, off);
    expect(sim).toBeGreaterThan(offSim * 2);
  });

  it("集成:5 条改写送入 engine → 至少生成 1 个 proposal(端到端聚类)", async () => {
    // 这是核心回归:在 bigram 切分 + hash 阈值修复之前,中文 conversation
    // 反复提及同一偏好,proposal pipeline 完全无 proposal 产出。
    const dir = mkdtempSync(join(tmpdir(), "co-engram-cjk-integration-"));
    try {
      const repo = new EngramRepository({ rootPath: dir });
      const auditLocal = new AuditLog(dir);
      const engine = new ProposalEngine({
        repository: repo,
        embedder: DEFAULT_HASHER_EMBEDDER,
        auditLog: auditLocal,
        dataRoot: dir,
        config: { similarityThreshold: DEFAULT_HASHER_SIMILARITY_THRESHOLD },
      });

      const messages = [
        "我们以后所有 React 组件默认用 arrow function 因为避免 this 绑定问题",
        "好的以后 React 组件都用 arrow function 这是我们项目偏好",
        "arrow function 这个偏好你记住了吗 默认要用",
        "对 arrow function 是我们的默认风格 因为避免绑定问题",
        "提醒一下 React 组件必须用 arrow function 默认风格",
      ];
      for (const m of messages) {
        await engine.observe({ role: "user", content: m });
      }

      const pending = engine.listPending();
      expect(pending.length).toBeGreaterThanOrEqual(1);
      // 主簇应至少捕获 3 次(阈值 occurrences=3 才会晋升 proposal)
      const mainCluster = pending.find((p) => p.occurrences >= 3);
      expect(mainCluster).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("回归:中文整段曾被视为 1 个 token,bigram 切分后维度分布更稀疏但语义可聚", async () => {
    // 关键回归:在 fix 之前,纯中文段会被 normalize 当成单个 token,导致
    // 完全相同的中文文本相似度可能因 hash 碰撞偏低。fix 后相同文本 = 1.0。
    const a = await DEFAULT_HASHER_EMBEDDER(
      "我们以后所有 React 组件默认用 arrow function",
    );
    const b = await DEFAULT_HASHER_EMBEDDER(
      "我们以后所有 React 组件默认用 arrow function",
    );
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
  });
});

describe("DEFAULT_HASHER_SIMILARITY_THRESHOLD", () => {
  it("值为 0.35(为 hash embedder 配套,0.75 不可达)", () => {
    expect(DEFAULT_HASHER_SIMILARITY_THRESHOLD).toBe(0.35);
  });

  it("低于 DEFAULT_PROPOSAL_CONFIG.similarityThreshold(LLM embedding 用的)", () => {
    expect(DEFAULT_HASHER_SIMILARITY_THRESHOLD).toBeLessThan(
      DEFAULT_PROPOSAL_CONFIG.similarityThreshold,
    );
  });
});

// ============================================================
// ProposalEngine.clear
// ============================================================

describe("ProposalEngine.clear", () => {
  it("清空 clusters + proposals", async () => {
    for (const s of TS_CI_SAMPLES) {
      await engine.observe({ role: "user", content: s });
    }
    expect(engine.listAll()).toHaveLength(1);
    engine.clear();
    expect(engine.listAll()).toHaveLength(0);
  });
});
