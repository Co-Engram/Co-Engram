// P4 隔离区 API(Phase1):degraded run 的洞察提案默认不进 /api/proposals
// pending 队列;quarantined 通道随响应返回(前端置顶展示未闭合清单)。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuditLog, EngramRepository, ProposalEngine } from "@co-engram/core";
import { startViewerServer } from "../src/index.js";

let tmpDir: string;
let runtime: Awaited<ReturnType<typeof startViewerServer>> | undefined;
const stubEmbedder = async () => [1, 0, 0];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-viewer-quarantine-"));
});
afterEach(async () => {
  if (runtime) {
    await runtime.stop();
    runtime = undefined;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

let portCounter = 55600;
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });
}
async function nextPort(): Promise<number> {
  for (let i = 0; i < 200; i += 1) {
    portCounter += 1;
    if (await isPortFree(portCounter)) return portCounter;
  }
  throw new Error("no free port");
}

describe("proposals 隔离区 API(P4)", () => {
  it("pending 默认排除 degraded 提案;quarantined 通道返回隔离摘要;status=all 仍可见", async () => {
    const repository = new EngramRepository({ rootPath: tmpDir });
    const auditLog = new AuditLog(tmpDir);
    const proposalEngine = new ProposalEngine({
      repository, embedder: stubEmbedder, auditLog, dataRoot: tmpDir,
    });
    // 一条正常 pending 提案 + 一条 degraded 固化隔离的 pending 提案
    const src = repository.createEngram({
      title: "隔离验证来源", content: "c", kind: "fact", domainTags: ["域甲"], createdBy: "t",
    });
    proposalEngine.proposeInsight({
      mode: "inspiration", insightType: "theme",
      title: "正常洞察提案", content: "c", summary: "s",
      domainTags: ["沉思"], sourceIds: [src.id],
      criticScore: 0.9, criticRationale: "ok",
      incubationId: "inc-a", round: 1,
    });
    proposalEngine.proposeInsight({
      mode: "inspiration", insightType: "theme",
      title: "降级run的隔离洞察", content: "c2", summary: "s2",
      domainTags: ["沉思"], sourceIds: [src.id],
      criticScore: 0.9, criticRationale: "ok",
      incubationId: "inc-b", round: 1,
      degraded: { provisional: false, unclosedGaps: ["未闭合的外部检索需求"] },
    });

    const port = await nextPort();
    runtime = await startViewerServer(
      { repository, auditLog, proposalEngine } as never,
      { port },
    );
    const base = `http://127.0.0.1:${port}`;
    const get = async (p: string) => {
      const r = await fetch(base + p);
      return (await r.json()) as {
        results?: Array<{ entityId: string }>;
        quarantined?: Array<{ entityId: string; title: string; provisional: boolean; unclosedGaps: string[] }>;
      };
    };

    const pending = await get("/api/proposals?status=pending");
    expect(pending.results?.map((p) => p.entityId)).toHaveLength(1);
    expect(pending.results?.[0]?.entityId).not.toContain("inspiration");

    const q = pending.quarantined ?? [];
    expect(q).toHaveLength(1);
    expect(q[0]!.provisional).toBe(false);
    expect(q[0]!.unclosedGaps).toContain("未闭合的外部检索需求");

    const all = await get("/api/proposals?status=all");
    expect(all.results?.length).toBe(2); // 全部视图可见(裁决入口)
  });
});
