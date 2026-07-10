/**
 * 工具触发的 audit 内容测试
 *
 * 覆盖:
 *   - engram_update 写入 changes(before/after diff,长字段截断)
 *   - synapse_create 写入 target=synapse + from/to/kind/weight 等
 *   - synapse_delete 写入 target=synapse + 删前字段
 *   - 字段相同(传入但未实际变化)不出现在 changes
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngramRepository } from "../src/storage/repository.js";
import { SearchOrchestrator } from "../src/retrieval/orchestrator.js";
import { AuditLog } from "../src/observability/audit-log.js";
import {
  engramCreateTool,
  engramUpdateTool,
} from "../src/tools/engram-tools.js";
import {
  synapseCreateTool,
  synapseDeleteTool,
} from "../src/tools/synapse-tools.js";
import type { ToolContext } from "../src/tools/tool.js";

let tmpDir: string;
let repo: EngramRepository;
let search: SearchOrchestrator;
let audit: AuditLog;
let ctx: ToolContext;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-tools-audit-"));
  repo = new EngramRepository({ rootPath: tmpDir });
  search = new SearchOrchestrator();
  audit = new AuditLog(tmpDir);
  ctx = {
    repository: repo,
    searchOrchestrator: search,
    auditLog: audit,
    // 2026-07 修复后 createdBy 完全由系统决定(LLM 传值被忽略),
    // 这里给 ctx 注入 defaultCreatedBy="alice",让测试里 LLM 传入的
    // "alice" 与系统解析值一致,避免逐条改测试期望
    defaultCreatedBy: "alice",
  };
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("engram_update audit content", () => {
  it("单字段修改 → changes 含 title 的 from/to", () => {
    const { id } = engramCreateTool.execute(
      {
        title: "原标题",
        content: "内容",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "alice",
      },
      ctx,
    );
    engramUpdateTool.execute({ id, title: "新标题", updatedBy: "bob" }, ctx);

    const entries = audit.query({ action: "update", engramId: id });
    expect(entries.length).toBe(1);
    const changes = entries[0]!.metadata?.changes as Record<
      string,
      { from: unknown; to: unknown }
    >;
    expect(changes.title).toEqual({ from: "原标题", to: "新标题" });
    expect(changes.content).toBeUndefined();
  });

  it("多字段修改 → changes 含所有变化字段", () => {
    const { id } = engramCreateTool.execute(
      {
        title: "A",
        content: "原内容",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "alice",
      },
      ctx,
    );
    engramUpdateTool.execute(
      { id, title: "B", importance: 0.9, summary: "新摘要", updatedBy: "bob" },
      ctx,
    );

    const entries = audit.query({ action: "update", engramId: id });
    const changes = entries[0]!.metadata?.changes as Record<string, unknown>;
    expect(Object.keys(changes).sort()).toEqual([
      "importance",
      "summary",
      "title",
    ]);
    expect(changes.importance).toEqual({ from: 0.5, to: 0.9 });
    // summary 在 create 时从 content 派生,所以 from 是派生值而非空串
    const summaryChange = changes.summary as { from: string; to: string };
    expect(summaryChange.to).toBe("新摘要");
    expect(summaryChange.from.length).toBeGreaterThan(0);
  });

  it("传入字段但值相同 → changes 不含该字段", () => {
    const { id } = engramCreateTool.execute(
      {
        title: "保持不变",
        content: "内容",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "alice",
      },
      ctx,
    );
    engramUpdateTool.execute({ id, title: "保持不变", updatedBy: "bob" }, ctx);

    const entries = audit.query({ action: "update", engramId: id });
    const changes = entries[0]!.metadata?.changes as Record<string, unknown>;
    expect(Object.keys(changes)).toEqual([]);
  });

  it("超长 content 被截断,from/to 含 omitted 标记", () => {
    const longContent = "X".repeat(500);
    const { id } = engramCreateTool.execute(
      {
        title: "A",
        content: longContent,
        kind: "fact",
        domainTags: ["t"],
        createdBy: "alice",
      },
      ctx,
    );
    const newLongContent = "Y".repeat(500);
    engramUpdateTool.execute(
      { id, content: newLongContent, updatedBy: "bob" },
      ctx,
    );

    const entries = audit.query({ action: "update", engramId: id });
    const changes = entries[0]!.metadata?.changes as Record<
      string,
      { from: string; to: string }
    >;
    const fromVal = changes.content!.from;
    const toVal = changes.content!.to;
    expect(fromVal).toContain("…");
    expect(fromVal).toContain("chars omitted");
    expect(fromVal.length).toBeLessThan(longContent.length);
    expect(toVal).toContain("…");
    expect(toVal.length).toBeLessThan(newLongContent.length);
  });

  it("changes 之外的 metadata 字段(updatedBy)保留", () => {
    const { id } = engramCreateTool.execute(
      {
        title: "A",
        content: "x",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "alice",
      },
      ctx,
    );
    engramUpdateTool.execute({ id, title: "B", updatedBy: "bob" }, ctx);
    const entries = audit.query({ action: "update", engramId: id });
    expect(entries[0]!.metadata?.updatedBy).toBe("bob");
  });
});

describe("synapse_create audit content", () => {
  function setupTwoEngrams(): { fromId: string; toId: string } {
    const from = engramCreateTool.execute(
      {
        title: "From",
        content: "from-content",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "alice",
      },
      ctx,
    );
    const to = engramCreateTool.execute(
      {
        title: "To",
        content: "to-content",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "alice",
      },
      ctx,
    );
    return { fromId: from.id, toId: to.id };
  }

  it("非 contradicts → 写一条 create audit,target=synapse", () => {
    const { fromId, toId } = setupTwoEngrams();
    const { id: synapseId } = synapseCreateTool.execute(
      {
        from: fromId,
        to: toId,
        kind: "extends",
        weight: 0.7,
        direction: "directional",
        createdBy: "alice",
      },
      ctx,
    );

    const creates = audit.query({ action: "create" });
    // 2 个 engram create + 1 个 synapse create = 3
    const synCreate = creates.find((e) => e.metadata?.target === "synapse");
    expect(synCreate).toBeDefined();
    expect(synCreate!.engramId).toBe(fromId);
    expect(synCreate!.metadata).toMatchObject({
      target: "synapse",
      synapseId,
      from: fromId,
      to: toId,
      kind: "extends",
      weight: 0.7,
      direction: "directional",
    });
    // createdBy 由 ctx.defaultCreatedBy 决定(2026-07 完全覆盖修复);
    // 本测试关注 audit 记录的 synapse 结构字段,createdBy 行为
    // 由 default-created-by.test.ts 覆盖,这里不断言具体值
  });

  it("contradicts → 额外写两条 contradicted audit(双方各一)", () => {
    const { fromId, toId } = setupTwoEngrams();
    synapseCreateTool.execute(
      {
        from: fromId,
        to: toId,
        kind: "contradicts",
        weight: 0.8,
        direction: "directional",
        createdBy: "alice",
      },
      ctx,
    );
    const contradicted = audit.query({ action: "contradicted" });
    expect(contradicted.length).toBe(2);
    expect(contradicted.some((e) => e.engramId === fromId)).toBe(true);
    expect(contradicted.some((e) => e.engramId === toId)).toBe(true);
  });
});

describe("synapse_delete audit content", () => {
  it("删除 → 写一条 purge audit,记录删前 from/to/kind/weight", () => {
    const from = engramCreateTool.execute(
      {
        title: "F",
        content: "f",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "alice",
      },
      ctx,
    );
    const to = engramCreateTool.execute(
      {
        title: "T",
        content: "t",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "alice",
      },
      ctx,
    );
    const { id: synapseId } = synapseCreateTool.execute(
      {
        from: from.id,
        to: to.id,
        kind: "depends_on",
        weight: 0.6,
        direction: "directional",
        createdBy: "alice",
      },
      ctx,
    );

    // 清空 audit 以便只看 delete 后的状态
    audit.clear();
    synapseDeleteTool.execute({ from: from.id, synapseId }, ctx);

    const purges = audit.query({ action: "purge" });
    expect(purges.length).toBe(1);
    expect(purges[0]!.engramId).toBe(from.id);
    expect(purges[0]!.metadata).toMatchObject({
      target: "synapse",
      synapseId,
      from: from.id,
      to: to.id,
      kind: "depends_on",
      weight: 0.6,
      direction: "directional",
    });
  });
});
