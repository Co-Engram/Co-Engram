// packages/core/test/storage/scan-external-markdown-git-tracked.test.ts
//
// 验证:engram_sync / git pull 从远端拉下的合法 engram(团队成员已 accept),
// 因本地 engram-index.json 不同步(gitignore)+ post-merge hook 未装而 index 陈旧时,
// scanForExternalMarkdown 不应把它们误判为"未授权 external markdown"产生 proposal,
// 而应依据 git tracked 状态直接采纳入库(ingestExistingEngramFiles 批量纳管)。
// 外部未 track 文件(cp / 投毒)仍走 proposal —— 防线保留。
//
// 本文件直接调用 private 的 scanFor* 方法,精确模拟 scheduleDataScan 的 setTimeout
// 回调里同步执行的三步扫描(deleted → modified → external),不依赖 fs.watch 跨平台
// 事件触发,确定且快速(与 repository-scan-migration.test.ts 同模式)。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

import { EngramRepository } from "../../src/storage/repository.js";
import { ProposalEngine } from "../../src/observability/proposal-engine.js";
import { writeEngramIndex, createEmptyEngramIndex } from "../../src/storage/engram-index.js";

interface ScanInternals {
  scanForDeletedEngrams: () => void;
  scanForModifiedEngrams: () => void;
  scanForExternalMarkdown: () => void;
}

const stubEmbedder = async () => [1, 0, 0];
const stubAudit = { append: () => {} } as never;

/**
 * git init + 提交全部文件。
 *
 * - core.quotepath=false:防 git 对非 ASCII 路径转义(与 co-engram 的 commitFiles 一致),
 *   保证 git ls-files 输出与 relPath(正斜杠原文)对齐。
 * - --allow-empty:空目录也能 commit(用于"先建 git repo 再写文件"的反向场景)。
 */
function gitInitCommitAll(dir: string): void {
  execSync("git init -q", { cwd: dir });
  execSync('git config user.email "t@t.com"', { cwd: dir });
  execSync('git config user.name "tester"', { cwd: dir });
  execSync("git config core.quotepath false", { cwd: dir });
  execSync("git add -A", { cwd: dir });
  execSync('git commit -q --allow-empty -m init', { cwd: dir });
}

/** 等同 scheduleDataScan 回调里同步执行的三步扫描(deleted → modified → external)。 */
function runScan(repo: EngramRepository): void {
  const r = repo as unknown as ScanInternals;
  r.scanForDeletedEngrams();
  r.scanForModifiedEngrams();
  r.scanForExternalMarkdown();
}

/** 当前 external-markdown proposal 列表(source === "external-markdown")。 */
function extProposals(engine: ProposalEngine): unknown[] {
  return engine
    .listAll()
    .filter((p) => (p as { source: string }).source === "external-markdown");
}

/**
 * 用空 index 覆盖 engram-index.json,模拟"本地 index 陈旧"。
 *
 * 关键:index.json 必须存在且不含目标文件。若直接删除 index.json,scanForExternalMarkdown
 * 的 readEngramIndex 虽判未追踪,但 ingestExistingEngramFiles 的 getIndex() 会因文件不存在
 * 触发 rebuildEngramIndex 扫盘 → 发现文件 → 幂等跳过,测不到纳管路径。写入空 index.json
 * 让 getIndex 读到空(mtime 匹配 cache,不 rebuild)→ has(id) false → 走 ingest。
 */
function staleEmptyIndex(rootPath: string): void {
  writeEngramIndex(rootPath, createEmptyEngramIndex());
}

describe("scanForExternalMarkdown: git tracked 合法 engram 直接纳管,不走 proposal", () => {
  let tmpDir: string;
  let repo: EngramRepository;
  let engine: ProposalEngine;
  let unregister: () => void;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "co-engram-git-tracked-"));
    repo = new EngramRepository({ rootPath: tmpDir });
    engine = new ProposalEngine({
      repository: repo,
      embedder: stubEmbedder,
      auditLog: stubAudit,
      dataRoot: tmpDir,
    });
    unregister = repo.setExternalMarkdownHook(
      engine.createExternalMarkdownHook(),
    );
  });

  afterEach(() => {
    unregister();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("git tracked 合法 engram + index 陈旧 → 直接纳管,不产生 proposal", () => {
    // 远端已有、本地刚 pull 的合法 engram(createEngram 用于生成合法文件格式)
    const eng = repo.createEngram({
      title: "远端记忆",
      content: "团队已确认内容",
      kind: "fact",
      domainTags: ["remote"],
      createdBy: "teammate",
      pathHint: "remote/mem.md",
    });
    // git pull 后文件 tracked(团队仓库内容)
    gitInitCommitAll(tmpDir);
    // 模拟 post-merge hook 未装:本地 engram-index.json 陈旧
    staleEmptyIndex(tmpDir);

    runScan(repo);

    // 核心:不产生 proposal
    expect(extProposals(engine)).toHaveLength(0);
    // 直接纳管:可按 stable id 读取
    expect(repo.exists(eng.id)).toBe(true);
    expect(repo.readEngram(eng.id).title).toBe("远端记忆");
  });

  it("未被 git track 的合法 engram(git repo 但文件未 add)→ 走 proposal(防投毒)", () => {
    // 先建 git repo(空提交),再写文件 → 文件 untracked
    gitInitCommitAll(tmpDir);
    const eng = repo.createEngram({
      title: "外部投毒",
      content: "未授权内容",
      kind: "fact",
      domainTags: ["external"],
      createdBy: "attacker",
      pathHint: "ext/poison.md",
    });
    staleEmptyIndex(tmpDir);

    runScan(repo);

    // 未 track → 走 proposal(防线保留)
    expect(extProposals(engine)).toHaveLength(1);
    expect(repo.exists(eng.id)).toBe(false);
  });

  it("非 git repo → 合法 engram 走 proposal(降级为现状)", () => {
    repo.createEngram({
      title: "无 git 环境",
      content: "dataRoot 非 git repo",
      kind: "fact",
      domainTags: ["nogit"],
      createdBy: "tester",
      pathHint: "nogit/mem.md",
    });
    // 不 git init —— listTrackedMarkdownFiles 返回空 Set → 全走 proposal
    staleEmptyIndex(tmpDir);

    runScan(repo);

    expect(extProposals(engine)).toHaveLength(1);
  });

  it("批量:100 个 git tracked engram → 全部直接纳管(一次 persist,非逐个写盘)", () => {
    const ids: string[] = [];
    for (let i = 0; i < 100; i++) {
      const eng = repo.createEngram({
        title: `bulk-${i}`,
        content: `content-${i}`,
        kind: "fact",
        domainTags: ["bulk"],
        createdBy: "teammate",
        pathHint: `bulk/mem-${i}.md`,
      });
      ids.push(eng.id);
    }
    gitInitCommitAll(tmpDir);
    staleEmptyIndex(tmpDir);

    const start = Date.now();
    runScan(repo);
    const elapsed = Date.now() - start;

    // 全部纳管,无 proposal
    expect(extProposals(engine)).toHaveLength(0);
    expect(repo.listEngrams().length).toBe(100);
    // 批量优化(ingestExistingEngramFiles 一次 persist + 逐条 SQLite/emit)应远快于
    // 逐个 ingest(后者 100 次全量写 index.json)。5s 上限留足余量。
    expect(elapsed).toBeLessThan(5000);
  });

  it("synapse:两端 engram 被 ingest 后,synapse 文件可被扫到(不 dangling)", () => {
    // synapse 本就不走 proposal(无 external-synapse source);这里验证两端 engram 被
    // ingest 入 index 后,synapse 文件能被 collectAllSynapses 拾取(endpoints 都在 index
    // → graph 重建时不被 dangling 过滤),覆盖"突触"诉求。
    const a = repo.createEngram({
      title: "A",
      content: "a",
      kind: "fact",
      domainTags: ["syn"],
      createdBy: "tester",
      pathHint: "syn/A.md",
    });
    const b = repo.createEngram({
      title: "B",
      content: "b",
      kind: "fact",
      domainTags: ["syn"],
      createdBy: "tester",
      pathHint: "syn/B.md",
    });
    const ts = "2026-01-01T00:00:00.000Z";
    repo.addOutgoingSynapse(a.id, {
      id: "syn-git-tracked",
      from: a.id,
      to: b.id,
      kind: "similar_to",
      weight: 0.5,
      direction: "directional",
      evidence: [],
      createdBy: "tester",
      createdAt: ts,
      updatedAt: ts,
      retrievalWeight: 0.5,
      visibility: "public",
    });
    gitInitCommitAll(tmpDir);
    staleEmptyIndex(tmpDir);

    runScan(repo);

    // 两端 engram 都被直接纳管入 index
    expect(repo.exists(a.id)).toBe(true);
    expect(repo.exists(b.id)).toBe(true);
    // synapse 文件被扫到(endpoints 都在 index → graph 不 dangling)
    const allSyns = (
      repo as unknown as {
        collectAllSynapses: () => ReadonlyArray<{
          fromId: string;
          synapse: { to: string };
        }>;
      }
    ).collectAllSynapses();
    // synapse 文件被 collectAllSynapses 扫到,from/to 匹配两端 engram
    //(id 由 computeSynapseId 推导,不等于传入的 id 字段)
    expect(allSyns.length).toBeGreaterThan(0);
    expect(
      allSyns.some((s) => s.fromId === a.id && s.synapse.to === b.id),
    ).toBe(true);
  });
});

describe("e2e: 真实 fs.watch + git pull 全链路", () => {
  it("git pull 带来的合法 engram → watcher 触发 scan → 直接纳管,无 proposal", async () => {
    // 独立 e2eDir(真实 git repo + watcher),不共享 beforeEach 的 repo
    const e2eDir = mkdtempSync(join(tmpdir(), "co-engram-e2e-git-pull-"));
    execSync("git init -q", { cwd: e2eDir });
    execSync('git config user.email "t@t.com"', { cwd: e2eDir });
    execSync('git config user.name "tester"', { cwd: e2eDir });
    execSync("git config core.quotepath false", { cwd: e2eDir });
    execSync('git commit -q --allow-empty -m init', { cwd: e2eDir });

    const e2eRepo = new EngramRepository({ rootPath: e2eDir });
    const e2eEngine = new ProposalEngine({
      repository: e2eRepo,
      embedder: stubEmbedder,
      auditLog: stubAudit,
      dataRoot: e2eDir,
    });
    const unreg = e2eRepo.setExternalMarkdownHook(
      e2eEngine.createExternalMarkdownHook(),
    );
    e2eRepo.startWatching();
    // 触发 getIndex persist 一个空 index.json —— 模拟"上次运行留下的、不含新文件的旧 index"
    // (真实场景:post-merge hook 未装,本地 index.json 不同步)。若不 persist,scan 时 getIndex
    // 会 rebuild 扫盘发现文件 → 幂等跳过,测不到纳管路径。
    e2eRepo.listEngrams();

    try {
      // 用辅助 repo 生成合法 engram 文件 raw(模拟远端内容,e2eRepo 的 index 不知情)
      const helperDir = mkdtempSync(join(tmpdir(), "co-engram-helper-"));
      const helperRepo = new EngramRepository({ rootPath: helperDir });
      const eng = helperRepo.createEngram({
        title: "git pull 来的远端记忆",
        content: "团队成员已确认",
        kind: "fact",
        domainTags: ["remote"],
        createdBy: "teammate",
        pathHint: "remote/pulled.md",
      });
      const pulledRaw = readFileSync(
        join(helperDir, "remote/pulled.md"),
        "utf8",
      );
      rmSync(helperDir, { recursive: true, force: true });

      // 模拟 git pull:文件落地 + git tracked(pull 来的文件天然在 commit 里)
      mkdirSync(join(e2eDir, "remote"), { recursive: true });
      writeFileSync(join(e2eDir, "remote/pulled.md"), pulledRaw, "utf8");
      execSync("git add -A", { cwd: e2eDir });
      execSync('git commit -q -m pull', { cwd: e2eDir });

      // 等 watcher 事件 + scheduleDataScan 的 2s debounce + 余量
      await new Promise((resolve) => setTimeout(resolve, 3500));

      // 核心端到端断言:不产生 external-markdown proposal
      const proposals = e2eEngine
        .listAll()
        .filter((p) => (p as { source: string }).source === "external-markdown");
      expect(proposals).toHaveLength(0);
      // 合法 engram 被直接纳管,可按 stable id 读
      expect(e2eRepo.exists(eng.id)).toBe(true);
    } finally {
      unreg();
      rmSync(e2eDir, { recursive: true, force: true });
    }
  }, 15000);
});
