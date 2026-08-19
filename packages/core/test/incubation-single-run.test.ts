// 单次执行语义(2026-08-17 重设计:跑完即 done,无仪式/排程)+ delete + 生命周期审计
// (contemplation_run_done / contemplation_delete / contemplation_run_start)
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Incubator } from "../src/maintenance/insight/incubator.js";
import type { IncubatorDeps } from "../src/maintenance/insight/incubator.js";
import { AuditLog } from "../src/observability/audit-log.js";

let tmpDir: string;
let clockMs: number;
const clockNow = () => new Date(clockMs).toISOString();

type AuditRecord = {
  actor: string;
  action: string;
  metadata?: Record<string, unknown>;
};
let audit: AuditRecord[];

function makeIncubator(
  opts: {
    answerText?: string;
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
      complete: async () => "兜底综合:第一轮证据成立。",
    } as never,
    // L2 fake:零洞察 + 执行现场 answer(单轮最快路径;洞察/诊断面由 round-report 覆盖)
    executor: {
      execute: async () => ({
        answer: opts.answerText ?? "执行现场回答:方向收敛。",
        insights: [],
        plan: [{ step: "盘点", capability: "skills" }],
        trace: [],
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
  const t0 = new Date();
  t0.setHours(12, 0, 0, 0);
  clockMs = t0.getTime();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("单次执行语义", () => {
  it("跑完一轮 → done;再思(acquireThinking)可再次运行", async () => {
    const incubator = makeIncubator();
    const e = incubator.create({ question: "单次执行问题?" });
    const r = await incubator.incubateOnce(e.id, "manual");
    expect(r.level).toBe("L2");
    expect(incubator.get(e.id)?.status).toBe("done");
    expect(incubator.get(e.id)?.answer).toBe("执行现场回答:方向收敛。");
    // done 可再思:acquireThinking 通过 → thinking
    expect(incubator.acquireThinking(e.id, "rethink")).toBe(true);
    expect(incubator.get(e.id)?.status).toBe("thinking");
  });
});

describe("delete", () => {
  it("不存在 → throw;thinking 拒绝;删后 list 不含、get undefined,其余条目不受影响", () => {
    const incubator = makeIncubator();
    expect(() => incubator.delete("inc-nonexistent")).toThrow(/not found/);
    const keep = incubator.create({ question: "保留条目?" });
    const victim = incubator.create({ question: "待删除条目?" });
    incubator.acquireThinking(victim.id, "test");
    expect(() => incubator.delete(victim.id)).toThrow(/thinking/);
    expect(incubator.list().map((e) => e.id)).toContain(victim.id); // 拒绝时未误删
    incubator.releaseThinking(victim.id);
    expect(incubator.delete(victim.id)).toBeUndefined();
    expect(incubator.list().map((e) => e.id)).toEqual([keep.id]);
    expect(incubator.get(victim.id)).toBeUndefined();
  });
});

describe("生命周期审计(run_start / run_done / delete)", () => {
  it("三类 action 齐备,metadata 关键字段齐备(diagnosis 嵌套对象直落)", async () => {
    const incubator = makeIncubator();
    const e = incubator.create({ question: "审计问题?" });
    await incubator.incubateOnce(e.id, "manual");
    incubator.delete(e.id);
    const start = audit.find((x) => x.action === "contemplation_run_start")!;
    const done = audit.find((x) => x.action === "contemplation_run_done")!;
    const del = audit.find((x) => x.action === "contemplation_delete")!;
    expect(start).toBeDefined();
    expect(start.metadata).toMatchObject({ id: e.id });
    expect(done).toBeDefined();
    expect(done.metadata).toMatchObject({
      id: e.id,
      level: "L2",
      proposals: 0,
      drafts: 0,
      diagnosis: {
        drafts: 0,
        dupVetoed: 0,
        validateRejected: 0,
        criticRejected: 0,
        llmClientMissing: false,
      },
    });
    expect(del).toBeDefined();
    expect(del.metadata).toMatchObject({ id: e.id, sessions: 1 });
  });

  it("answer 超长 → answerPreview 截断至 200", async () => {
    const incubator = makeIncubator({ answerText: "答".repeat(500) });
    const entry = incubator.create({ question: "截断问题?" });
    await incubator.incubateOnce(entry.id, "manual");
    const done = audit.find((e) => e.action === "contemplation_run_done")!;
    expect(done).toBeDefined();
    expect((done.metadata!.answerPreview as string).length).toBe(200);
  });

  it("真实 AuditLog 序列化:contemplation_run_done 嵌套 diagnosis 落 audit.jsonl 后逐行可解析", async () => {
    // fake auditLog 只证明调用形状;这里用真实 AuditLog 锁「嵌套 metadata 经
    // JSON.stringify 按行落盘、回读仍完整」的序列化契约
    const incubator = makeIncubator({ auditLog: new AuditLog(tmpDir) });
    const entry = incubator.create({ question: "真实序列化问题?" });
    await incubator.incubateOnce(entry.id, "manual");
    const raw = readFileSync(join(tmpDir, ".co-engram", "audit.jsonl"), "utf8");
    const done = raw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as AuditRecord)
      .find((e) => e.action === "contemplation_run_done");
    expect(done).toBeDefined();
    expect(done!.metadata!.id).toBe(entry.id);
    expect(done!.metadata!.diagnosis).toEqual({
      drafts: 0,
      dupVetoed: 0,
      validateRejected: 0,
      criticRejected: 0,
      llmClientMissing: false,
    });
    expect(done!.metadata!.answerPreview).toBe("执行现场回答:方向收敛。");
  });
});

// 闭合校验拒绝收束(2026-08-19):零盘点拒绝此前落 degraded{reason:"aborted",
// unclosedGaps:[]}——「执行中断 + 未闭合需求空清单」的矛盾展示(部署实测
// 用户看到「未闭合需求:——」)。修复后 reason=closure-rejected、缺口回落
// 计划全量、失败原因落 answerError。
describe("闭合校验拒绝收束(closure-rejected)", () => {
  it("零盘点拒绝 → closure-rejected + 计划全量未闭合 + answerError", async () => {
    const incubator = makeIncubator();
    const withEvidence = incubator as unknown as {
      deps: { signalEvidence?: { snapshot(): unknown[] } };
    };
    // 注入证据面(快照返回空 = 有证据面但零调用)→ 触发「零盘点」拒绝
    withEvidence.deps.signalEvidence = {
      snapshot: () => [],
      flush: async () => {},
    };
    const e = incubator.create({ question: "零盘点问题?" });
    await expect(incubator.incubateOnce(e.id, "manual")).rejects.toThrow(
      /rejected by closure check/,
    );
    const entry = incubator.get(e.id)!;
    expect(entry.status).toBe("done");
    expect(entry.degraded?.reason).toBe("closure-rejected");
    // gaps 从未被逐项比对填充 → 回落 run.plan 全量(template 计划 5 项)
    expect(entry.degraded?.unclosedGaps.length).toBeGreaterThan(0);
    expect(entry.answerError ?? "").toContain("closure check");
  });
});
