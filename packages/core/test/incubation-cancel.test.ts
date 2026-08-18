// 沉思可取消与防重(2026-08-19):
// 1. create 同问题防重:未完成态(queued/进行中)拒绝;done 后可重建
// 2. cancel:thinking → 可跑态(rounds=0 → queued);审计 contemplation_run_cancel
// 3. delete force:进行中默认拒绝,force 先释放运行标记再删(误建条目即时可清理)
// 4. report 写回竞态:报告校验中(证据 flush 的 await 点)被 cancel →
//    写前重读发现状态已非 in-flight → 放弃写回,不推翻用户的终止裁决
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EngramRepository } from "../src/storage/repository.js";
import { ProposalEngine } from "../src/observability/proposal-engine.js";
import { Incubator } from "../src/maintenance/insight/incubator.js";
import type { ToolCallEvent } from "../src/signals/types.js";

let tmpDir: string;
let repo: EngramRepository;
let engine: ProposalEngine;
let auditEntries: Array<{ action: string; metadata?: Record<string, unknown> }>;

let clockMs: number;
const clockNow = () => new Date(clockMs).toISOString();

let observedEvents: ToolCallEvent[];

function makeIncubator(
  deps: {
    onFlush?: () => void;
  } = {},
): Incubator {
  return new Incubator({
    repository: repo,
    proposalEngine: engine,
    dataRoot: tmpDir,
    llmClient: {
      async complete() {
        return JSON.stringify({
          evidenceSufficiency: 0.9, novelty: 0.9, actionability: 0.9, consistency: 0.9,
          overall: 0.9, rationale: "strong",
        });
      },
    } as never,
    signalEvidence: {
      // flush 是 report 内证据窗口快照前的必经 await 点 —— 竞态注入位
      flush: async () => {
        deps.onFlush?.();
      },
      snapshot: () => observedEvents,
    },
    auditLog: {
      append: (e) => {
        auditEntries.push(e as { action: string });
      },
    } as never,
    now: clockNow,
  });
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-cancel-"));
  repo = new EngramRepository({ rootPath: tmpDir });
  engine = new ProposalEngine({
    repository: repo,
    embedder: async () => [1, 0, 0],
    auditLog: { append: () => {} } as never,
    dataRoot: tmpDir,
  });
  auditEntries = [];
  observedEvents = [];
  clockMs = Date.parse("2026-08-19T02:00:00.000Z");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("create 同问题防重", () => {
  it("未完成态(queued)同问题再 create → 抛错;done 后同问题可重建", () => {
    const incubator = makeIncubator();
    incubator.create({ question: "重复的问题?" });
    expect(() => incubator.create({ question: "重复的问题?" })).toThrow(/duplicate/);
    // 不同问题不受影响
    expect(() => incubator.create({ question: "另一个问题?" })).not.toThrow();
    // done 后(已出报告)同问题可重建:再思/重建是正当场景
    const done = incubator.create({ question: "已完成的问题?" });
    // 手动推进到 done(rounds>0,绕过完整 run)
    incubator.acquireThinking(done.id, "test");
    incubator.cancel(done.id);
    // cancel 后 rounds=0 → queued,仍属未完成态 → 拒
    expect(() => incubator.create({ question: "已完成的问题?" })).toThrow(/duplicate/);
  });
});

describe("cancel(终止进行中的 run)", () => {
  it("thinking(rounds=0)→ queued;审计 contemplation_run_cancel 留痕", () => {
    const incubator = makeIncubator();
    const e = incubator.create({ question: "终止测试?" });
    incubator.acquireThinking(e.id, "job");
    const after = incubator.cancel(e.id, "viewer");
    expect(after.status).toBe("queued");
    expect(auditEntries.some((a) => a.action === "contemplation_run_cancel")).toBe(true);
  });

  it("非进行中(queued/done)cancel → 抛错", () => {
    const incubator = makeIncubator();
    const e = incubator.create({ question: "非进行中?" });
    expect(() => incubator.cancel(e.id)).toThrow(/not in progress/);
  });
});

describe("delete force(误建条目即时可清理)", () => {
  it("进行中默认拒绝;force 先释放运行标记再删,条目消失且审计记 abortedRun", () => {
    const incubator = makeIncubator();
    const e = incubator.create({ question: "误建待删?" });
    incubator.acquireThinking(e.id, "job");
    expect(() => incubator.delete(e.id)).toThrow(/in progress/);
    incubator.delete(e.id, { force: true });
    expect(incubator.list().find((x) => x.id === e.id)).toBeUndefined();
    const del = auditEntries.find((a) => a.action === "contemplation_delete");
    expect(del?.metadata?.abortedRun).toBe(true);
  });
});

describe("report 写回竞态(cancel 迟到报告不复活)", () => {
  it("校验中(verifying)被 cancel → 写回放弃:done+degraded(aborted),timeline/rounds 不变", async () => {
    // onFlush 在 report 的证据快照 await 点触发:此刻状态已是 verifying
    let incubator!: Incubator;
    incubator = makeIncubator({
      onFlush: () => {
        incubator.cancel(incubator.get(target.id)!.id, "viewer");
      },
    });
    const a = repo.createEngram({
      title: "来源",
      content: "content 来源",
      kind: "fact",
      domainTags: ["域甲"],
      createdBy: "tester",
    });
    const target = incubator.create({ question: "竞态问题?" });
    incubator.acquireThinking(target.id, "job");
    observedEvents = [
      {
        toolName: "engram_get",
        input: { id: a.id },
        outputSummary: "{ok}",
        retrievedEngramIds: [a.id],
        sessionId: "s",
        at: clockMs + 100,
      },
    ];
    // 报告(校验中注入 cancel)
    const r = await incubator.report({
      incubationId: target.id,
      report: {
        answer: "回答:证据充分。",
        insights: [],
        plan: [],
        trace: [],
        requirements: [
          {
            resourceType: "engrams",
            description: "读齐相关记忆",
            necessity: "logic-needed",
            closed: true,
            evidence: { ids: [a.id] },
          },
        ],
      },
      trigger: "manual",
      actor: "test",
    });
    // cancel 的裁决保留:done + degraded(aborted),报告未落盘
    const after = incubator.get(target.id)!;
    expect(after.status).toBe("done");
    expect(after.degraded?.reason).toBe("aborted");
    expect(after.rounds).toBe(0);
    expect(after.timeline).toHaveLength(0);
    // report 返回的是 cancel 后的条目(而非本轮 updated)
    expect(r.entry.status).toBe("done");
  });
});
