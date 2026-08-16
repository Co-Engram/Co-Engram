import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EngramRepository } from "../src/storage/repository.js";
import { AuditLog } from "../src/observability/audit-log.js";
import {
  collectAuditActivity,
  collectWindowActivity,
  computeModeCalibration,
  readRemState,
  retrievalDeltas,
  saturate,
  writeRemState,
} from "../src/maintenance/insight/activity.js";

let tmpDir: string;
let repo: EngramRepository;
let auditLog: AuditLog;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-insight-activity-"));
  repo = new EngramRepository({ rootPath: tmpDir });
  auditLog = new AuditLog(tmpDir);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function make(title: string) {
  return repo.createEngram({
    title,
    content: `content of ${title}`,
    kind: "fact",
    domainTags: ["t"],
    createdBy: "tester",
  });
}

describe("saturate", () => {
  it("x<=0 → 0;k=3 时 3 个事件 ≈ 0.5(与模式信号半饱和点一致)", () => {
    expect(saturate(0)).toBe(0);
    expect(saturate(-1)).toBe(0);
    expect(saturate(3, 3)).toBeCloseTo(0.5, 9);
  });
});

describe("collectAuditActivity(审计窗口聚合)", () => {
  it("白名单事件加权:reinforce 1.5、普通 update 1.0、external-edit 2.0;同 engram 累加", () => {
    const a = make("A");
    auditLog.append({ actor: "user", action: "reinforce", engramId: a.id });
    auditLog.append({ actor: "system", action: "update", engramId: a.id });
    auditLog.append({
      actor: "user",
      action: "update",
      engramId: a.id,
      metadata: { source: "external-edit" },
    });
    const m = collectAuditActivity(auditLog, null);
    expect(m.get(a.id)).toBeCloseTo(1.5 + 1.0 + 2.0, 6);
  });

  it("白名单外不计(create/propose/maintenance_run/skill_*);engramId 缺失跳过", () => {
    const a = make("A");
    auditLog.append({ actor: "user", action: "create", engramId: a.id });
    auditLog.append({ actor: "llm", action: "propose", engramId: a.id });
    auditLog.append({ actor: "system", action: "maintenance_run" });
    auditLog.append({ actor: "user", action: "skill_create" });
    auditLog.append({ actor: "llm", action: "reinforce" }); // 无 engramId
    const m = collectAuditActivity(auditLog, null);
    expect(m.size).toBe(0);
  });

  it("since 过滤:未来窗口起点 → 窗口外事件排除", () => {
    const a = make("A");
    auditLog.append({ actor: "user", action: "reinforce", engramId: a.id });
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(collectAuditActivity(auditLog, future).size).toBe(0);
    expect(collectAuditActivity(auditLog, null).size).toBe(1);
  });

  it("高频噪音事件(noise_filtered)不挤占扫描窗口:白名单先于噪音写入仍可聚合", () => {
    const a = make("A");
    // 白名单事件先写(文件更早位置),其后灌入远超 limit 的噪音事件
    auditLog.append({ actor: "user", action: "reinforce", engramId: a.id });
    for (let i = 0; i < 12_000; i++) {
      auditLog.append({ actor: "llm", action: "noise_filtered", engramId: a.id });
    }
    const m = collectAuditActivity(auditLog, null);
    expect(m.get(a.id)).toBeCloseTo(1.5, 6);
  });
});

describe("rem-state 检索快照", () => {
  it("writeRemState + readRemState 往返;不留 .tmp 残留", () => {
    const a = make("A");
    repo.bumpRetrievalStats(a.id, { retrievedDelta: 4 });
    writeRemState(tmpDir, repo);
    const snap = readRemState(tmpDir);
    expect(snap).not.toBeNull();
    expect(snap!.retrievalCounts[a.id]).toBe(4);
    expect(existsSync(join(tmpDir, ".co-engram", "rem-state.json.tmp"))).toBe(false);
  });

  it("retrievalDeltas:正增量计入;负增量/新 engram/无快照不计", () => {
    const a = make("A");
    const b = make("B"); // 快照之后新增(快照无记录)
    repo.bumpRetrievalStats(a.id, { retrievedDelta: 3 });
    writeRemState(tmpDir, repo);
    const snap = readRemState(tmpDir)!;
    repo.bumpRetrievalStats(a.id, { retrievedDelta: 2 }); // 窗口检索 +2
    const deltas = retrievalDeltas(repo, snap);
    expect(deltas.get(a.id)).toBe(2);
    expect(deltas.has(b.id)).toBe(false);
    // 无快照 → 空
    expect(retrievalDeltas(repo, null).size).toBe(0);
    // 负增量(快照值高于当前,计数被重置)→ 不计
    const stale = { writtenAt: "", retrievalCounts: { [a.id]: 999 } };
    expect(retrievalDeltas(repo, stale).has(a.id)).toBe(false);
  });

  it("readRemState 损坏 JSON / 缺字段 → null(不 throw)", () => {
    mkdirSync(join(tmpDir, ".co-engram"), { recursive: true });
    writeFileSync(join(tmpDir, ".co-engram", "rem-state.json"), "{broken", "utf8");
    expect(readRemState(tmpDir)).toBeNull();
    writeFileSync(
      join(tmpDir, ".co-engram", "rem-state.json"),
      JSON.stringify({ writtenAt: "x" }),
      "utf8",
    );
    expect(readRemState(tmpDir)).toBeNull();
  });
});

describe("collectWindowActivity(组合)", () => {
  it("audit 事件与检索增量同 engram 叠加(单一量纲「次」)", () => {
    const a = make("A");
    repo.bumpRetrievalStats(a.id, { retrievedDelta: 2 });
    writeRemState(tmpDir, repo);
    repo.bumpRetrievalStats(a.id, { retrievedDelta: 1 }); // 窗口检索 +1
    auditLog.append({ actor: "user", action: "reinforce", engramId: a.id }); // +1.5
    const m = collectWindowActivity({
      repository: repo,
      auditLog,
      dataRoot: tmpDir,
      since: null,
    });
    expect(m.get(a.id)).toBeCloseTo(1 + 1.5, 6);
  });

  it("两数据源全缺 → 空 Map(spread 退化二值)", () => {
    make("A");
    const m = collectWindowActivity({ repository: repo, since: null });
    expect(m.size).toBe(0);
  });
});

describe("computeModeCalibration(模式长期校准)", () => {
  const P = (mode: string, status: string) => ({
    source: "rem-insight",
    status,
    payload: { insightMode: mode },
  });

  it("非 rem-insight 来源与 pending 状态不计", () => {
    const cal = computeModeCalibration([
      {
        source: "conversation",
        status: "accepted",
        payload: { insightMode: "integration" },
      },
      P("integration", "pending"),
    ]);
    expect(cal.size).toBe(0);
  });

  it("冷启动:样本 < minSamples → factor=1,样本数与 acceptRate 仍可见", () => {
    const cal = computeModeCalibration([
      P("integration", "accepted"),
      P("integration", "accepted"),
      P("integration", "dismissed"),
    ]);
    expect(cal.get("integration")!.factor).toBe(1);
    expect(cal.get("integration")!.samples).toBe(3);
    expect(cal.get("integration")!.acceptRate).toBeCloseTo(2 / 3, 9);
  });

  it("5 accept 0 dismiss → ceiling 1.3;0 accept 5 dismiss → floor 0.7;3/6 → 中性 1.0", () => {
    const hi = computeModeCalibration([
      P("integration", "accepted"),
      P("integration", "accepted"),
      P("integration", "accepted"),
      P("integration", "accepted"),
      P("integration", "accepted"),
    ]);
    expect(hi.get("integration")!.factor).toBeCloseTo(1.3, 9);
    const lo = computeModeCalibration([
      P("retrospective", "dismissed"),
      P("retrospective", "dismissed"),
      P("retrospective", "dismissed"),
      P("retrospective", "dismissed"),
      P("retrospective", "dismissed"),
    ]);
    expect(lo.get("retrospective")!.factor).toBeCloseTo(0.7, 9);
    const mid = computeModeCalibration([
      P("inspiration", "accepted"),
      P("inspiration", "accepted"),
      P("inspiration", "accepted"),
      P("inspiration", "dismissed"),
      P("inspiration", "dismissed"),
      P("inspiration", "dismissed"),
    ]);
    expect(mid.get("inspiration")!.factor).toBeCloseTo(1.0, 9);
  });

  it("无效 insightMode(二期模式等)不计", () => {
    const cal = computeModeCalibration([
      { source: "rem-insight", status: "accepted", payload: { insightMode: "critical" } },
    ]);
    expect(cal.size).toBe(0);
  });
});
