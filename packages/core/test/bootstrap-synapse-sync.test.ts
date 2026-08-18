import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapRepositoryAndSearch } from "../src/storage/bootstrap.js";
import { IndexDb } from "../src/storage/index-db.js";

// 这组测试锁住 2026-08「首页记忆突触 0」修复的启动对账行为。
//
// 根因:bootstrap cold-start 只灌 engrams 表;synapses 表此前没有任何启动填充
// 路径(仅 .yaml watcher / doctor 触发)。存量库切到「stats 读 SQLite」口径后,
// synapses 表恒空 → 首页 totalSynapses=0。SCHEMA_VERSION 升级 DROP 全表后同理
// (注释宣称的 "cold-start rebuild 完整恢复" 对 synapses 表是假的)。
//
// 修复:每次 bootstrap 启动对账 —— SQLite 行数 vs 磁盘 synapses/ yaml 文件数,
// 不等则 rebuildSynapseTableFromDisk 回填(含 schema v8 新列 created_by,供
// viewer topContributors 突触聚合走同一数据源)。

describe("bootstrap synapse 表启动对账(2026-08 首页突触 0 修复)", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "co-engram-syn-sync-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  /**
   * 场景 1(核心):存量库 —— engrams 表有数据(write-through 维护)、
   * synapses 表空(createSynapse 只写 yaml 不写 SQLite)。再次 bootstrap
   * 必须对账回填,且 created_by 来自 yaml 的 createdBy。
   */
  it("engrams 满 + synapses 空(存量库)→ 启动对账回填,createdBy 落列", () => {
    // 第一次 bootstrap:建库,cold-start 灌 engrams(此时 0 条,空灌)
    const first = bootstrapRepositoryAndSearch({ dataRoot: tmpRoot });
    const a = first.repository.createEngram({
      title: "印迹 A",
      content: "内容 A",
      kind: "observation",
      domainTags: ["测试域"],
      createdBy: "杨洋 10192021",
    });
    const b = first.repository.createEngram({
      title: "印迹 B",
      content: "内容 B",
      kind: "pattern",
      domainTags: ["测试域"],
      createdBy: "范雨 10344752",
    });
    // synapse 写 yaml(MCP 路径),不写 SQLite —— 模拟真实滞后
    first.repository.createSynapse({
      from: a.id,
      to: b.id,
      kind: "similar_to",
      createdBy: "杨洋 10192021",
    });
    first.repository.createSynapse({
      from: b.id,
      to: a.id,
      kind: "derives_from",
      createdBy: "范雨 10344752",
    });
    first.indexDb?.close();

    // 存量状态断言:engrams 有数据(不再触发 cold-start)、synapses 表为空
    const probe = new IndexDb({
      dbPath: join(tmpRoot, ".co-engram", "index.db"),
    });
    probe.open();
    expect(probe.countSynapses()).toBe(0);
    probe.close();

    // 第二次 bootstrap:对账触发回填
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const second = bootstrapRepositoryAndSearch({ dataRoot: tmpRoot });
    expect(second.indexDb?.countSynapses()).toBe(2);

    // created_by 落列:viewer topContributors 的突触聚合数据源
    const rows = second
      .indexDb!.prepare(
        `SELECT created_by AS actor, count(*) AS n
         FROM synapses GROUP BY created_by ORDER BY actor`,
      )
      .all() as { actor: string; n: number }[];
    expect(rows).toEqual([
      { actor: "杨洋 10192021", n: 1 },
      { actor: "范雨 10344752", n: 1 },
    ]);

    // 触发时有启动日志(运维可见)
    expect(
      warnSpy.mock.calls.some((c) =>
        String(c[0]).includes("synapse table sync: rebuilt 2 rows"),
      ),
    ).toBe(true);
    second.indexDb?.close();
  });

  /**
   * 场景 5(2026-08 审计追加):对账回填同步重算 engrams 突触计数列。
   * 该列此前无任何回填路径(write-through 与 cold-start 都写 0,注释宣称的
   * 「maintenance 增量 UPDATE」不存在),engram_list 的 MCP 输出
   * (readDigestBatch)读到恒 0。对称 kind(similar_to)两端都计入出+入,
   * 与 repository.readSynapses 的实时权威口径一致。
   */
  it("对账回填后 outgoing/incoming_synapse_count 与 readSynapses 口径一致", () => {
    const first = bootstrapRepositoryAndSearch({ dataRoot: tmpRoot });
    const a = first.repository.createEngram({
      title: "印迹 A",
      content: "内容 A",
      kind: "observation",
      domainTags: ["测试域"],
      createdBy: "杨洋 10192021",
    });
    const b = first.repository.createEngram({
      title: "印迹 B",
      content: "内容 B",
      kind: "pattern",
      domainTags: ["测试域"],
      createdBy: "杨洋 10192021",
    });
    // similar_to(对称)+ derives_from(有向 a→b)
    first.repository.createSynapse({
      from: a.id,
      to: b.id,
      kind: "similar_to",
      createdBy: "杨洋 10192021",
    });
    first.repository.createSynapse({
      from: a.id,
      to: b.id,
      kind: "derives_from",
      createdBy: "杨洋 10192021",
    });
    first.indexDb?.close();

    vi.spyOn(console, "warn").mockImplementation(() => {});
    const second = bootstrapRepositoryAndSearch({ dataRoot: tmpRoot });
    const q = (id: string) =>
      second
        .indexDb!.prepare(
          `SELECT outgoing_synapse_count AS o, incoming_synapse_count AS i
         FROM engrams WHERE id = ?`,
        )
        .get(id) as { o: number; i: number };
    // a:similar_to(对称,出+入)+ derives_from(a 为源,计出)
    expect(q(a.id)).toEqual({ o: 2, i: 1 });
    // b:similar_to(对称,出+入)+ derives_from(b 为靶,计入)
    expect(q(b.id)).toEqual({ o: 1, i: 2 });
    // 与 readSynapses 实时口径一致(权威对照)
    const liveA = second.repository.readSynapses(a.id);
    expect(liveA.outgoing.length).toBe(q(a.id).o);
    expect(liveA.incoming.length).toBe(q(a.id).i);
    second.indexDb?.close();
  });

  /**
   * 场景 2:已一致的库再次启动 → 对账跳过(无重建日志),零写放大。
   */
  it("表已一致 → 不触发回填(无 synapse table sync 日志)", () => {
    const first = bootstrapRepositoryAndSearch({ dataRoot: tmpRoot });
    const a = first.repository.createEngram({
      title: "印迹 A",
      content: "内容 A",
      kind: "observation",
      domainTags: ["测试域"],
      createdBy: "杨洋 10192021",
    });
    const b = first.repository.createEngram({
      title: "印迹 B",
      content: "内容 B",
      kind: "pattern",
      domainTags: ["测试域"],
      createdBy: "杨洋 10192021",
    });
    first.repository.createSynapse({
      from: a.id,
      to: b.id,
      kind: "similar_to",
      createdBy: "杨洋 10192021",
    });
    first.indexDb?.close();

    bootstrapRepositoryAndSearch({ dataRoot: tmpRoot }); // 第一次对账回填
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const third = bootstrapRepositoryAndSearch({ dataRoot: tmpRoot }); // 已一致
    expect(
      warnSpy.mock.calls.some((c) =>
        String(c[0]).includes("synapse table sync"),
      ),
    ).toBe(false);
    expect(third.indexDb?.countSynapses()).toBe(1); // 数据仍在
    third.indexDb?.close();
  });

  /**
   * 场景 3:schema v7 旧库(磁盘版本 < SCHEMA_VERSION)→ open 时 DROP 全表
   * → cold-start 灌 engrams + 对账回填 synapses,全部从磁盘恢复。
   */
  it("schema v7 旧库升级 → DROP 后 cold-start + 对账全量恢复", () => {
    const first = bootstrapRepositoryAndSearch({ dataRoot: tmpRoot });
    const a = first.repository.createEngram({
      title: "印迹 A",
      content: "内容 A",
      kind: "observation",
      domainTags: ["测试域"],
      createdBy: "杨洋 10192021",
    });
    const b = first.repository.createEngram({
      title: "印迹 B",
      content: "内容 B",
      kind: "pattern",
      domainTags: ["测试域"],
      createdBy: "杨洋 10192021",
    });
    first.repository.createSynapse({
      from: a.id,
      to: b.id,
      kind: "similar_to",
      createdBy: "杨洋 10192021",
    });
    first.indexDb?.close();

    // 手工把磁盘 schema 版本打回 v7(升级前旧库),并清 schema_version 单行
    const legacy = new IndexDb({
      dbPath: join(tmpRoot, ".co-engram", "index.db"),
    });
    legacy.open();
    legacy.exec("DELETE FROM schema_version");
    legacy.prepare("INSERT INTO schema_version (version) VALUES (7)").run();
    legacy.close();

    // 升级后首次启动:DROP → cold-start(engrams)+ 对账(synapses)
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const upgraded = bootstrapRepositoryAndSearch({ dataRoot: tmpRoot });
    expect(upgraded.indexDb?.countSynapses()).toBe(1);
    const total = (
      upgraded.indexDb!.prepare(`SELECT count(*) AS n FROM engrams`).get() as {
        n: number;
      }
    ).n;
    expect(total).toBe(2);
    upgraded.indexDb?.close();
  });

  /**
   * 场景 4:dangling synapse(端点 engram 已删)→ 对账幂等重建、不抛错,
   * rebuildSynapseTable 过滤 dangling(行数 < 磁盘文件数是稳定状态,
   * 每次启动重建一次可接受,由 doctor 清理 dangling)。
   */
  it("dangling synapse 存在 → 不抛错,行数 = 非 dangling 数", () => {
    const first = bootstrapRepositoryAndSearch({ dataRoot: tmpRoot });
    const a = first.repository.createEngram({
      title: "印迹 A",
      content: "内容 A",
      kind: "observation",
      domainTags: ["测试域"],
      createdBy: "杨洋 10192021",
    });
    const b = first.repository.createEngram({
      title: "印迹 B",
      content: "内容 B",
      kind: "pattern",
      domainTags: ["测试域"],
      createdBy: "杨洋 10192021",
    });
    first.repository.createSynapse({
      from: a.id,
      to: b.id,
      kind: "similar_to",
      createdBy: "杨洋 10192021",
    });
    // dangling:b 删除后 synapse 文件残留(deleteEngram 不清 yaml 的场景由
    // doctor 兜底;这里直接构造 —— 删 engram 行让 yaml 端点失配)
    first.repository.deleteEngram(b.id);
    first.indexDb?.close();

    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() =>
      bootstrapRepositoryAndSearch({ dataRoot: tmpRoot }),
    ).not.toThrow();
    const second = bootstrapRepositoryAndSearch({ dataRoot: tmpRoot });
    // dangling 被过滤:磁盘 1 个 yaml,可插入 0 条
    expect(second.indexDb?.countSynapses()).toBe(0);
    second.indexDb?.close();
  });

  /**
   * 场景 6(2026-08-19 部署实测追加):synapses 表行数与磁盘一致(对账走
   * 「跳过」分支),但 engrams 突触计数列残留历史全零(无回填路径时代写入
   * 的错误)→ 启动时 else 分支的 recomputeSynapseCounts 必须修复它。
   * 真实库踩中:表 234 行一致,计数列 100/100 全零,若只在 rebuildSynapseTable
   * 内重算,该错误在表一致的库上永远残留。
   */
  it("表一致但计数列历史全零 → 启动对账 else 分支重算修复", () => {
    const first = bootstrapRepositoryAndSearch({ dataRoot: tmpRoot });
    const a = first.repository.createEngram({
      title: "印迹 A",
      content: "内容 A",
      kind: "observation",
      domainTags: ["测试域"],
      createdBy: "杨洋 10192021",
    });
    const b = first.repository.createEngram({
      title: "印迹 B",
      content: "内容 B",
      kind: "pattern",
      domainTags: ["测试域"],
      createdBy: "杨洋 10192021",
    });
    first.repository.createSynapse({
      from: a.id,
      to: b.id,
      kind: "similar_to",
      createdBy: "杨洋 10192021",
    });
    first.indexDb?.close();

    // 第二次 bootstrap:rebuild 分支回填,计数正确
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const second = bootstrapRepositoryAndSearch({ dataRoot: tmpRoot });
    // 模拟历史错误:手工把计数列清零(等效于旧版本写入的全零状态)
    second.indexDb!.exec(
      `UPDATE engrams SET outgoing_synapse_count = 0, incoming_synapse_count = 0`,
    );
    second.indexDb?.close();

    // 第三次 bootstrap:synapses 表与磁盘一致 → else 分支必须重算计数列
    const third = bootstrapRepositoryAndSearch({ dataRoot: tmpRoot });
    const q = (id: string) =>
      third
        .indexDb!.prepare(
          `SELECT outgoing_synapse_count AS o, incoming_synapse_count AS i
           FROM engrams WHERE id = ?`,
        )
        .get(id) as { o: number; i: number };
    expect(q(a.id)).toEqual({ o: 1, i: 1 }); // similar_to 对称:两端出+入各 1
    expect(q(b.id)).toEqual({ o: 1, i: 1 });
    third.indexDb?.close();
  });

  /**
   * 场景 7(2026-08-19 第三层缺口):engram 更新走 write-through
   * (syncEngramToIndex)时不得清零计数列 —— 修复前它是全字段 upsert,
   * 恒写 0,/api/stats 每次调用的 rescanModifiedEngrams 都会把 recompute
   * 的正确值覆盖回 0(部署实测:recompute 后 65/100 非零,一次 stats 调用
   * 后回到 0/100)。现在计数三列未提供时 UPDATE 保留原值。
   */
  it("engram 更新(rescanModifiedEngrams 触发 write-through)不清零计数列", () => {
    const first = bootstrapRepositoryAndSearch({ dataRoot: tmpRoot });
    const a = first.repository.createEngram({
      title: "印迹 A",
      content: "内容 A",
      kind: "observation",
      domainTags: ["测试域"],
      createdBy: "杨洋 10192021",
    });
    const b = first.repository.createEngram({
      title: "印迹 B",
      content: "内容 B",
      kind: "pattern",
      domainTags: ["测试域"],
      createdBy: "杨洋 10192021",
    });
    first.repository.createSynapse({
      from: a.id,
      to: b.id,
      kind: "similar_to",
      createdBy: "杨洋 10192021",
    });
    first.indexDb?.close();

    vi.spyOn(console, "warn").mockImplementation(() => {});
    const second = bootstrapRepositoryAndSearch({ dataRoot: tmpRoot });
    const q = (id: string) =>
      second
        .indexDb!.prepare(
          `SELECT outgoing_synapse_count AS o, incoming_synapse_count AS i
           FROM engrams WHERE id = ?`,
        )
        .get(id) as { o: number; i: number };
    expect(q(a.id)).toEqual({ o: 1, i: 1 });

    // 模拟外部编辑:touch a 的文件 mtime → rescanModifiedEngrams 走
    // syncEngramToIndex 全字段 upsert(修复前的清零路径)
    const entry = second.repository
      .listEngramIndex()
      .find((e) => e.id === a.id)!;
    const absPath = join(tmpRoot, entry.path);
    const later = new Date(Date.now() + 2000);
    utimesSync(absPath, later, later);
    second.repository.rescanModifiedEngrams();

    // 计数列必须保留(修复前:被 excluded 的 0 覆盖)
    expect(q(a.id)).toEqual({ o: 1, i: 1 });
    second.indexDb?.close();
  });
});
