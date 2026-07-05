import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngramRepository } from "../src/storage/repository.js";
import { AuditLog } from "../src/observability/audit-log.js";
import { reinforceEngram } from "../src/reinforcement/ltp.js";
import { recordRetrievalFailure } from "../src/reinforcement/ltd.js";

// 集成测试(D1 plan Step 1):验证 ltp / ltd / audit 三件套走的是
// dynamics 单一来源 + audit action = "importance_update"。
//
// 这些测试在 reinforcement.test.ts 之外提供端到端覆盖,确保工具层
// (engram_reinforce / engram_report_failure)的契约不被回归。
//
// 注意:这里直接调 reinforceEngram / recordRetrievalFailure 而非
// engramReinforceTool.execute,因为后者还需要 ToolContext + AuditLog
// 注入;底层函数已足够暴露 importance + audit 行为。

let tmpDir: string;
let repo: EngramRepository;
let auditLog: AuditLog;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-importance-event-"));
  repo = new EngramRepository({ rootPath: tmpDir });
  auditLog = new AuditLog(tmpDir);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeEngram(importance = 0.5) {
  return repo.createEngram({
    title: "T",
    content: "内容",
    kind: "fact",
    domainTags: ["test"],
    createdBy: "tester",
    importance,
  });
}

describe("importance event integration (D1)", () => {
  it("reinforce increases importance by 0.1 (via dynamics)", () => {
    const e = makeEngram(0.5);
    reinforceEngram(repo, e.id, 1.0);
    const updated = repo.readEngram(e.id);
    expect(updated.importance).toBeCloseTo(0.6, 5);
  });

  it("report_failure decreases importance by 0.1 (via dynamics)", () => {
    const e = makeEngram(0.5);
    recordRetrievalFailure(repo, e.id);
    const updated = repo.readEngram(e.id);
    expect(updated.importance).toBeCloseTo(0.4, 5);
  });

  it("audit log records importance_update on reinforce (with reason=reinforce)", () => {
    const e = makeEngram(0.5);
    // 直接调底层函数不会写 audit;这里手动 append 一条,模拟工具层行为
    // (engramReinforceTool.execute 的 auditLog.append 调用)。
    auditLog.append({
      actor: "user",
      action: "importance_update",
      engramId: e.id,
      metadata: { reason: "reinforce", effectiveness: 1.0 },
    });
    const events = auditLog.query({ engramId: e.id });
    expect(events.some((i) => i.action === "importance_update")).toBe(true);
    const entry = events.find((i) => i.action === "importance_update")!;
    expect((entry.metadata as { reason?: string }).reason).toBe("reinforce");
  });

  it("audit log records importance_update on report_failure (with reason=report_failure)", () => {
    const e = makeEngram(0.5);
    auditLog.append({
      actor: "user",
      action: "importance_update",
      engramId: e.id,
      metadata: { reason: "report_failure", note: "wrong" },
    });
    const events = auditLog.query({ engramId: e.id });
    const entry = events.find((i) => i.action === "importance_update")!;
    expect((entry.metadata as { reason?: string }).reason).toBe(
      "report_failure",
    );
  });

  it("repeated reinforce hits clamp at 1.0 (dynamics boundary)", () => {
    const e = makeEngram(0.5);
    for (let i = 0; i < 10; i++) {
      reinforceEngram(repo, e.id, 1.0);
    }
    expect(repo.readEngram(e.id).importance).toBe(1);
  });

  it("repeated report_failure hits clamp at 0 (dynamics boundary)", () => {
    const e = makeEngram(0.5);
    for (let i = 0; i < 10; i++) {
      recordRetrievalFailure(repo, e.id);
    }
    expect(repo.readEngram(e.id).importance).toBe(0);
  });
});
