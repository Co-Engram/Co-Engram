// packages/core/test/storage/repository-scan-migration.test.ts
//
// Bug 修复验证:重命名团队记忆目录 / 移动 engram 文件后,
// 已 accept 入库的 engram 不应重新变成 external-markdown proposal。
//
// 根因:scanForDeletedEngrams / scanForExternalMarkdown 原本按「文件路径」判定
// 已追踪,而路径是易变的;engram 的稳定身份是 frontmatter 的 stable id(ULID)。
// 修复:scanForDeletedEngrams 按 stable id 识别「路径迁移」(更新 entry.path),
// scanForExternalMarkdown 加 knownIds 防御层,已入库 id 不触发 hook。
//
// 本文件直接调用 private 的 scanFor* 方法,精确模拟 scheduleDataScan 的
// setTimeout 回调里同步执行的三步扫描(deleted → modified → external),
// 不依赖 fs.watch 跨平台事件触发,确定且快速。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngramRepository } from "../../src/storage/repository.js";
import { ProposalEngine } from "../../src/observability/proposal-engine.js";
import { readEngramIndex } from "../../src/storage/engram-index.js";

interface ScanInternals {
  scanForDeletedEngrams: () => void;
  scanForModifiedEngrams: () => void;
  scanForExternalMarkdown: () => void;
}

let tmpDir: string;
let repo: EngramRepository;
let engine: ProposalEngine;
let unregister: () => void;

const stubEmbedder = async () => [1, 0, 0];
const stubAudit = { append: () => {} } as never;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-scan-migrate-"));
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

/** 等同 scheduleDataScan 回调里同步执行的三步扫描 */
function runScan(): void {
  const r = repo as unknown as ScanInternals;
  r.scanForDeletedEngrams();
  r.scanForModifiedEngrams();
  r.scanForExternalMarkdown();
}

function entryPath(id: string): string | undefined {
  const index = readEngramIndex(tmpDir);
  return index.entries.get(id as never)?.path;
}

function extProposals(): unknown[] {
  return engine
    .listAll()
    .filter((p) => (p as { source: string }).source === "external-markdown");
}

describe("scan: 重命名目录 / 移动文件 = 路径迁移,不重新提案", () => {
  it("已入库 engram 所在目录被重命名 → index.path 更新,stable id 不变,无新 proposal", () => {
    const engram = repo.createEngram({
      title: "迁移测试",
      content: "正文内容",
      kind: "fact",
      domainTags: ["方法论"],
      createdBy: "tester",
      pathHint: "方法论/记忆A.md",
    });

    expect(entryPath(engram.id)).toBe("方法论/记忆A.md");

    // 真实用户操作:mv 方法论 方法论2(整目录重命名,里面的文件一起搬)
    renameSync(join(tmpDir, "方法论"), join(tmpDir, "方法论2"));

    runScan();

    // 断言 1:index entry.path 迁移到新路径,id 不变
    expect(entryPath(engram.id)).toBe("方法论2/记忆A.md");

    // 断言 2:engram 仍可按原 stable id 读取(检索/链接不断)
    const reread = repo.readEngram(engram.id);
    expect(reread.title).toBe("迁移测试");
    expect(reread.id).toBe(engram.id);

    // 断言 3(核心):没有重新生成 external-markdown proposal
    expect(extProposals()).toHaveLength(0);
  });

  it("路径迁移保留 synapse(不误调 deleteEngram 清理链接)", () => {
    const a = repo.createEngram({
      title: "A",
      content: "a",
      kind: "fact",
      domainTags: ["方法论"],
      createdBy: "tester",
      pathHint: "方法论/A.md",
    });
    const b = repo.createEngram({
      title: "B",
      content: "b",
      kind: "fact",
      domainTags: ["方法论"],
      createdBy: "tester",
      pathHint: "方法论/B.md",
    });
    const ts = "2026-01-01T00:00:00.000Z";
    repo.addOutgoingSynapse(a.id, {
      id: "syn-migrate-1",
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

    // 移动 A 的文件(目录重命名)
    renameSync(join(tmpDir, "方法论"), join(tmpDir, "方法论2"));
    runScan();

    // synapse 仍在(若误调 deleteEngram,A→B 链接会被 deleteSynapsesTouching 清掉)。
    // 注意:synapse.id 由 (from,to,kind,direction) 确定性计算,不取调用方传入的 id,
    // 故按 from/to/kind 判定。synapse 存在独立 SYNAPSES_DIR,不随 engram 路径走。
    const allSyns = repo.collectAllSynapses();
    expect(
      allSyns.some(
        (s) =>
          s.fromId === a.id &&
          s.synapse.to === b.id &&
          s.synapse.kind === "similar_to",
      ),
    ).toBe(true);

    // A 的路径已迁移,但 id 不变 → B 指向 A 的链接仍有效
    expect(entryPath(a.id)).toBe("方法论2/A.md");
  });

  it("单文件移动(不重命名目录)同样识别为迁移", () => {
    const engram = repo.createEngram({
      title: "单文件移动",
      content: "c",
      kind: "fact",
      domainTags: ["方法论"],
      createdBy: "tester",
      pathHint: "方法论/原位.md",
    });

    // mv 方法论/原位.md 归档/新位.md
    renameSync(
      join(tmpDir, "方法论", "原位.md"),
      join(tmpDir, "方法论", "新位.md"),
    );
    runScan();

    expect(entryPath(engram.id)).toBe("方法论/新位.md");
    expect(extProposals()).toHaveLength(0);
  });
});

describe("scan: scanForExternalMarkdown 已入库 id 防御", () => {
  it("已入库 engram 的 .md 不触发 hook(路径已追踪)", () => {
    repo.createEngram({
      title: "已有",
      content: "c",
      kind: "fact",
      domainTags: ["方法论"],
      createdBy: "tester",
      pathHint: "方法论/已有.md",
    });
    runScan();
    expect(extProposals()).toHaveLength(0);
  });

  it("真删文件 → index entry 被清理(迁移逻辑不掩盖真删除)", () => {
    const engram = repo.createEngram({
      title: "待删",
      content: "x",
      kind: "fact",
      domainTags: ["方法论"],
      createdBy: "tester",
      pathHint: "方法论/待删.md",
    });
    rmSync(join(tmpDir, "方法论", "待删.md"));

    runScan();

    const index = readEngramIndex(tmpDir);
    expect(index.entries.has(engram.id as never)).toBe(false);
  });

  it("新增裸 md(无 frontmatter)→ 仍触发 hook 走提案", async () => {
    writeFileSync(
      join(tmpDir, "新裸文档.md"),
      "这是一段没有 frontmatter 的裸 markdown 内容",
    );

    runScan();
    // 裸 md 走 proposeBareMarkdownAsync(fire-and-forget microtask),flush 一下
    await new Promise((resolve) => setTimeout(resolve, 10));

    const proposals = extProposals();
    expect(proposals).toHaveLength(1);
  });
});

describe("e2e: 真实 fs.watch + debounce 全链路", () => {
  it("重命名目录 → watcher 自动触发 scan → 迁移而非重新提案", async () => {
    const e2eDir = mkdtempSync(join(tmpdir(), "co-engram-e2e-migrate-"));
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

    try {
      const engram = e2eRepo.createEngram({
        title: "E2E迁移",
        content: "c",
        kind: "fact",
        domainTags: ["方法论"],
        createdBy: "tester",
        pathHint: "方法论/A.md",
      });

      // 真实用户操作:mv 方法论 方法论2
      renameSync(join(e2eDir, "方法论"), join(e2eDir, "方法论2"));

      // 等 watcher 事件 + scheduleDataScan 的 2s debounce + 余量
      await new Promise((resolve) => setTimeout(resolve, 3500));

      // 迁移:index.path 指向新目录,stable id 不变
      const index = readEngramIndex(e2eDir);
      expect(index.entries.get(engram.id as never)?.path).toBe(
        "方法论2/A.md",
      );
      // 核心不变量:没有重新生成 proposal
      const proposals = e2eEngine
        .listAll()
        .filter((p) => (p as { source: string }).source === "external-markdown");
      expect(proposals).toHaveLength(0);
    } finally {
      unreg();
      rmSync(e2eDir, { recursive: true, force: true });
    }
  }, 15000);
});
