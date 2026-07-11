// packages/core/test/storage/index-no-truth-sync.test.ts
//
// index-no-truth 架构缺陷修复测试套件(2026-07)
//
// 验证三层防护协同工作:
//   A. scanForModifiedEngrams(watcher .md 修改同步)
//   B. addSynapseChangeListener + IndexOrchestrator.rebuildSynapseLayer(.yaml 重建)
//   C. runDoctor 结尾 SQLite engrams 表全量重投
//   D. infra-doctor 总是重建 graph.json(覆盖字段级 drift)
//
// 复现用户报告的 bug:Edit 工具改 .md frontmatter `创建者` 字段后,
// viewer 贡献者排名仍显示旧作者(根因:SQLite engrams.created_by 长期陈旧)。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngramRepository } from "../../src/storage/repository.js";
import { IndexDb } from "../../src/storage/index-db.js";
import { IndexOrchestrator, defaultCachePath } from "../../src/index/orchestrator.js";
import { runInfraDoctor } from "../../src/storage/infra-doctor.js";

let tmpDir: string;
let dbPath: string;
let repo: EngramRepository;
let indexDb: IndexDb;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-index-no-truth-"));
  mkdirSync(join(tmpDir, ".co-engram"), { recursive: true });
  dbPath = join(tmpDir, ".co-engram", "index.db");
  indexDb = new IndexDb({ dbPath });
  indexDb.open();
  repo = new EngramRepository({ rootPath: tmpDir }, indexDb);
});

afterEach(() => {
  repo.stopWatching();
  indexDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** 直接从 SQLite engrams 主表读一行的所有列 */
function readEngramRow(id: string): Record<string, unknown> | undefined {
  return indexDb
    .prepare("SELECT * FROM engrams WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
}

/** 读 graph.json 的 edges */
function readGraphEdges(): { createdBy?: string }[] {
  const graphPath = join(tmpDir, ".co-engram", "graph.json");
  if (!existsSync(graphPath)) return [];
  const raw = readFileSync(graphPath, "utf8");
  const parsed = JSON.parse(raw) as { edges?: { createdBy?: string }[] };
  return parsed.edges ?? [];
}

// ============================================================
// A. scanForModifiedEngrams - watcher .md 修改同步
// ============================================================
describe("index-no-truth A: scanForModifiedEngrams", () => {
  it("外部编辑 .md frontmatter 后,SQLite engrams 字段实时同步", async () => {
    // 1. createEngram 写入种子数据(createdBy: "旧作者")
    const engram = repo.createEngram({
      title: "测试记忆",
      content: "初始内容",
      kind: "observation",
      domainTags: ["test"],
      createdBy: "旧作者",
    });

    // 确认 SQLite 已写入旧值
    expect(readEngramRow(engram.id)!.created_by).toBe("旧作者");

    // 2. 启动 watcher,等待 stable
    repo.startWatching();
    await new Promise((r) => setTimeout(r, 100));

    // 3. 外部编辑 .md:改 createdBy 字段(模拟 Edit / IDE 写入)
    const indexPath = repo.resolvePath(engram.id);
    if (!indexPath) throw new Error("resolvePath failed");
    const absPath = join(tmpDir, indexPath);
    const oldRaw = readFileSync(absPath, "utf8");
    // 把 frontmatter 中的 createdBy 从 "旧作者" 改成 "新作者"
    // (注意:必须改 frontmatter,不动 content body)
    const newRaw = oldRaw
      .replace(/createdBy:.*$/m, 'createdBy: "新作者"')
      .replace(/创建者:.*$/m, '创建者: "新作者"');
    // 确认替换确实发生(防止 test 假绿)
    if (newRaw === oldRaw) {
      throw new Error("test setup failed: replace did not match frontmatter");
    }
    // 确保 mtime 真的变(fs watch 可能合并亚毫秒级写入)
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(absPath, newRaw);

    // 4. 等 watcher debounce(2s + 余量)
    await new Promise((r) => setTimeout(r, 2700));

    // 5. 关键断言:SQLite engrams.created_by 必须已经同步到新值
    expect(readEngramRow(engram.id)!.created_by).toBe("新作者");
  });

  it("mtime 未变的 .md → scanForModifiedEngrams 跳过(避免无谓同步)", async () => {
    // 创建 1 个 engram,SQLite 已写
    const engram = repo.createEngram({
      title: "不变",
      content: "x",
      kind: "observation",
      domainTags: [],
      createdBy: "tester",
    });
    const rowBefore = readEngramRow(engram.id);
    expect(rowBefore!.created_by).toBe("tester");

    // 启动 watcher 但**不**修改文件(watcher 可能因 OS 噪音触发)
    repo.startWatching();
    await new Promise((r) => setTimeout(r, 2700));

    // SQLite 行字段不应被重写(虽然 upsert 幂等,但减少无谓 I/O)
    // 主要验证 scanForModifiedEngrams 的 mtime 短路逻辑
    const rowAfter = readEngramRow(engram.id);
    expect(rowAfter!.created_by).toBe("tester");
    expect(rowAfter!.updated_at).toBe(rowBefore!.updated_at);
  });
});

// ============================================================
// B. synapseChangeListener - .yaml 外部编辑触发派生层重建
// ============================================================
describe("index-no-truth B: addSynapseChangeListener", () => {
  it(".yaml 外部编辑后,debounce 触发 listener 回调", async () => {
    let listenerCalls = 0;
    let lastGraphEdges = 0;
    repo.addSynapseChangeListener(() => {
      listenerCalls++;
      // 在 listener 里重建 graph + SQLite synapse(模拟 host adapter 行为)
      const cachePath = defaultCachePath(tmpDir);
      const orchestrator = new IndexOrchestrator(repo, cachePath);
      orchestrator.rebuildSynapseLayer();
      lastGraphEdges = readGraphEdges().length;
    });

    // 1. 先建 2 个 engram + 1 个 synapse
    const a = repo.createEngram({
      title: "A",
      content: "x",
      kind: "observation",
      domainTags: [],
      createdBy: "tester",
    }).id;
    const b = repo.createEngram({
      title: "B",
      content: "x",
      kind: "observation",
      domainTags: [],
      createdBy: "tester",
    }).id;
    const syn = repo.createSynapse({
      from: a,
      to: b,
      kind: "extends",
      createdBy: "旧作者",
    });

    // 2. 启动 watcher 等 stable
    repo.startWatching();
    await new Promise((r) => setTimeout(r, 100));

    // 先重建一次 graph 让它有初始状态
    const cachePath = defaultCachePath(tmpDir);
    new IndexOrchestrator(repo, cachePath).rebuildSynapseLayer();
    expect(readGraphEdges()).toHaveLength(1);
    expect(readGraphEdges()[0]!.createdBy).toBe("旧作者");

    // 3. 外部编辑 .yaml:改 createdBy
    const synPath = join(tmpDir, "synapses", "extends", `${syn.id}.yaml`);
    if (!existsSync(synPath)) throw new Error("synapse yaml not found");
    const oldYaml = readFileSync(synPath, "utf8");
    const newYaml = oldYaml
      .replace(/createdBy:.*$/m, 'createdBy: "新作者"')
      .replace(/创建者:.*$/m, '创建者: "新作者"');
    if (newYaml === oldYaml) {
      throw new Error("test setup failed: yaml replace did not match");
    }
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(synPath, newYaml);

    // 4. 等 debounce
    await new Promise((r) => setTimeout(r, 2700));

    // 5. 关键断言:listener 被调用 + graph.json 反映新作者
    expect(listenerCalls).toBeGreaterThanOrEqual(1);
    expect(lastGraphEdges).toBe(1);
    expect(readGraphEdges()[0]!.createdBy).toBe("新作者");
  });
});

// ============================================================
// C. runDoctor 结尾 SQLite engrams 表全量重投
// ============================================================
describe("index-no-truth C: runDoctor SQLite 全量重投", () => {
  it("SQLite engrams.created_by 与 frontmatter 不一致 → runDoctor 后对齐", () => {
    // 1. createEngram 写入种子(createdBy: "真作者")
    const engram = repo.createEngram({
      title: "测试",
      content: "x",
      kind: "observation",
      domainTags: [],
      createdBy: "真作者",
    });
    expect(readEngramRow(engram.id)!.created_by).toBe("真作者");

    // 2. 直接 SQL 篡改 SQLite 模拟「字段陈旧」(覆盖 watcher 漏事件场景)
    indexDb
      .prepare("UPDATE engrams SET created_by = ? WHERE id = ?")
      .run("陈旧作者", engram.id);
    expect(readEngramRow(engram.id)!.created_by).toBe("陈旧作者");

    // 3. 跑 doctor
    const report = repo.runDoctor();

    // 4. 关键断言:SQLite engrams.created_by 必须从真理层(.md frontmatter)重投
    expect(readEngramRow(engram.id)!.created_by).toBe("真作者");

    // 5. doctor report 应记录 sqlite_resynced fix
    expect(
      report.fixes.some((f) => f.kind === "sqlite_resynced"),
    ).toBe(true);
  });

  it("无 indexDb 注入时,runDoctor 跳过 SQLite 重投(向后兼容)", () => {
    // 创建独立 repo 不带 indexDb
    const noDbDir = mkdtempSync(join(tmpdir(), "no-indexdb-"));
    try {
      const noDbRepo = new EngramRepository({ rootPath: noDbDir });
      noDbRepo.createEngram({
        title: "x",
        content: "y",
        kind: "observation",
        domainTags: [],
        createdBy: "tester",
      });
      // 不抛错即通过(向后兼容路径)
      const report = noDbRepo.runDoctor();
      // 无 sqlite_resynced fix(因为无 indexDb)
      expect(
        report.fixes.some((f) => f.kind === "sqlite_resynced"),
      ).toBe(false);
    } finally {
      rmSync(noDbDir, { recursive: true, force: true });
    }
  });
});

// ============================================================
// D. infra-doctor 总是重建 graph.json(字段级 drift 防护)
// ============================================================
describe("index-no-truth D: infra-doctor graph 总是重建", () => {
  it("graph.json 存在且 edges 数 = synapse 数 → 仍触发重建(覆盖字段级 drift)", () => {
    // 1. 建 1 个 synapse,初始 graph.json 通过 fullRebuild 生成
    const a = repo.createEngram({
      title: "A",
      content: "x",
      kind: "observation",
      domainTags: [],
      createdBy: "tester",
    }).id;
    const b = repo.createEngram({
      title: "B",
      content: "x",
      kind: "observation",
      domainTags: [],
      createdBy: "tester",
    }).id;
    repo.createSynapse({
      from: a,
      to: b,
      kind: "extends",
      createdBy: "旧作者",
    });

    const cachePath = defaultCachePath(tmpDir);
    const initResult = new IndexOrchestrator(repo, cachePath).fullRebuild();
    expect(initResult.graph.edges).toBe(1);

    // 2. 篡改 graph.json:edges 数仍为 1,但 createdBy 是错的
    const graphPath = join(cachePath, "graph.json");
    const tampered = JSON.parse(readFileSync(graphPath, "utf8")) as {
      edges: [{ createdBy: string }];
    };
    tampered.edges[0]!.createdBy = "篡改的作者";
    writeFileSync(graphPath, JSON.stringify(tampered, null, 2));
    expect(readGraphEdges()[0]!.createdBy).toBe("篡改的作者");

    // 3. 跑 infra-doctor
    const result = runInfraDoctor({ repo, dataRoot: tmpDir });

    // 4. 关键断言:即使 edges 数一致(都是 1),infra-doctor 仍重建
    expect(result.fixes.length).toBeGreaterThanOrEqual(1);
    expect(result.fixes.some((f) => f.kind === "index_rebuilt")).toBe(true);

    // 5. graph.json createdBy 必须恢复真相(从 .yaml frontmatter)
    expect(readGraphEdges()[0]!.createdBy).toBe("旧作者");
  });
});
