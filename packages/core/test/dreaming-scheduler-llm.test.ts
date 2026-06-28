import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngramRepository } from "../src/storage/repository.js";
import { createDreamingScheduler } from "../src/dreaming/scheduler.js";
import type { LlmClient } from "../src/observability/necessity-evaluator.js";

let tmpDir: string;
let repo: EngramRepository;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-scheduler-llm-"));
  repo = new EngramRepository({ rootPath: tmpDir });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeEngram(input: {
  title: string;
  content: string;
  kind?: "observation" | "fact" | "pattern" | "procedure" | "hypothesis";
}) {
  return repo.createEngram({
    title: input.title,
    content: input.content,
    kind: input.kind ?? "observation",
    domainTags: ["testing"],
    createdBy: "y",
    importance: 0.5,
  });
}

describe("createDreamingScheduler + llmClient 注入 (Feature 2)", () => {
  it("注入 llmClient 后,REM 阶段调用 LLM 并产生 pattern engram", async () => {
    // 准备 3 个相似 engram,聚类时能进同一 cluster
    for (let i = 0; i < 3; i++) {
      makeEngram({
        title: `ADB wireless 调试 ${i}`,
        content: `adb wireless debugging android device ${i}`,
      });
    }

    let llmCalled = 0;
    const fakeClient: LlmClient = {
      async complete() {
        llmCalled += 1;
        return JSON.stringify({
          title: "ADB wireless 调试通用模式",
          summary: "Android 设备 ADB 无线调试的统一方法。",
          content:
            "# ADB wireless 调试\n\n多设备共享的连接配置流程。",
          domainTags: ["android", "adb", "debugging"],
          confidence: 0.95,
          reason: "三个观察共享相同流程",
        });
      },
    };

    const scheduler = createDreamingScheduler(repo, {
      llmClient: fakeClient,
      remIntervalMs: 1000 * 60 * 60 * 24, // 不会真触发,只看 trigger
    });

    const records: Array<{ stage: string; result: unknown }> = [];
    scheduler.onRun((r) => records.push({ stage: r.stage, result: r.result }));

    // trigger 同步返回 placeholder record;真实 result 通过 onRun 异步到达
    scheduler.trigger("rem");

    // 等待 onRun 异步到达
    await new Promise((resolve) => setTimeout(resolve, 200));

    const remRecord = records.find((r) => r.stage === "rem");
    expect(remRecord).toBeDefined();
    const result = (remRecord!.result as {
      adopted: Array<{ patternEngramId: string }>;
    }).adopted;
    expect(result.length).toBeGreaterThan(0);
    expect(llmCalled).toBeGreaterThan(0);

    // pattern engram 真的落盘
    const patternId = result[0]!.patternEngramId;
    expect(repo.exists(patternId)).toBe(true);
    const patternEngram = repo.readEngram(patternId);
    expect(patternEngram.kind).toBe("pattern");
    expect(patternEngram.title).toBe("ADB wireless 调试通用模式");
  });

  it("不注入 llmClient 时,REM 保持原 LocalHeuristic 行为", async () => {
    for (let i = 0; i < 3; i++) {
      makeEngram({
        title: `观察 ${i}`,
        content: `shared content ${i} with overlapping tokens`,
      });
    }

    const scheduler = createDreamingScheduler(repo, {
      remIntervalMs: 1000 * 60 * 60 * 24,
    });

    const records: Array<{ stage: string; result: unknown }> = [];
    scheduler.onRun((r) => records.push({ stage: r.stage, result: r.result }));

    scheduler.trigger("rem");
    await new Promise((resolve) => setTimeout(resolve, 200));

    const remRecord = records.find((r) => r.stage === "rem");
    expect(remRecord).toBeDefined();
    // LocalHeuristic 默认 confidence 可能不达 0.85,但 proposals 应有
    const result = (remRecord!.result as {
      proposals: unknown[];
    }).proposals;
    expect(result.length).toBeGreaterThan(0);
  });

  it("显式 remOptions.abstractionProvider 优先于 llmClient 自动构造", async () => {
    for (let i = 0; i < 3; i++) {
      makeEngram({
        title: `X ${i}`,
        content: `shared content ${i}`,
      });
    }

    let llmCalled = 0;
    let explicitCalled = 0;
    const fakeClient: LlmClient = {
      async complete() {
        llmCalled += 1;
        return JSON.stringify({
          title: "Should not be used",
          content: "x",
          summary: "y",
          confidence: 0.99,
        });
      },
    };

    const scheduler = createDreamingScheduler(repo, {
      llmClient: fakeClient,
      remOptions: {
        abstractionProvider: {
          async abstract() {
            explicitCalled += 1;
            return {
              title: "Explicit provider won",
              content: "x",
              summary: "y",
              confidence: 0.99,
              reason: "explicit",
            };
          },
        },
        minClusterSize: 3,
        clustering: { similarityThreshold: 0.1 },
        autoAdoptionThreshold: 0.5,
      },
    });

    const records: Array<{ stage: string; result: unknown }> = [];
    scheduler.onRun((r) => records.push({ stage: r.stage, result: r.result }));

    scheduler.trigger("rem");
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(explicitCalled).toBeGreaterThan(0);
    expect(llmCalled).toBe(0);

    const remRecord = records.find((r) => r.stage === "rem");
    const adopted = (
      remRecord!.result as {
        adopted: Array<{ proposal: { title: string } }>;
      }
    ).adopted;
    expect(adopted.length).toBeGreaterThan(0);
    expect(adopted[0]!.proposal.title).toBe("Explicit provider won");
  });
});
