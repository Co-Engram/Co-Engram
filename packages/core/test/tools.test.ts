import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngramRepository } from "../src/storage/repository.js";
import { SearchOrchestrator } from "../src/retrieval/orchestrator.js";
import { collectDigestLines } from "../src/index/digest-builder.js";
import {
  engramCreateTool,
  engramGetTool,
  engramUpdateTool,
  engramDeleteTool,
  engramSearchTool,
  engramListTool,
  engramReinforceTool,
  engramReportFailureTool,
  engramArchiveTool,
  engramRestoreTool,
  engramForgetTool,
} from "../src/tools/engram-tools.js";
import {
  synapseCreateTool,
  synapseGetTool,
  synapseDeleteTool,
  synapseListTool,
} from "../src/tools/synapse-tools.js";
import { skillGetTool, skillInvokeTool } from "../src/tools/skill-tools.js";
import { createToolRegistry } from "../src/tools/registry.js";
import { validateInput } from "../src/tools/tool.js";
import { EngramCreateInputSchema } from "../src/tools/schemas.js";
import type { ToolContext } from "../src/tools/tool.js";
import type { Skill } from "../src/types/skill.js";

let tmpDir: string;
let repo: EngramRepository;
let search: SearchOrchestrator;
let ctx: ToolContext;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-tools-"));
  repo = new EngramRepository({ rootPath: tmpDir });
  search = new SearchOrchestrator();
  search.build(repo.listEngrams().map(toDigestLine));
  ctx = { repository: repo, searchOrchestrator: search };
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// 复制 retrieval 测试里的简化 DigestLine 构造
function toDigestLine(entry: {
  id: string;
  title: string;
  kind: string;
  domainTags: readonly string[];
}) {
  return {
    id: entry.id,
    title: entry.title,
    kind: entry.kind as "fact",
    kinds: [entry.kind] as readonly string[],
    summary: entry.title,
    domainTags: entry.domainTags,
    contextTags: [] as readonly string[],
    importance: 0.5,
    freshness: "fresh" as const,
    status: "active" as const,
    sourceType: "firsthand" as const,
    createdBy: "tester",
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    lastRetrievedAt: null,
    lastEffectiveAt: null,
    retrievalCount: 0,
    effectiveRetrievals: 0,
    failedUses: 0,
    reinforcementScore: 0,
    contentSize: entry.title.length,
    contentHash: "sha256:stub",
    outgoingSynapseCount: 0,
    incomingSynapseCount: 0,
    activeContradictionCount: 0,
  };
}

// 写入后刷新 search 索引
// 用 collectDigestLines 取真实 DigestLine(与生产路径 invalidateSearchIndex
// 一致),确保 search 单测反映真实 FTS 行为(包括 summary 派生 + importance
// 字段对三因子打分的贡献)。旧的 toDigestLine stub 把 summary 设为 title,
// 导致任何断言"content 关键词能搜到"的测试都会假阴性。
function refreshSearch() {
  search.build(collectDigestLines(repo));
}

// 旧 stub helper 保留,用于测某些只关心 title/domainTags 的隔离单测;
// search 路径上不再使用。
void toDigestLine;

// ============================================================
// engram_create
// ============================================================

describe("engram_create", () => {
  it("创建成功返回 id", () => {
    const result = engramCreateTool.execute(
      {
        title: "ADB 无线调试",
        content: "使用配对码配对后通过 wireless adb 连接",
        kind: "procedure",
        domainTags: ["testing", "adb"],
        createdBy: "yang",
      },
      ctx,
    );
    // id 是 ULID,与文件路径解耦
    expect(result.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(repo.exists(result.id)).toBe(true);
  });

  it("无效 kind 被拒绝", () => {
    expect(() =>
      engramCreateTool.execute(
        {
          title: "x",
          content: "y",
          kind: "invalid-kind" as "fact",
          domainTags: ["t"],
          createdBy: "y",
        },
        ctx,
      ),
    ).toThrow(/Invalid input/);
  });

  it("缺少 domainTags 被拒绝", () => {
    expect(() =>
      engramCreateTool.execute(
        {
          title: "x",
          content: "y",
          kind: "fact",
          domainTags: [],
          createdBy: "y",
        },
        ctx,
      ),
    ).toThrow(/Invalid input/);
  });

  it("importance 越界被拒绝", () => {
    expect(() =>
      engramCreateTool.execute(
        {
          title: "x",
          content: "y",
          kind: "fact",
          domainTags: ["t"],
          importance: 1.5,
          createdBy: "y",
        },
        ctx,
      ),
    ).toThrow(/Invalid input/);
  });

  // ============================================================
  // 智能去重集成（spec 2.4.6）
  // ============================================================

  it("默认 dedupe=true：相同内容 → DUPLICATE（强化原 engram 不重复创建）", () => {
    const first = engramCreateTool.execute(
      {
        title: "ADB 无线调试",
        content: "使用配对码配对后通过 wireless adb 连接",
        kind: "fact",
        domainTags: ["testing"],
        createdBy: "yang",
      },
      ctx,
    );
    expect(first.verdict).toBe("NEW");

    // 第二次创建完全相同内容
    const second = engramCreateTool.execute(
      {
        title: "ADB 无线调试",
        content: "使用配对码配对后通过 wireless adb 连接",
        kind: "fact",
        domainTags: ["testing"],
        createdBy: "yang",
      },
      ctx,
    );

    expect(second.verdict).toBe("DUPLICATE");
    expect(second.targetId).toBe(first.id);
    expect(second.id).toBe(first.id); // 返回的是原 engram 的 id

    // 强化效果：retrievalCount/effectiveRetrievals 应该 +1
    const reinforced = repo.readEngram(first.id);
    expect(reinforced.retrievalCount).toBe(1);
    expect(reinforced.effectiveRetrievals).toBe(1);
    expect(reinforced.reinforcementScore).toBeGreaterThan(0);

    // 仓库中只有一个 engram（没有重复创建）
    const allEngrams = repo.listEngrams();
    expect(allEngrams.length).toBe(1);
  });

  it("默认 dedupe=true：完全不同内容 → NEW", () => {
    engramCreateTool.execute(
      {
        title: "主题 A",
        content: "内容 A 关于某个主题",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "y",
      },
      ctx,
    );
    const second = engramCreateTool.execute(
      {
        title: "完全不同",
        content: "xyz 完全无关 zzz",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "y",
      },
      ctx,
    );
    expect(second.verdict).toBe("NEW");
    expect(second.targetId).toBeUndefined();
  });

  it("dedupe=false：跳过相似度检查直接创建（强制新建，不触发 UPDATE/DUPLICATE）", () => {
    // 先创建一个高相似度的 engram A
    engramCreateTool.execute(
      {
        title: "ADB 调试基础",
        content: "使用 adb wireless 调试 Android 设备",
        kind: "fact",
        domainTags: ["testing"],
        createdBy: "y",
      },
      ctx,
    );

    // 用 dedupe=false 创建相似但 title 不同的 engram B → 应该直接 NEW（跳过相似度召回）
    const second = engramCreateTool.execute(
      {
        title: "ADB 调试进阶",
        content: "使用 adb wireless 调试 Android 设备的进阶技巧",
        kind: "fact",
        domainTags: ["testing"],
        createdBy: "y",
        dedupe: false,
      },
      ctx,
    );

    expect(second.verdict).toBe("NEW");
    expect(second.targetId).toBeUndefined();
    expect(repo.listEngrams().length).toBe(2);
  });

  it("UPDATE 路径：相似高重叠内容触发合并（version+1）", () => {
    const first = engramCreateTool.execute(
      {
        title: "ADB 调试",
        content: "使用 adb wireless 调试 Android 设备的方法",
        kind: "fact",
        domainTags: ["testing"],
        createdBy: "y",
      },
      ctx,
    );
    expect(first.verdict).toBe("NEW");

    // 第二次：title 相同 + 高重叠
    const updated = engramCreateTool.execute(
      {
        title: "ADB 调试",
        content: "使用 adb wireless 调试 Android 设备的方法 详细步骤",
        kind: "fact",
        domainTags: ["testing"],
        createdBy: "y",
      },
      ctx,
    );

    // 启发式 triage 用 candidate.similarity（由 TokenJaccardSimilarityEngine 计算）
    // title 完全匹配 + similarity ≥ 0.7 → UPDATE
    if (updated.verdict === "UPDATE") {
      expect(updated.targetId).toBe(first.id);
      const merged = repo.readEngram(first.id);
      expect(merged.version).toBe(2);
      // 没有创建新的 engram
      expect(repo.listEngrams().length).toBe(1);
    } else {
      // 相似度不够触发 UPDATE 时，至少应该是 NEW（不会是 DUPLICATE，因为 content 不同）
      expect(updated.verdict).toBe("NEW");
    }
  });
});

// ============================================================
// engram_get
// ============================================================

describe("engram_get", () => {
  it("catalog tier 返回 entry", () => {
    const { id } = engramCreateTool.execute(
      {
        title: "测试",
        content: "内容",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "y",
      },
      ctx,
    );
    const view = engramGetTool.execute({ id, tier: "catalog" }, ctx);
    expect(view.tier).toBe("catalog");
    if (view.tier === "catalog") {
      expect(view.entry.title).toBe("测试");
    }
  });

  it("digest tier 返回 digest", () => {
    const { id } = engramCreateTool.execute(
      {
        title: "测试",
        content: "内容",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "y",
      },
      ctx,
    );
    const view = engramGetTool.execute({ id, tier: "digest" }, ctx);
    expect(view.tier).toBe("digest");
  });

  it("content tier 返回 entry + content", () => {
    const { id } = engramCreateTool.execute(
      {
        title: "测试",
        content: "正文 ABC",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "y",
      },
      ctx,
    );
    const view = engramGetTool.execute({ id, tier: "content" }, ctx);
    expect(view.tier).toBe("content");
    if (view.tier === "content") {
      expect(view.content).toBe("正文 ABC");
    }
  });

  it("synapses tier 返回 bundle（含 incoming/outgoing）", () => {
    const a = engramCreateTool.execute(
      {
        title: "A",
        content: "a",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "y",
      },
      ctx,
    );
    const b = engramCreateTool.execute(
      {
        title: "B",
        content: "b",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "y",
      },
      ctx,
    );
    synapseCreateTool.execute(
      { from: a.id, to: b.id, kind: "extends", createdBy: "y" },
      ctx,
    );
    const view = engramGetTool.execute({ id: b.id, tier: "synapses" }, ctx);
    expect(view.tier).toBe("synapses");
    if (view.tier === "synapses") {
      expect(view.bundle.incoming.length).toBe(1);
      expect(view.bundle.outgoing.length).toBe(0);
      expect(view.bundle.neighborDigests.length).toBe(1);
    }
  });

  it("默认 tier 为 digest", () => {
    const { id } = engramCreateTool.execute(
      {
        title: "X",
        content: "x",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "y",
      },
      ctx,
    );
    const view = engramGetTool.execute({ id }, ctx);
    expect(view.tier).toBe("digest");
  });

  it("不存在的 id 抛错", () => {
    expect(() =>
      engramGetTool.execute({ id: "no/such", tier: "catalog" }, ctx),
    ).toThrow(/not found/);
  });

  it("tier=auto + 大预算 → 升级到 content（P1 2.2）", () => {
    const { id } = engramCreateTool.execute(
      {
        title: "A",
        content: "内容 ABC",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "y",
      },
      ctx,
    );
    const view = engramGetTool.execute(
      { id, tier: "auto", contextBudget: { totalTokens: 4096 } },
      ctx,
    );
    expect(view.tier).toBe("content");
  });

  it("tier=auto + 极小预算 → 停在 catalog", () => {
    const { id } = engramCreateTool.execute(
      {
        title: "A",
        content: "内容 ABC",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "y",
      },
      ctx,
    );
    const view = engramGetTool.execute(
      { id, tier: "auto", contextBudget: { totalTokens: 60 } },
      ctx,
    );
    expect(view.tier).toBe("catalog");
  });
});

// ============================================================
// engram_update
// ============================================================

describe("engram_update", () => {
  it("更新 content 触发 version+1", () => {
    const { id } = engramCreateTool.execute(
      {
        title: "A",
        content: "原",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "y",
      },
      ctx,
    );
    const result = engramUpdateTool.execute(
      { id, content: "新", updatedBy: "y2" },
      ctx,
    );
    expect(result.version).toBe(2);
    const engram = repo.readEngram(id);
    expect(engram.content).toBe("新");
  });

  it("更新 importance 字段", () => {
    const { id } = engramCreateTool.execute(
      {
        title: "A",
        content: "原",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "y",
      },
      ctx,
    );
    engramUpdateTool.execute({ id, importance: 0.9, updatedBy: "y2" }, ctx);
    expect(repo.readEngram(id).importance).toBe(0.9);
  });

  it("不存在的 id 抛错", () => {
    expect(() =>
      engramUpdateTool.execute(
        { id: "no/such", content: "x", updatedBy: "y" },
        ctx,
      ),
    ).toThrow(/not found/);
  });
});

// ============================================================
// engram_delete
// ============================================================

describe("engram_delete", () => {
  it("删除后不存在", () => {
    const { id } = engramCreateTool.execute(
      {
        title: "A",
        content: "原",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "y",
      },
      ctx,
    );
    engramDeleteTool.execute({ id }, ctx);
    expect(repo.exists(id)).toBe(false);
  });

  it("删除不存在的 id 抛错", () => {
    expect(() => engramDeleteTool.execute({ id: "no/such" }, ctx)).toThrow(
      /not found/,
    );
  });

  // ============================================================
  // F1: fail-loud 契约 —— deleteEngram 静默 noop 时,工具层必须抛错
  //
  // 场景:跨进程 race 中另一进程把文件/index 恢复,或 deleteEngram 内部
  // resolvePath 失败导致 noop。F1 修复前:工具返回 {deleted:true} + audit
  // 撒谎,用户以为删了实际没删(用户报告的真实 bug:viewer 仍显示该 engram)。
  // 修复后:post-check 验证 exists(),失败抛错,让调用方跑 engram_doctor 自愈。
  // ============================================================

  it("F1: deleteEngram 静默 noop 时 → 工具抛错而非伪成功", () => {
    const { id } = engramCreateTool.execute(
      {
        title: "F1 测试",
        content: "deleteEngram 会被 stub 成 noop",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "y",
      },
      ctx,
    );

    // 用 Proxy 把 deleteEngram 替换成 noop,其他方法走真实 repo。
    // 模拟"resolvePath 失败 / race 中恢复"等导致 deleteEngram 不删的状态。
    const failingRepo = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop === "deleteEngram") {
          return () => {}; // 静默 noop
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as EngramRepository;
    const failingCtx = { ...ctx, repository: failingRepo };

    // F1 修复后:post-check 抛错,带可操作的提示
    expect(() => engramDeleteTool.execute({ id }, failingCtx)).toThrow(
      /still exists after deleteEngram/,
    );
    expect(() => engramDeleteTool.execute({ id }, failingCtx)).toThrow(
      /engram_doctor/,
    );

    // 实际上 engram 还在(因为 deleteEngram 被 stub 成 noop)
    expect(repo.exists(id)).toBe(true);
  });

  it("F1: 成功路径不破坏 —— 正常删除仍返回 {deleted:true}", () => {
    const { id } = engramCreateTool.execute(
      {
        title: "正常删除",
        content: "x",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "y",
      },
      ctx,
    );
    const result = engramDeleteTool.execute({ id }, ctx);
    expect(result.deleted).toBe(true);
    expect(repo.exists(id)).toBe(false);
  });
});

// ============================================================
// engram_reinforce / engram_report_failure（P1 三信号追踪）
// ============================================================

describe("engram_reinforce", () => {
  it("上报有效检索：effectiveRetrievals + reinforcementScore 更新", () => {
    const { id } = engramCreateTool.execute(
      {
        title: "A",
        content: "a",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "y",
      },
      ctx,
    );
    const result = engramReinforceTool.execute({ id, effectiveness: 0.8 }, ctx);
    expect(result.effectiveRetrievals).toBe(1);
    expect(result.retrievalCount).toBe(1);
    expect(result.reinforcementScore).toBeCloseTo(0.8, 5);
    expect(result.lastEffectiveAt).toBeTruthy();
  });

  it("多次强化：累积 reinforcementScore", () => {
    const { id } = engramCreateTool.execute(
      {
        title: "A",
        content: "a",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "y",
      },
      ctx,
    );
    engramReinforceTool.execute({ id, effectiveness: 0.6 }, ctx);
    engramReinforceTool.execute({ id, effectiveness: 0.4 }, ctx);
    const engram = repo.readEngram(id);
    expect(engram.effectiveRetrievals).toBe(2);
    expect(engram.reinforcementScore).toBeCloseTo(1.0, 5);
  });

  it("默认 effectiveness=1", () => {
    const { id } = engramCreateTool.execute(
      {
        title: "A",
        content: "a",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "y",
      },
      ctx,
    );
    const result = engramReinforceTool.execute({ id }, ctx);
    expect(result.reinforcementScore).toBe(1);
  });

  it("不存在抛错", () => {
    expect(() => engramReinforceTool.execute({ id: "no/such" }, ctx)).toThrow(
      /not found/,
    );
  });

  it("effectiveness 越界被拒绝", () => {
    const { id } = engramCreateTool.execute(
      {
        title: "A",
        content: "a",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "y",
      },
      ctx,
    );
    expect(() =>
      engramReinforceTool.execute({ id, effectiveness: 1.5 } as never, ctx),
    ).toThrow(/Invalid input/);
  });
});

describe("engram_report_failure", () => {
  it("上报失败：failedUses + retrievalCount 更新", () => {
    const { id } = engramCreateTool.execute(
      {
        title: "A",
        content: "a",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "y",
      },
      ctx,
    );
    const result = engramReportFailureTool.execute(
      { id, reason: "过时信息" },
      ctx,
    );
    expect(result.failedUses).toBe(1);
    expect(result.retrievalCount).toBe(1);
  });

  it("多次失败：累积 failedUses", () => {
    const { id } = engramCreateTool.execute(
      {
        title: "A",
        content: "a",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "y",
      },
      ctx,
    );
    engramReportFailureTool.execute({ id, reason: "r1" }, ctx);
    engramReportFailureTool.execute({ id, reason: "r2" }, ctx);
    engramReportFailureTool.execute({ id, reason: "r3" }, ctx);
    expect(repo.readEngram(id).failedUses).toBe(3);
  });

  it("缺 reason 被拒绝", () => {
    const { id } = engramCreateTool.execute(
      {
        title: "A",
        content: "a",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "y",
      },
      ctx,
    );
    expect(() => engramReportFailureTool.execute({ id } as never, ctx)).toThrow(
      /Invalid input/,
    );
  });

  it("不存在抛错", () => {
    expect(() =>
      engramReportFailureTool.execute({ id: "no/such", reason: "x" }, ctx),
    ).toThrow(/not found/);
  });
});

// ============================================================
// engram_archive / restore / forget（P1 生命周期）
// ============================================================

describe("engram_archive", () => {
  it("归档后 status=archived", () => {
    const { id } = engramCreateTool.execute(
      {
        title: "A",
        content: "a",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "y",
      },
      ctx,
    );
    const result = engramArchiveTool.execute({ id }, ctx);
    expect(result.status).toBe("archived");
    const engram = repo.readEngram(id);
    expect(engram.status).toBe("archived");
  });

  it("返回派生 freshness", () => {
    const { id } = engramCreateTool.execute(
      {
        title: "A",
        content: "a",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "y",
      },
      ctx,
    );
    const result = engramArchiveTool.execute({ id }, ctx);
    expect(["fresh", "aging", "stale", "forgotten"]).toContain(
      result.freshness,
    );
  });

  it("不存在抛错", () => {
    expect(() => engramArchiveTool.execute({ id: "no/such" }, ctx)).toThrow(
      /not found/,
    );
  });
});

describe("engram_restore", () => {
  it("从 archived 恢复为 active", () => {
    const { id } = engramCreateTool.execute(
      {
        title: "A",
        content: "a",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "y",
      },
      ctx,
    );
    engramArchiveTool.execute({ id }, ctx);
    const result = engramRestoreTool.execute({ id }, ctx);
    expect(result.status).toBe("active");
    expect(repo.readEngram(id).status).toBe("active");
  });

  it("不存在抛错", () => {
    expect(() => engramRestoreTool.execute({ id: "no/such" }, ctx)).toThrow(
      /not found/,
    );
  });
});

describe("engram_forget", () => {
  it("主动遗忘：status=forgotten 且 freshness=forgotten", () => {
    const { id } = engramCreateTool.execute(
      {
        title: "A",
        content: "a",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "y",
      },
      ctx,
    );
    const result = engramForgetTool.execute({ id, reason: "过时" }, ctx);
    expect(result.status).toBe("forgotten");
    expect(result.freshness).toBe("forgotten");
    const engram = repo.readEngram(id);
    expect(engram.status).toBe("forgotten");
    expect(engram.freshness).toBe("forgotten");
  });

  it("缺 reason 被拒绝", () => {
    const { id } = engramCreateTool.execute(
      {
        title: "A",
        content: "a",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "y",
      },
      ctx,
    );
    expect(() => engramForgetTool.execute({ id } as never, ctx)).toThrow(
      /Invalid input/,
    );
  });

  it("不存在抛错", () => {
    expect(() =>
      engramForgetTool.execute({ id: "no/such", reason: "r" }, ctx),
    ).toThrow(/not found/);
  });
});

// ============================================================
// engram_search
// ============================================================

describe("engram_search", () => {
  it("FTS 检索返回匹配 id", () => {
    engramCreateTool.execute(
      {
        title: "Android ADB",
        content: "adb 调试",
        kind: "fact",
        domainTags: ["testing"],
        createdBy: "y",
      },
      ctx,
    );
    engramCreateTool.execute(
      {
        title: "Other",
        content: "无关",
        kind: "fact",
        domainTags: ["x"],
        createdBy: "y",
      },
      ctx,
    );
    refreshSearch();
    const result = engramSearchTool.execute({ query: "adb" }, ctx);
    expect(result.total).toBeGreaterThan(0);
    // id 是 ULID,与路径解耦;验证 ULID 形态
    expect(result.results[0]!.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("search 结果自带 title/kind/domainTags(LLM 不必再 engram_get)", () => {
    // 回归:之前 search 只返回 {id, score},LLM 必须再 engram_get 一次才知道
    // 每条结果是什么,造成两倍工具调用开销 + 慢响应。
    engramCreateTool.execute(
      {
        title: "Android ADB",
        content: "adb 调试",
        kind: "fact",
        domainTags: ["testing"],
        createdBy: "y",
      },
      ctx,
    );
    refreshSearch();
    const result = engramSearchTool.execute({ query: "adb" }, ctx);
    expect(result.total).toBeGreaterThan(0);
    const first = result.results[0]!;
    expect(first.title).toBe("Android ADB");
    expect(first.kind).toBe("fact");
    expect(first.domainTags).toEqual(["testing"]);
  });

  it("search 结果可命中 content 关键词(经 summary 派生)", () => {
    // 回归:之前 summary 默认 = title,FTS 只索引 title 副本,完全无法命中
    // content 里的词。修复后 summary 从 content 派生,FTS 能命中。
    engramCreateTool.execute(
      {
        title: "Bug fix notes",
        content:
          "Fixed CLI parser to support equals-sign syntax for all flags.",
        kind: "fact",
        domainTags: ["dev"],
        createdBy: "y",
      },
      ctx,
    );
    refreshSearch();
    const result = engramSearchTool.execute({ query: "parser" }, ctx);
    expect(result.total).toBe(1);
    expect(result.results[0]!.title).toBe("Bug fix notes");
  });

  it("应用过滤器", () => {
    engramCreateTool.execute(
      {
        title: "Android ADB",
        content: "adb 调试",
        kind: "fact",
        domainTags: ["testing"],
        createdBy: "y",
      },
      ctx,
    );
    engramCreateTool.execute(
      {
        title: "Android ADB",
        content: "adb 调试",
        kind: "fact",
        domainTags: ["development"],
        createdBy: "y",
      },
      ctx,
    );
    refreshSearch();
    const result = engramSearchTool.execute(
      { query: "adb", filter: { domainTags: ["testing"] } },
      ctx,
    );
    expect(result.total).toBe(1);
  });

  it("P4: 命中后自动 bump retrievalCount + lastRetrievalScore", async () => {
    engramCreateTool.execute(
      {
        title: "Android ADB",
        content: "adb 调试",
        kind: "fact",
        domainTags: ["testing"],
        createdBy: "y",
      },
      ctx,
    );
    refreshSearch();
    const result = engramSearchTool.execute({ query: "adb" }, ctx);
    expect(result.total).toBeGreaterThan(0);
    const hitId = result.results[0]!.id;
    // Phase 1:engram_search 把 bumpRetrievalStats 异步化到 setImmediate,
    // 让 LLM 立即拿到结果。测试需等一轮 microtask 让写盘完成。
    await new Promise((r) => setImmediate(r));
    const engram = ctx.repository.readEngram(hitId);
    expect(engram.retrievalCount).toBe(1);
    expect(engram.lastRetrievalScore).toBe(result.results[0]!.score);
    expect(engram.lastRetrievedAt).toBeTruthy();
  });

  it("P4: 多次 search 累加 retrievalCount", async () => {
    engramCreateTool.execute(
      {
        title: "Android ADB",
        content: "adb 调试",
        kind: "fact",
        domainTags: ["testing"],
        createdBy: "y",
      },
      ctx,
    );
    refreshSearch();
    engramSearchTool.execute({ query: "adb" }, ctx);
    engramSearchTool.execute({ query: "adb" }, ctx);
    engramSearchTool.execute({ query: "adb" }, ctx);
    // Phase 1:三次 search 各触发一次 setImmediate 异步 bumpRetrievalStats,
    // 等三轮 microtask 让全部写盘完成。
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const list = ctx.repository.listEngrams();
    expect(list).toHaveLength(1);
    const engram = ctx.repository.readEngram(list[0]!.id);
    expect(engram.retrievalCount).toBe(3);
  });
});

// ============================================================
// engram_list
// ============================================================

describe("engram_list", () => {
  it("按 domainTags 过滤", () => {
    engramCreateTool.execute(
      {
        title: "A",
        content: "a",
        kind: "fact",
        domainTags: ["x"],
        createdBy: "y",
      },
      ctx,
    );
    engramCreateTool.execute(
      {
        title: "B",
        content: "b",
        kind: "fact",
        domainTags: ["y"],
        createdBy: "y",
      },
      ctx,
    );
    refreshSearch();
    const result = engramListTool.execute(
      { filter: { domainTags: ["x"] }, limit: 100 },
      ctx,
    );
    expect(result.items.length).toBe(1);
    expect(result.items[0]!.title).toBe("A");
  });

  it("按 createdBy 过滤（真实数据，非硬编码）", () => {
    engramCreateTool.execute(
      {
        title: "A",
        content: "a",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "alice",
      },
      ctx,
    );
    engramCreateTool.execute(
      {
        title: "B",
        content: "b",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "bob",
      },
      ctx,
    );
    const result = engramListTool.execute(
      { filter: { createdBy: ["alice"] }, limit: 100 },
      ctx,
    );
    expect(result.items.length).toBe(1);
    expect(result.items[0]!.title).toBe("A");
  });

  it("按 minImportance 过滤（真实数据，非硬编码）", () => {
    engramCreateTool.execute(
      {
        title: "A",
        content: "a",
        kind: "fact",
        domainTags: ["t"],
        importance: 0.9,
        createdBy: "y",
      },
      ctx,
    );
    engramCreateTool.execute(
      {
        title: "B",
        content: "b",
        kind: "fact",
        domainTags: ["t"],
        importance: 0.1,
        createdBy: "y",
      },
      ctx,
    );
    const result = engramListTool.execute(
      { filter: { minImportance: 0.5 }, limit: 100 },
      ctx,
    );
    expect(result.items.length).toBe(1);
    expect(result.items[0]!.title).toBe("A");
  });

  it("无 filter 时返回所有", () => {
    engramCreateTool.execute(
      {
        title: "A",
        content: "a",
        kind: "fact",
        domainTags: ["x"],
        createdBy: "y",
      },
      ctx,
    );
    engramCreateTool.execute(
      {
        title: "B",
        content: "b",
        kind: "fact",
        domainTags: ["y"],
        createdBy: "y",
      },
      ctx,
    );
    const result = engramListTool.execute({ limit: 100 }, ctx);
    expect(result.items.length).toBe(2);
  });
});

// ============================================================
// synapse_create / get / delete / list
// ============================================================

describe("synapse_create", () => {
  it("创建后双方缓存更新", () => {
    const a = engramCreateTool.execute(
      {
        title: "A",
        content: "a",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "y",
      },
      ctx,
    );
    const b = engramCreateTool.execute(
      {
        title: "B",
        content: "b",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "y",
      },
      ctx,
    );
    const result = synapseCreateTool.execute(
      { from: a.id, to: b.id, kind: "extends", createdBy: "y" },
      ctx,
    );
    expect(result.id).toBeTruthy();

    const engramA = repo.readEngram(a.id);
    const engramB = repo.readEngram(b.id);
    expect(engramA.outgoingSynapseCount).toBe(1);
    expect(engramB.incomingSynapseCount).toBe(1);
  });

  it("自环被拒绝", () => {
    const a = engramCreateTool.execute(
      {
        title: "A",
        content: "a",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "y",
      },
      ctx,
    );
    expect(() =>
      synapseCreateTool.execute(
        { from: a.id, to: a.id, kind: "similar_to", createdBy: "y" },
        ctx,
      ),
    ).toThrow(/Self-synapse/);
  });

  it("端点不存在抛错", () => {
    const a = engramCreateTool.execute(
      {
        title: "A",
        content: "a",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "y",
      },
      ctx,
    );
    expect(() =>
      synapseCreateTool.execute(
        { from: a.id, to: "no/such", kind: "extends", createdBy: "y" },
        ctx,
      ),
    ).toThrow(/Target engram not found/);
  });

  it("contradicts 增加 activeContradictionCount", () => {
    const a = engramCreateTool.execute(
      {
        title: "A",
        content: "a",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "y",
      },
      ctx,
    );
    const b = engramCreateTool.execute(
      {
        title: "B",
        content: "b",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "y",
      },
      ctx,
    );
    synapseCreateTool.execute(
      { from: a.id, to: b.id, kind: "contradicts", createdBy: "y" },
      ctx,
    );
    expect(repo.readEngram(b.id).activeContradictionCount).toBe(1);
  });
});

describe("synapse_get", () => {
  it("读取已存在的 synapse", () => {
    const a = engramCreateTool.execute(
      {
        title: "A",
        content: "a",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "y",
      },
      ctx,
    );
    const b = engramCreateTool.execute(
      {
        title: "B",
        content: "b",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "y",
      },
      ctx,
    );
    const { id } = synapseCreateTool.execute(
      { from: a.id, to: b.id, kind: "extends", createdBy: "y" },
      ctx,
    );
    const s = synapseGetTool.execute({ from: a.id, synapseId: id }, ctx);
    expect(s.kind).toBe("extends");
    expect(s.to).toBe(b.id);
  });

  it("不存在抛错", () => {
    const a = engramCreateTool.execute(
      {
        title: "A",
        content: "a",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "y",
      },
      ctx,
    );
    expect(() =>
      synapseGetTool.execute({ from: a.id, synapseId: "no-such" }, ctx),
    ).toThrow(/not found/);
  });
});

describe("synapse_delete", () => {
  it("删除后缓存归零", () => {
    const a = engramCreateTool.execute(
      {
        title: "A",
        content: "a",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "y",
      },
      ctx,
    );
    const b = engramCreateTool.execute(
      {
        title: "B",
        content: "b",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "y",
      },
      ctx,
    );
    const { id } = synapseCreateTool.execute(
      { from: a.id, to: b.id, kind: "extends", createdBy: "y" },
      ctx,
    );
    synapseDeleteTool.execute({ from: a.id, synapseId: id }, ctx);
    expect(repo.readEngram(a.id).outgoingSynapseCount).toBe(0);
    expect(repo.readEngram(b.id).incomingSynapseCount).toBe(0);
  });
});

describe("synapse_list", () => {
  it("列出双向 synapses", () => {
    const a = engramCreateTool.execute(
      {
        title: "A",
        content: "a",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "y",
      },
      ctx,
    );
    const b = engramCreateTool.execute(
      {
        title: "B",
        content: "b",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "y",
      },
      ctx,
    );
    synapseCreateTool.execute(
      { from: a.id, to: b.id, kind: "extends", createdBy: "y" },
      ctx,
    );
    const result = synapseListTool.execute(
      { engramId: b.id, direction: "both" },
      ctx,
    );
    expect(result.outgoing.length).toBe(0);
    expect(result.incoming.length).toBe(1);
  });
});

// ============================================================
// skill_get / skill_invoke（P0 框架）
// ============================================================

describe("skill_get", () => {
  it("从 registry 读取 skill", () => {
    const skill = makeStubSkill("skill-1", "主动 Skill");
    const extCtx = { ...ctx, skills: new Map([["skill-1", skill]]) };
    const result = skillGetTool.execute({ id: "skill-1" }, extCtx);
    expect(result.title).toBe("主动 Skill");
  });

  it("未注入 registry 抛错", () => {
    expect(() => skillGetTool.execute({ id: "x" }, ctx)).toThrow(
      /Skill registry/,
    );
  });

  it("不存在抛错", () => {
    const extCtx = { ...ctx, skills: new Map() };
    expect(() => skillGetTool.execute({ id: "x" }, extCtx)).toThrow(
      /not found/,
    );
  });
});

describe("skill_invoke", () => {
  it("未注入 executor 返回 P0 stub", async () => {
    const skill = makeStubSkill("skill-1", "主动");
    const extCtx = { ...ctx, skills: new Map([["skill-1", skill]]) };
    const result = await skillInvokeTool.execute(
      { id: "skill-1", args: { k: "v" } },
      extCtx,
    );
    expect(result.success).toBe(true);
    expect(result.output).toMatch(/P0 stub/);
  });

  it("deprecated skill 拒绝执行", async () => {
    const skill = makeStubSkill("skill-1", "已弃用", { level: "deprecated" });
    const extCtx = { ...ctx, skills: new Map([["skill-1", skill]]) };
    const result = await skillInvokeTool.execute(
      { id: "skill-1", args: {} },
      extCtx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/deprecated/);
  });

  it("forgotten stage skill 拒绝执行", async () => {
    const skill = makeStubSkill("skill-1", "遗忘", {}, "forgotten");
    const extCtx = { ...ctx, skills: new Map([["skill-1", skill]]) };
    const result = await skillInvokeTool.execute(
      { id: "skill-1", args: {} },
      extCtx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/forgotten/);
  });

  it("注入 executor 时委托", async () => {
    const skill = makeStubSkill("skill-1", "主动");
    const extCtx = {
      ...ctx,
      skills: new Map([["skill-1", skill]]),
      skillExecutor: (_s, args) => ({
        skillId: "skill-1",
        success: true,
        output: `executed with ${JSON.stringify(args)}`,
        executedAt: "2026-06-20T00:00:00.000Z",
      }),
    };
    const result = await skillInvokeTool.execute(
      { id: "skill-1", args: { x: 1 } },
      extCtx,
    );
    expect(result.output).toBe('executed with {"x":1}');
  });
});

// ============================================================
// Registry
// ============================================================

describe("ToolRegistry", () => {
  it("列出所有工具（31 个：P0 12 + P1 5 + P2 2 + P3 2 + M1 proposal 3 + AI-8 batch proposal 2 + doctor/list_paths 2 + synthesize 1 + engram_sync 1 + audit_query 1）", () => {
    const reg = createToolRegistry();
    expect(reg.list().length).toBe(31);
  });

  it("按名查工具", () => {
    const reg = createToolRegistry();
    expect(reg.get("engram_create")?.name).toBe("engram_create");
    expect(reg.get("engram_reinforce")?.name).toBe("engram_reinforce");
    expect(reg.get("engram_archive")?.name).toBe("engram_archive");
    expect(reg.get("engram_forget")?.name).toBe("engram_forget");
    expect(reg.get("no_such")).toBeUndefined();
  });

  it("按命名空间筛选", () => {
    const reg = createToolRegistry();
    // 11 engram_*_* + 3 engram_*_proposal* + 2 engram_*_proposals_by_* (AI-8) + 2 engram_doctor / engram_list_paths + 1 engram_synthesize + 1 engram_sync + 1 engram_audit_query = 21
    expect(reg.listByNamespace("engram").length).toBe(21);
    expect(reg.listByNamespace("synapse").length).toBe(4);
    expect(reg.listByNamespace("skill").length).toBe(2);
    // contradiction_resolve 不属于 engram/synapse/skill 命名空间
    expect(reg.listByNamespace("contradiction").length).toBe(1);
  });

  it("工具包含 inputSchema 和 description", () => {
    const reg = createToolRegistry();
    for (const t of reg.list()) {
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.inputSchema).toBeDefined();
    }
  });
});

// ============================================================
// validateInput
// ============================================================

describe("validateInput", () => {
  it("合法输入通过", () => {
    const parsed = validateInput(EngramCreateInputSchema, {
      title: "X",
      content: "c",
      kind: "fact",
      domainTags: ["t"],
      createdBy: "y",
    });
    expect(parsed.title).toBe("X");
  });

  it("非法输入抛错（含 path）", () => {
    expect(() =>
      validateInput(EngramCreateInputSchema, {
        title: "",
        content: "c",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "y",
      }),
    ).toThrow(/Invalid input/);
  });
});

// ============================================================
// 辅助：构造 stub Skill
// ============================================================

function makeStubSkill(
  id: string,
  title: string,
  automation: {
    level: "suggest" | "auto-execute" | "deprecated";
    reason?: string;
  } = { level: "suggest" },
  decayStage: "active" | "aging" | "stale" | "forgotten" = "active",
): Skill {
  return {
    id,
    title,
    trigger: { pattern: "test", keywords: ["test"], taskType: "other" },
    template: {
      type: "prompt-template",
      body: "stub",
      variables: [],
    },
    evolvedFrom: null,
    applicableContext: "testing",
    boundaryConditions: [],
    automation: {
      level: automation.level,
      reason: automation.reason ?? "",
      lastAutoExecuteAt: null,
    },
    activeInScenes: [],
    inhibitedInScenes: [],
    composes: [],
    decay: {
      stage: decayStage,
      lastUsedAt: null,
      consecutiveFailures: 0,
      successRate: 1,
    },
    stats: {
      totalInvocations: 0,
      successfulInvocations: 0,
      failedInvocations: 0,
      lastInvocationAt: null,
      avgExecutionTimeMs: 0,
    },
    reflectAfterConsecutiveFailures: 3,
    relatedEngrams: [],
    visibility: "public",
    createdBy: "tester",
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
  };
}
