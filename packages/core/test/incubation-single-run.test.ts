// 单次执行语义(2026-08-17 重设计:跑完即 done,无仪式/排程)+ delete + 生命周期审计
// (contemplation_run_done / contemplation_delete / contemplation_run_start)
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
        criticUnparseable: 0,
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
      criticUnparseable: 0,
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

// 单跑收尾(2026-08-19):report 带 openGaps 时条目停在 repairing 等修复轮,
// 而 headless 单跑(incubateOnce 驱动)没有后续轮 —— 会挂到 30min TTL,
// 页面呈现「无终态」(部署实测用户两次深思都停在 repairing/verifying,
// 误以为失败,实际 answer 已交付)。修复:incubateOnce 收尾立即按缺口
// 收束(single-run-gaps),answer 保留、缺口清单落 degraded。
describe("单跑缺口立即收束(single-run-gaps)", () => {
  it("报告带缺口 → 立即 done + single-run-gaps,answer 保留", async () => {
    const observedId = "01OBSERVED-ID";
    const incubator = new Incubator({
      repository: {} as never,
      proposalEngine: {
        proposeInsight: () => true,
        listAll: () => [],
        findProposalByEntityId: () => undefined,
        setInsightClosureState: () => undefined,
      },
      dataRoot: tmpDir,
      llmClient: {
        complete: async () => "兜底综合。",
      } as never,
      executor: {
        // 有证据(观察到 1 次 engram 读)但只闭合 1 项 —— template 计划的
        // 其余项由引擎合成 open 缺口 → repairing → 单跑收尾
        execute: async () => ({
          answer: "带缺口的回答",
          insights: [],
          plan: [],
          trace: [],
          requirements: [
            {
              resourceType: "engrams",
              description: "已闭合项",
              closed: true,
              evidence: { ids: [observedId] },
            },
          ],
        }),
      },
      signalEvidence: {
        snapshot: () => [
          {
            toolName: "engram_get",
            input: { id: observedId },
            outputSummary: "{ok}",
            retrievedEngramIds: [observedId],
            sessionId: "s",
            at: clockMs + 100,
          },
        ],
        flush: async () => {},
      },
      auditLog: {
        append: (e) => {
          audit.push(e as AuditRecord);
        },
      },
      now: clockNow,
    });
    const e = incubator.create({ question: "带缺口问题?" });
    await incubator.incubateOnce(e.id, "manual"); // 有证据,不整单拒
    const entry = incubator.get(e.id)!;
    expect(entry.status).toBe("done"); // 不再挂 repairing
    expect(entry.degraded?.reason).toBe("single-run-gaps");
    expect(entry.answer).toBe("带缺口的回答"); // answer 保留交付
    expect(entry.degraded?.unclosedGaps.length).toBeGreaterThan(0);
  });
});

// 提案隔离分流(2026-08-19 产品裁决):single-run-gaps 收束**解除**隔离 ——
// 单跑沉思已交付 answer 与过审提案,计划部分缺口与提案质量是两个维度;
// 修复失败 / TTL / 中断类成因保留固化隔离。
describe("收束的提案隔离分流", () => {
  function seedRepairing(
    incubator: Incubator,
    id: string,
    withProposal = true,
  ): void {
    const { mkdirSync, writeFileSync: wf } = require("node:fs");
    const dir = join(tmpDir, ".co-engram");
    mkdirSync(dir, { recursive: true });
    wf(
      join(dir, "incubations.json"),
      JSON.stringify([
        {
          id,
          question: "隔离分流?",
          seedEngramIds: [],
          status: "repairing",
          rounds: 1,
          createdAt: clockNow(),
          lastRunAt: null,
          timeline: [
            {
              at: clockNow(),
              trigger: "manual",
              round: 1,
              summaries: [],
              proposalEntityIds: withProposal ? ["ent-1"] : [],
            },
          ],
          thinkingAt: clockNow(),
          thinkingBy: "test",
          run: {
            startedAt: clockNow(),
            reports: 1,
            repairReports: 0,
            gaps: [
              {
                hash: "h1",
                resourceType: "engrams",
                description: "缺口A",
                necessity: "helpful",
                state: "open",
                reopens: 0,
                cause: "unclosed",
              },
            ],
          },
        },
      ]),
    );
    void incubator;
  }

  it("single-run-gaps → setInsightClosureState(ids, undefined) 解除", () => {
    const calls: unknown[][] = [];
    const incubator = new Incubator({
      repository: {} as never,
      proposalEngine: {
        proposeInsight: () => true,
        listAll: () => [],
        findProposalByEntityId: () => undefined,
        setInsightClosureState: (...args: unknown[]) => {
          calls.push(args);
        },
      },
      dataRoot: tmpDir,
      llmClient: { complete: async () => "x" } as never,
      auditLog: { append: () => {} },
      now: clockNow,
    });
    seedRepairing(incubator, "inc-relieve");
    incubator.releaseThinking("inc-relieve", { reason: "single-run-gaps" });
    expect(calls).toEqual([[["ent-1"], undefined]]);
    const entry = incubator.get("inc-relieve")!;
    expect(entry.status).toBe("done");
    expect(entry.degraded?.reason).toBe("single-run-gaps");
    expect(entry.degraded?.unclosedGaps).toEqual(["缺口A"]);
  });

  it("ttl-expired 类(非单跑)→ 固化隔离(unclosedGaps 随 degraded 落标)", () => {
    const calls: unknown[][] = [];
    const incubator = new Incubator({
      repository: {} as never,
      proposalEngine: {
        proposeInsight: () => true,
        listAll: () => [],
        findProposalByEntityId: () => undefined,
        setInsightClosureState: (...args: unknown[]) => {
          calls.push(args);
        },
      },
      dataRoot: tmpDir,
      llmClient: { complete: async () => "x" } as never,
      auditLog: { append: () => {} },
      now: clockNow,
    });
    seedRepairing(incubator, "inc-quarantine");
    incubator.releaseThinking("inc-quarantine", { reason: "ttl-expired" });
    expect(calls.length).toBe(1);
    expect(calls[0]![0]).toEqual(["ent-1"]);
    expect(calls[0]![1]).toMatchObject({
      provisional: false,
      unclosedGaps: ["缺口A"],
    });
  });
});

// report 总超时兜底(2026-08-19 E2E 实测):executor 有 20min 超时,但
// report() 内部的 LLM await 无超时 —— headless 死亡/LLM 挂起时链条悬挂,
// 条目挂 thinking 到 30min TTL,用户全程无反馈。外层 25min 总超时按
// aborted 收束(thinking 无报告 → 回退 queued 可重跑)。
describe("report 总超时兜底", () => {
  it("report 悬挂 → 25min 超时 reject + 条目回退 queued", async () => {
    vi.useFakeTimers();
    try {
      const incubator = makeIncubator();
      vi.spyOn(incubator, "report" as never).mockReturnValue(
        new Promise(() => {}) as never,
      );
      const e = incubator.create({ question: "悬挂问题?" });
      const pending = incubator.incubateOnce(e.id, "manual");
      const expectation = expect(pending).rejects.toThrow(/report timeout/);
      await vi.advanceTimersByTimeAsync(25 * 60_000 + 100);
      await expectation;
      expect(incubator.get(e.id)?.status).toBe("queued");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("启动恢复:recoverStale(宿主进程死亡后的固化收束)", () => {
  const storePath = () => join(tmpDir, ".co-engram", "incubations.json");

  it("超时遗留的 thinking(rounds=0)→ 固化 queued + 审计;幂等二次扫描零动作", () => {
    const incubator = makeIncubator();
    const e = incubator.create({ question: "恢复问题?" });
    // 模拟驱动进程死亡前的 in-flight:已 acquireThinking 但无人再写回
    incubator.acquireThinking(e.id, "incubateOnce:manual");
    clockMs += 31 * 60_000; // 越过 30min TTL
    const rebooted = makeIncubator(); // 新宿主进程装配(同 dataRoot)
    const diffs = rebooted.recoverStale();
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({
      id: e.id,
      from: "thinking",
      to: "queued",
      reason: "ttl-expired-thinking",
    });
    // 盘上已固化(非仅读时映射):直读原始 JSON 验证
    const onDisk = JSON.parse(readFileSync(storePath(), "utf8")) as Array<{
      id: string; status: string;
    }>;
    expect(onDisk.find((x) => x.id === e.id)?.status).toBe("queued");
    expect(audit.some((a) => a.action === "contemplation_recovered")).toBe(true);
    // 幂等:再次扫描零 diff
    expect(rebooted.recoverStale()).toHaveLength(0);
  });

  it("超时遗留的 repairing(带 open gap)→ 固化 done + degraded(ttl-expired)", () => {
    const incubator = makeIncubator();
    const e = incubator.create({ question: "修复中死亡?" });
    incubator.acquireThinking(e.id, "incubateOnce:manual");
    // 手工落 repairing 态(驱动进程死于 report 之后的修复等待期)
    const raw = JSON.parse(readFileSync(storePath(), "utf8")) as Array<Record<string, unknown>>;
    const idx = raw.findIndex((x) => x.id === e.id);
    raw[idx] = {
      ...raw[idx],
      status: "repairing",
      run: {
        startedAt: raw[idx]!.thinkingAt,
        reports: 1,
        repairReports: 0,
        gaps: [{
          hash: "h1", resourceType: "engrams", description: "图谱盘点",
          necessity: "logic-needed", state: "open", reopens: 0,
        }],
      },
    };
    // @ts-expect-error 测试直写文件系统
    writeFileSync(storePath(), JSON.stringify(raw, null, 2));
    clockMs += 31 * 60_000;
    const rebooted = makeIncubator();
    const diffs = rebooted.recoverStale();
    expect(diffs[0]).toMatchObject({
      id: e.id,
      from: "repairing",
      to: "done",
      reason: "ttl-expired",
    });
    const after = rebooted.get(e.id);
    expect(after?.status).toBe("done");
    expect(after?.degraded?.unclosedGaps).toEqual(["图谱盘点"]);
  });

  it("TTL 内的 in-flight 不被回收(原样保留,零审计)", () => {
    const incubator = makeIncubator();
    const e = incubator.create({ question: "仍在跑?" });
    incubator.acquireThinking(e.id, "incubateOnce:manual");
    clockMs += 10 * 60_000; // 10min < 30min
    const rebooted = makeIncubator();
    expect(rebooted.recoverStale()).toHaveLength(0);
    const onDisk = JSON.parse(readFileSync(storePath(), "utf8")) as Array<{
      id: string; status: string;
    }>;
    expect(onDisk.find((x) => x.id === e.id)?.status).toBe("thinking");
  });
});
