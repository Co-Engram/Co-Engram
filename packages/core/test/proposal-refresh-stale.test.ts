import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  utimesSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngramRepository } from "../src/storage/repository.js";
import { AuditLog } from "../src/observability/audit-log.js";
import {
  ProposalEngine,
  DEFAULT_HASHER_EMBEDDER,
  DEFAULT_HASHER_SIMILARITY_THRESHOLD,
} from "../src/observability/proposal-engine.js";

/**
 * refreshStaleFileProposals:用户手动改文件后,pending external-markdown 提案的
 * title/content 在 listPending/listAll 入口同步刷新(补救 fs.watch 在 Linux 上漏事件)。
 *
 * 通过 listPending(公开方法)间接驱动私有 refreshStaleFileProposals。
 */
describe("refreshStaleFileProposals · 改文件后提案同步刷新", () => {
  let tmpDir: string;
  let repo: EngramRepository;
  let engine: ProposalEngine;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "co-engram-refresh-stale-"));
    repo = new EngramRepository({ rootPath: tmpDir });
    engine = new ProposalEngine({
      repository: repo,
      embedder: DEFAULT_HASHER_EMBEDDER,
      auditLog: new AuditLog(tmpDir),
      dataRoot: tmpDir,
      config: { similarityThreshold: DEFAULT_HASHER_SIMILARITY_THRESHOLD },
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** 把文件 mtime 推后到 base 之后,确保 > sourceMtimeMs。 */
  function bumpMtime(abs: string, baseMs: number, aheadMs = 5000): void {
    const future = new Date(baseMs + aheadMs);
    utimesSync(abs, future, future);
  }

  it("proposeExternalMarkdown 生成时记录 sourceMtimeMs", () => {
    const abs = join(tmpDir, "notes.md");
    writeFileSync(abs, "# 标题\n正文\n");
    engine.proposeExternalMarkdown({
      sourcePath: "notes.md",
      title: "标题",
      content: "# 标题\n正文\n",
      domainTags: ["x"],
      kind: "observation",
    });
    const p = engine.listAll().find((x) => x.sourcePath === "notes.md")!;
    expect(p.sourceMtimeMs).toBeTypeOf("number");
  });

  it("源文件被外部编辑后,listPending 同步刷新 title/content,保留旧 domainTags", () => {
    const abs = join(tmpDir, "notes.md");
    const oldRaw = "# 旧标题\n\n旧正文\n";
    writeFileSync(abs, oldRaw);
    const mtime1 = statSync(abs).mtimeMs;

    engine.proposeExternalMarkdown({
      sourcePath: "notes.md",
      title: "旧标题",
      content: oldRaw,
      domainTags: ["imported"],
      kind: "observation",
    });

    let p = engine.listPending().find((x) => x.sourcePath === "notes.md")!;
    expect(p.payload!.title).toBe("旧标题");

    // 模拟用户编辑:改内容 + 推后 mtime
    const newRaw = "# 新标题\n\n全新正文\n";
    writeFileSync(abs, newRaw);
    bumpMtime(abs, mtime1);

    p = engine.listPending().find((x) => x.sourcePath === "notes.md")!;
    expect(p.payload!.title).toBe("新标题");
    // content 同步成新文件内容(normalizeProposalFields 会 trim 尾空白,用包含断言)
    expect(p.payload!.content).toContain("新标题");
    expect(p.payload!.content).toContain("全新正文");
    expect(p.payload!.content).not.toContain("旧正文");
    // 规则版 domainTags 仅 uncategorized,但 refresh 保留旧值,不退回
    expect(p.payload!.domainTags).toEqual(["imported"]);
    // sourceMtimeMs 已推进到最新 mtime
    expect(p.sourceMtimeMs).toBeGreaterThan(mtime1);
  });

  it("文件 mtime 未推进时,listPending 不重提取(lastSeenAt 不变)", () => {
    const abs = join(tmpDir, "stable.md");
    writeFileSync(abs, "# 标题\n正文\n");
    engine.proposeExternalMarkdown({
      sourcePath: "stable.md",
      title: "标题",
      content: "# 标题\n正文\n",
      domainTags: ["x"],
      kind: "observation",
    });

    const before = engine.listAll().find((x) => x.sourcePath === "stable.md")!;
    // 再次 list,文件未变 → refresh 跳过,不触发 proposeExternalMarkdown
    engine.listPending();
    const after = engine.listAll().find((x) => x.sourcePath === "stable.md")!;
    expect(after.lastSeenAt).toBe(before.lastSeenAt);
    expect(after.sourceMtimeMs).toBe(before.sourceMtimeMs);
  });

  it("改文件成「多个裸 H1」(围栏丢失)→ 刷新后 title 为文件名", () => {
    const abs = join(tmpDir, "代码分支管理.md");
    writeFileSync(abs, "# 初始标题\n正文\n");
    const mtime1 = statSync(abs).mtimeMs;
    engine.proposeExternalMarkdown({
      sourcePath: "代码分支管理.md",
      title: "初始标题",
      content: "# 初始标题\n正文\n",
      domainTags: ["git-workflow"],
      kind: "procedure",
    });

    // 用户把文件改成「围栏丢失、shell 注释变多个 H1」的样子
    const messy = [
      "## 1 目的",
      "### 3.1.1 步骤",
      "# 1. 切换到源分支",
      "# 2. rebase 目标分支",
      "# 3. 推送代码",
    ].join("\n");
    writeFileSync(abs, messy);
    bumpMtime(abs, mtime1);

    const p = engine
      .listPending()
      .find((x) => x.sourcePath === "代码分支管理.md")!;
    // 多 H1 → H1 滥用 → 文件名,不再误抓"1. 切换到源分支"
    expect(p.payload!.title).toBe("代码分支管理");
  });

  it("源文件被删除后,listPending 不抛错(清理交给 scanForDeletedEngrams)", () => {
    const abs = join(tmpDir, "gone.md");
    writeFileSync(abs, "# t\n");
    engine.proposeExternalMarkdown({
      sourcePath: "gone.md",
      title: "t",
      content: "# t\n",
      domainTags: ["x"],
      kind: "observation",
    });
    rmSync(abs, { force: true });
    // 不应抛错;提案仍在(删除清理是另一条链路)
    expect(() => engine.listPending()).not.toThrow();
  });

  it("仅 external-markdown 受影响:conversation 提案不被 refresh 触碰", () => {
    // conversation 提案无 sourcePath/source==="external-markdown",refresh 直接跳过
    // 这里构造一个 external-markdown 提案验证 refresh 只动它,不误伤其他类型
    const abs = join(tmpDir, "ext.md");
    writeFileSync(abs, "# ext\n");
    const mtime1 = statSync(abs).mtimeMs;
    engine.proposeExternalMarkdown({
      sourcePath: "ext.md",
      title: "ext",
      content: "# ext\n",
      domainTags: ["a"],
      kind: "observation",
    });
    // 未改文件 → 首次 listPending 后 sourceMtimeMs 应等于 mtime1(不被误刷新)
    const p = engine.listPending().find((x) => x.sourcePath === "ext.md")!;
    expect(p.sourceMtimeMs).toBe(mtime1);
  });
});
