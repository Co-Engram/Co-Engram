// T15:单次执行语义(跑完待裁决,不再自动续夜)+ delete + 生命周期审计
// (incubation_round / incubation_conclude / incubation_delete / incubation_pause)
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Incubator, computeNextRunAt, isDue } from "../src/maintenance/insight/incubator.js";
import type { IncubatorDeps } from "../src/maintenance/insight/incubator.js";
import { AuditLog } from "../src/observability/audit-log.js";

let tmpDir: string;
let clockMs: number;
const clockNow = () => new Date(clockMs).toISOString();

type AuditRecord = { actor: string; action: string; metadata?: Record<string, unknown> };
let audit: AuditRecord[];

/** 次日 00:00(本地锚点):与既有测试同手法,跨时区安全 */
function nextAnchor(): Date {
  const anchor = new Date(clockMs);
  anchor.setDate(anchor.getDate() + 1);
  anchor.setHours(0, 0, 0, 0);
  return anchor;
}

function makeIncubator(
  opts: {
    draftText?: string;
    finalText?: string;
    auditLog?: IncubatorDeps["auditLog"];
  } = {},
) {
  audit = [];
  return new Incubator({
    repository: {} as never,
    proposalEngine: {
      proposeInsight: () => true,
      listAll: () => [],
      findProposalByEntityId: () => undefined,
    },
    dataRoot: tmpDir,
    llmClient: {
      complete: async (prompt: string) => {
        if (prompt.includes("FINAL ANSWER")) return opts.finalText ?? "最终回答:方向收敛。";
        return opts.draftText ?? "阶段草稿:第一轮证据成立。";
      },
    } as never,
    // L2 fake:零洞察、零外部调用(单轮最快路径;洞察/诊断面由 round-report 测试覆盖)
    executor: {
      execute: async () => ({
        insights: [],
        plan: [{ step: "盘点", capability: "skills" }],
        trace: [],
        externalCalls: [],
      }),
    },
    auditLog: opts.auditLog ?? {
      append: (e) => {
        audit.push(e as AuditRecord);
      },
    },
    now: clockNow,
  });
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "inc-single-run-"));
  // 当日 12:00(本地):恒在今日锚点后、次日锚点前,不依赖具体时区
  const t0 = new Date();
  t0.setHours(12, 0, 0, 0);
  clockMs = t0.getTime();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("单次执行语义", () => {
  it("跑完一轮 → suggested-resolve;isDue false;computeNextRunAt null(不再自动续夜)", async () => {
    const incubator = makeIncubator();
    const entry = incubator.create({ question: "如何让知识自然生长?", schedule: "00:00" });
    const r = await incubator.incubateOnce(entry.id, "manual");
    expect(r.level).toBe("L2");
    expect(r.proposals).toBe(0);
    expect(r.entry.status).toBe("suggested-resolve");
    const after = incubator.get(entry.id)!;
    expect(after.status).toBe("suggested-resolve");
    expect(after.rounds).toBe(1);
    expect(isDue(after, new Date(clockMs))).toBe(false);
    expect(computeNextRunAt(after, new Date(clockMs))).toBeNull();
    // 排程保留为「单次任务启动时刻」:待裁决态连次日锚点也不会自动跑
    const nextDay = await incubator.runDue(nextAnchor().toISOString());
    expect(nextDay.ran).not.toContain(entry.id);
  });

  it("resolve(false) → active → 下个锚点 due → 再跑一轮 → 又 suggested-resolve", async () => {
    const incubator = makeIncubator();
    const entry = incubator.create({ question: "Q", schedule: "00:00" });
    await incubator.incubateOnce(entry.id, "manual");
    const resumed = incubator.resolve(entry.id, false);
    expect(resumed.status).toBe("active");
    expect(resumed.resumedAt).toBeTruthy();
    // 同日:今日锚点(00:00)≤ lastHatchedAt(12:00)→ 不 due
    expect(isDue(incubator.get(entry.id)!, new Date(clockMs))).toBe(false);
    expect(computeNextRunAt(incubator.get(entry.id)!, new Date(clockMs))).not.toBeNull();
    // 推进到次日锚点 → due → runDue 再跑一轮
    clockMs = nextAnchor().getTime();
    expect(isDue(incubator.get(entry.id)!, new Date(clockMs))).toBe(true);
    const r = await incubator.runDue();
    expect(r.ran).toContain(entry.id);
    const after = incubator.get(entry.id)!;
    expect(after.rounds).toBe(2);
    expect(after.status).toBe("suggested-resolve");
  });
});

describe("delete", () => {
  it("不存在 → throw;in-flight 拒绝;删后 list 不含、get undefined,其余条目不受影响", () => {
    const incubator = makeIncubator();
    expect(() => incubator.delete("inc-nonexistent")).toThrow(/not found/);
    const keep = incubator.create({ question: "保留条目" });
    const victim = incubator.create({ question: "待删除条目" });
    incubator.acquireInFlight(victim.id, "test");
    expect(() => incubator.delete(victim.id)).toThrow(/in-flight/);
    expect(incubator.list().map((e) => e.id)).toContain(victim.id); // 拒绝时未误删
    incubator.releaseInFlight(victim.id);
    expect(incubator.delete(victim.id)).toBeUndefined();
    expect(incubator.list().map((e) => e.id)).toEqual([keep.id]);
    expect(incubator.get(victim.id)).toBeUndefined();
  });
});

describe("生命周期审计(四类 action)", () => {
  it("round/pause/conclude/delete 各一条,metadata 关键字段齐备(diagnosis 嵌套对象直落)", async () => {
    const incubator = makeIncubator();
    const entry = incubator.create({ question: "审计问题", schedule: "00:00" });
    await incubator.incubateOnce(entry.id, "manual"); // → incubation_round
    incubator.pause(entry.id); // → incubation_pause
    incubator.resolve(entry.id, false); // 回 active(裁决动作,不在本期审计范围)
    await incubator.conclude(entry.id); // → incubation_conclude
    incubator.delete(entry.id); // → incubation_delete

    const round = audit.filter((e) => e.action === "incubation_round");
    expect(round).toHaveLength(1);
    expect(round[0]!.actor).toBe("night-thinking-L2");
    expect(round[0]!.metadata).toMatchObject({
      incubationId: entry.id,
      round: 1,
      trigger: "manual",
      proposals: 0,
      drafts: 0,
    });
    // diagnosis 以嵌套对象入 metadata(audit.jsonl 按行 JSON 序列化,天然支持)
    expect(round[0]!.metadata!.diagnosis).toEqual({
      drafts: 0,
      dupVetoed: 0,
      validateRejected: 0,
      criticRejected: 0,
      llmClientMissing: false,
    });
    expect(round[0]!.metadata!.answerDraftPreview).toBe("阶段草稿:第一轮证据成立。");

    const paused = audit.filter((e) => e.action === "incubation_pause");
    expect(paused).toHaveLength(1);
    expect(paused[0]!.actor).toBe("user");
    expect(paused[0]!.metadata).toEqual({ incubationId: entry.id });

    const concluded = audit.filter((e) => e.action === "incubation_conclude");
    expect(concluded).toHaveLength(1);
    expect(concluded[0]!.metadata).toMatchObject({
      incubationId: entry.id,
      finalAnswerPreview: "最终回答:方向收敛。",
    });

    const deleted = audit.filter((e) => e.action === "incubation_delete");
    expect(deleted).toHaveLength(1);
    expect(deleted[0]!.metadata).toEqual({ incubationId: entry.id, question: "审计问题" });
  });

  it("answerDraft 超长 → answerDraftPreview 截断至 200", async () => {
    const incubator = makeIncubator({ draftText: "草".repeat(500) });
    const entry = incubator.create({ question: "截断问题" });
    await incubator.incubateOnce(entry.id, "manual");
    const round = audit.find((e) => e.action === "incubation_round")!;
    expect(round).toBeDefined();
    expect((round.metadata!.answerDraftPreview as string).length).toBe(200);
  });

  it("conclude finalAnswer 超长 → finalAnswerPreview 截断至 200", async () => {
    const incubator = makeIncubator({ finalText: "答".repeat(300) });
    const entry = incubator.create({ question: "收束截断问题" });
    await incubator.conclude(entry.id);
    const concluded = audit.find((e) => e.action === "incubation_conclude")!;
    expect(concluded).toBeDefined();
    expect((concluded.metadata!.finalAnswerPreview as string).length).toBe(200);
  });

  it("真实 AuditLog 序列化:incubation_round 嵌套 diagnosis 落 audit.jsonl 后逐行可解析", async () => {
    // fake auditLog 只证明调用形状;这里用真实 AuditLog 锁「嵌套 metadata 经
    // JSON.stringify 按行落盘、回读仍完整」的序列化契约
    const incubator = makeIncubator({ auditLog: new AuditLog(tmpDir) });
    const entry = incubator.create({ question: "真实序列化问题" });
    await incubator.incubateOnce(entry.id, "manual");
    const raw = readFileSync(join(tmpDir, ".co-engram", "audit.jsonl"), "utf8");
    const round = raw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as AuditRecord)
      .find((e) => e.action === "incubation_round");
    expect(round).toBeDefined();
    expect(round!.metadata!.incubationId).toBe(entry.id);
    expect(round!.metadata!.diagnosis).toEqual({
      drafts: 0,
      dupVetoed: 0,
      validateRejected: 0,
      criticRejected: 0,
      llmClientMissing: false,
    });
    expect(round!.metadata!.answerDraftPreview).toBe("阶段草稿:第一轮证据成立。");
  });
});
