import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";

import { EngramRepository } from "../src/storage/repository.js";
import { IndexDb } from "../src/storage/index-db.js";
import { AuditLog } from "../src/observability/audit-log.js";
import {
  ProposalEngine,
  DEFAULT_HASHER_EMBEDDER,
} from "../src/observability/proposal-engine.js";

/**
 * 写入时反思(2026-08 反思落地)端到端:accept 新 engram → 反思(经
 * CO_ENGRAM_LLM_CONFIG 指向本地 mock LLM server,与 merge driver 同源的磁盘
 * 兜底通道)→ 同域候选 → LLM 判关系 → rem-synapse 提案(不直写)。
 * 降级链:无 config → reflection_skipped(llm-missing);in-flight 并发闸。
 */
describe("写入时反思(accept → reflect → propose)", () => {
  let tmpDir: string;
  let repo: EngramRepository;
  let indexDb: IndexDb;
  let audit: AuditLog;
  let engine: ProposalEngine;
  let llmServer: Server | null = null;
  let llmPort = 0;
  let llmRequests = 0;
  let llmResponse: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ce-reflect-accept-"));
    mkdirSync(join(tmpDir, ".co-engram"), { recursive: true });
    indexDb = new IndexDb({ dbPath: join(tmpDir, ".co-engram", "index.db") });
    indexDb.open();
    repo = new EngramRepository({ rootPath: tmpDir, language: "zh" }, indexDb);
    audit = new AuditLog(tmpDir);
    engine = new ProposalEngine({
      repository: repo,
      embedder: DEFAULT_HASHER_EMBEDDER,
      auditLog: audit,
      dataRoot: tmpDir,
      skillRepository: undefined,
    });
    llmRequests = 0;
    llmResponse = JSON.stringify({
      judgments: [
        {
          index: 0,
          kind: "causes",
          confidence: 0.85,
          reason: "既有问题导致新修复方案",
        },
      ],
    });
    // 反射前清环境变量(每个用例自行决定是否指向 mock server)
    delete process.env.CO_ENGRAM_LLM_CONFIG;
  });

  afterEach(async () => {
    await closeServer();
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.CO_ENGRAM_LLM_CONFIG;
  });

  function startLlmServer(): Promise<void> {
    return new Promise((resolve) => {
      llmServer = createServer((req, res) => {
        llmRequests += 1;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: llmResponse } }],
          }),
        );
      });
      llmServer.listen(0, "127.0.0.1", () => {
        const addr = llmServer!.address();
        llmPort = typeof addr === "object" && addr ? addr.port : 0;
        resolve();
      });
    });
  }

  function closeServer(): Promise<void> {
    return new Promise((resolve) => {
      if (!llmServer) return resolve();
      llmServer.close(() => resolve());
      llmServer = null;
    });
  }

  function pointEnvToMockServer(): void {
    writeFileSync(
      join(tmpDir, "llm-config.json"),
      JSON.stringify({
        endpoint: `http://127.0.0.1:${llmPort}/v1`,
        apiKey: "test-key",
        model: "test-model",
        writtenAt: new Date().toISOString(),
      }),
    );
    process.env.CO_ENGRAM_LLM_CONFIG = join(tmpDir, "llm-config.json");
  }

  /** 直接带 payload 的提案(auto-memory 风格)→ accept → 触发反思 */
  function acceptNewEngram(
    title: string,
    content: string,
    tags: string[],
  ): string {
    engine.proposeAutoMemory({
      slug: title,
      title,
      content,
      domainTags: tags,
      kind: "fact",
      createdBy: "test",
    });
    const entityId = `am:${title}`.replace(/^am:/, "am:");
    // autoMemoryEntityId 的确切形态不影响本测试 —— 用 findProposalByEntityId 兜底
    const row = engine.listAll().find((p) => p.payload?.title === title);
    return engine.accept(row?.entityId ?? entityId, { createdBy: "test" });
  }

  /** 等待 fire-and-forget 反思完成(轮询提案文件,上限 5s) */
  async function waitForReflection(timeoutMs = 5_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 50));
      const hasReflectionProposal = engine
        .listPending()
        .some((p) => p.source === "rem-synapse");
      if (hasReflectionProposal) return;
    }
  }

  it("accept 新记忆 → 反思生成 rem-synapse 提案(不直写突触)", async () => {
    await startLlmServer();
    pointEnvToMockServer();
    // 既有同域记忆(候选)
    acceptNewEngram("既有问题", "信号游标未初始化导致首批事件被吞", [
      "co-engram",
      "signals",
    ]);
    // 等 accept 自身的反思跑完(它也会判,但两条是新记忆互为候选)
    await new Promise((r) => setTimeout(r, 300));

    const newId = acceptNewEngram(
      "修复方案",
      "信号游标未初始化导致首批事件被吞,构造时初始化游标修复",
      ["co-engram", "signals"],
    );
    await waitForReflection();

    expect(llmRequests).toBeGreaterThan(0);
    const synapseProposals = engine
      .listPending()
      .filter((p) => p.source === "rem-synapse");
    expect(synapseProposals.length).toBeGreaterThanOrEqual(1);
    const reflectionProposal = synapseProposals.find((p) =>
      p.payload?.remSynapseReason?.includes("写入时反思"),
    );
    expect(reflectionProposal).toBeDefined();
    expect(reflectionProposal?.payload?.synapseKind).toBe("causes");
    // 不直写:仓库无新突触(全部在提案里待审批)
    const edges = repo.collectAllSynapses();
    expect(edges).toHaveLength(0);
    // 提案端点 = 新记忆 ↔ 既有记忆
    const endpoints = [
      reflectionProposal?.payload?.synapseFrom,
      reflectionProposal?.payload?.synapseTo,
    ].sort();
    expect(endpoints).toContain(newId);
  });

  it("无 LLM config → reflection_skipped(llm-missing)审计,无提案", async () => {
    process.env.CO_ENGRAM_LLM_CONFIG = join(tmpDir, "no-such-config.json");
    acceptNewEngram("孤例", "无 LLM 时的反思降级", ["solo"]);
    await new Promise((r) => setTimeout(r, 200));

    const skipped = audit
      .query({ action: "reflection_skipped" })
      .find((e) => e.metadata?.layer === "on-accept");
    expect(skipped?.metadata?.reason).toBe("llm-missing");
    expect(engine.listPending().some((p) => p.source === "rem-synapse")).toBe(
      false,
    );
  });

  it("并发闸:反思进行中,后续 accept 不排队(丢弃式限流)", async () => {
    await startLlmServer();
    pointEnvToMockServer();
    // 人为占用闸门,模拟一次进行中的反思
    (engine as unknown as { reflectionInFlight: boolean }).reflectionInFlight =
      true;
    acceptNewEngram("闸内", "并发闸开启时的入库", ["gate"]);
    await new Promise((r) => setTimeout(r, 200));
    expect(llmRequests).toBe(0); // 未触发任何 LLM 调用
    expect(engine.listPending().some((p) => p.source === "rem-synapse")).toBe(
      false,
    );
    (engine as unknown as { reflectionInFlight: boolean }).reflectionInFlight =
      false;
  });

  it("无同域候选 → 不跨域硬凑(零 LLM 调用)", async () => {
    await startLlmServer();
    pointEnvToMockServer();
    acceptNewEngram("独域", "唯一带此标签的记忆", ["unique-domain-x"]);
    await new Promise((r) => setTimeout(r, 200));
    expect(llmRequests).toBe(0);
    expect(engine.listPending().some((p) => p.source === "rem-synapse")).toBe(
      false,
    );
  });
});
