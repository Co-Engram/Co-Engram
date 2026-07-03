/**
 * Engram 工具集
 *
 * 11 个工具（P0 六个 + P1 五个：三信号 + 生命周期）：
 *   - engram_create / engram_get / engram_update / engram_delete
 *   - engram_search / engram_list
 *   - engram_reinforce / engram_report_failure（三信号）
 *   - engram_archive / engram_restore / engram_forget（生命周期）
 *
 * @module @co-engram/core/tools
 */

import type { EngramView, SynapseBundle } from "../types/disclosure.js";
import type {
  Engram,
  EngramCatalogEntry,
  EngramDigest,
} from "../types/engram.js";
import type { DigestLine } from "../index/types.js";
import type { EngramRepository } from "../storage/repository.js";
import type { Tool, ToolContext } from "./tool.js";
import { validateInput } from "./tool.js";
import { matchesFilter } from "../retrieval/filter.js";
import { computeFreshness } from "../lifecycle/freshness.js";
import { adaptiveDisclosure } from "../disclosure/adaptive.js";
import { createBudget } from "../disclosure/budget.js";
import { formatScoreField } from "../concepts/dictionary.js";
import {
  recordRetrievalSuccess,
  reinforceEngram,
} from "../reinforcement/ltp.js";
import { recordRetrievalFailure } from "../reinforcement/ltd.js";
import { reinforceRelated } from "../reinforcement/related.js";
import { DEFAULT_CONFIG as DEFAULT_REINFORCEMENT_CONFIG } from "../reinforcement/config.js";
import { checkDuplicateSync } from "../dedup/dedupe.js";
import { mergeEngram } from "../dedup/merge.js";
import { recomputeImportance } from "../importance/vector.js";
import { manualResolveContradiction } from "../contradiction/index.js";
import { closeLearningLoop } from "../learning/loop.js";
import { upgradeVerification } from "../verification/index.js";
import { getEvolutionLineage } from "../lineage/index.js";
import { restoreFromTrash } from "../dreaming/trash.js";
import { collectDigestLines } from "../index/digest-builder.js";
import {
  EngramCreateInputSchema,
  EngramGetInputSchema,
  EngramUpdateInputSchema,
  EngramDeleteInputSchema,
  EngramSearchInputSchema,
  EngramListInputSchema,
  EngramReinforceInputSchema,
  EngramReportFailureInputSchema,
  EngramArchiveInputSchema,
  EngramRestoreInputSchema,
  EngramForgetInputSchema,
  EngramRecomputeImportanceInputSchema,
  ContradictionResolveInputSchema,
  CloseLearningLoopInputSchema,
  UpgradeVerificationInputSchema,
  GetEvolutionLineageInputSchema,
  type EngramCreateToolInput,
  type EngramGetToolInput,
  type EngramUpdateToolInput,
  type EngramDeleteToolInput,
  type EngramSearchToolInput,
  type EngramListToolInput,
  type EngramReinforceToolInput,
  type EngramReportFailureToolInput,
  type EngramArchiveToolInput,
  type EngramRestoreToolInput,
  type EngramForgetToolInput,
  type EngramRecomputeImportanceToolInput,
  type ContradictionResolveToolInput,
  type CloseLearningLoopToolInput,
  type UpgradeVerificationToolInput,
  type GetEvolutionLineageToolInput,
} from "./schemas.js";

// ============================================================
// engram_create
// ============================================================

export interface EngramCreateResult {
  readonly id: string;
  readonly verdict: "NEW" | "DUPLICATE" | "UPDATE";
  readonly targetId?: string;
  readonly reason?: string;
  readonly confidence?: number;
  readonly candidatesConsidered?: number;
  /**
   * 可选:内容安全警告(P0-8 配套)。
   *
   * 检测 content/title 含 `<script>` / `javascript:` / `<iframe>` / `on\w+=`
   * 等潜在 XSS 向量时,工具不阻断创建,但返回警告让调用方知道内容可能
   * 在 viewer 中受限或被 sanitize 后展示。
   */
  readonly warnings?: readonly string[];
}

/**
 * 检测 engram 内容/title 是否含潜在 XSS 向量(P0-8 配套,非阻断)。
 *
 * 不阻断创建的原因:engram 是知识载体,代码片段 legitimately 含 `<script>`
 * 等字符串(如"调试 XSS 时用 `<script>alert(1)</script>` 复现")。
 * 阻断会破坏正常使用。改为返回 warnings,让调用方知道 viewer 渲染时
 * 会被 DOMPurify sanitize。
 */
function detectUnsafeEngramContent(input: {
  readonly title: string;
  readonly content: string;
  readonly summary?: string;
}): readonly string[] {
  const warnings: string[] = [];
  const haystack = `${input.title}\n${input.content}${
    input.summary ? `\n${input.summary}` : ""
  }`;
  const patterns: readonly { readonly re: RegExp; readonly label: string }[] = [
    { re: /<script\b/i, label: "<script> tag" },
    { re: /<iframe\b/i, label: "<iframe> tag" },
    { re: /<object\b/i, label: "<object> tag" },
    { re: /<embed\b/i, label: "<embed> tag" },
    { re: /\bjavascript:/i, label: "javascript: protocol" },
    { re: /\bvbscript:/i, label: "vbscript: protocol" },
    { re: /\bon\w+\s*=/i, label: "inline event handler (onX=)" },
  ];
  for (const { re, label } of patterns) {
    if (re.test(haystack)) {
      warnings.push(
        `Content contains ${label}; viewer will sanitize before display.`,
      );
    }
  }
  return warnings;
}

export const engramCreateTool: Tool<EngramCreateToolInput, EngramCreateResult> =
  {
    name: "engram_create",
    description:
      '创建一个新的 Engram（记忆单元）。需要 title / content / kind / domainTags；createdBy 可选,缺省时回退到 ToolContext.defaultCreatedBy(MCP: CO_ENGRAM_DEFAULT_CREATED_BY 环境变量;OpenClaw: plugin config.defaultCreatedBy),再缺省回退到 "unknown"。默认开启智能去重（dedupe=true）：DUPLICATE 时强化原 engram 不重复创建；UPDATE 时合并；NEW 时正常创建。',
    inputSchema: EngramCreateInputSchema,
    execute(input, ctx) {
      const parsed = validateInput<EngramCreateToolInput>(
        EngramCreateInputSchema,
        input,
      );
      const createdBy = parsed.createdBy ?? ctx.defaultCreatedBy ?? "unknown";
      // P0-8 配套:检测 XSS 向量(非阻断),让调用方知道 viewer 会 sanitize
      const warnings = detectUnsafeEngramContent({
        title: parsed.title,
        content: parsed.content,
        ...(parsed.summary ? { summary: parsed.summary } : {}),
      });

      if (parsed.dedupe !== false) {
        const dedupResult = checkDuplicateSync(
          { repository: ctx.repository },
          {
            title: parsed.title,
            content: parsed.content,
            kind: parsed.kind,
            kinds: parsed.kinds,
            summary: parsed.summary,
            domainTags: parsed.domainTags,
            contextTags: parsed.contextTags,
            encodingContext: parsed.encodingContext,
            importance: parsed.importance,
            confidence: parsed.confidence,
            emotionalValence: parsed.emotionalValence,
            sourceType: parsed.sourceType,
            visibility: parsed.visibility,
            decayHalfLifeDays: parsed.decayHalfLifeDays,
            createdBy,
          },
        );

        if (dedupResult.verdict === "DUPLICATE" && dedupResult.targetId) {
          // 强化原 engram：再次见到视为有效检索（effectiveness=1）
          recordRetrievalSuccess(ctx.repository, dedupResult.targetId, 1);
          return {
            id: dedupResult.targetId,
            verdict: "DUPLICATE",
            targetId: dedupResult.targetId,
            reason: dedupResult.reason,
            confidence: dedupResult.confidence,
            candidatesConsidered: dedupResult.candidatesConsidered,
            ...(warnings.length > 0 ? { warnings } : {}),
          };
        }

        if (dedupResult.verdict === "UPDATE" && dedupResult.targetId) {
          mergeEngram(ctx.repository, {
            id: dedupResult.targetId,
            newTitle: parsed.title,
            newContent: parsed.content,
            newSummary: parsed.summary,
            newImportance: parsed.importance,
            mergedBy: createdBy,
            reason: dedupResult.reason ?? "dedup auto-merge",
          });
          invalidateSearchIndex(ctx);
          return {
            id: dedupResult.targetId,
            verdict: "UPDATE",
            targetId: dedupResult.targetId,
            reason: dedupResult.reason,
            confidence: dedupResult.confidence,
            candidatesConsidered: dedupResult.candidatesConsidered,
            ...(warnings.length > 0 ? { warnings } : {}),
          };
        }
      }

      const engram = ctx.repository.createEngram({
        title: parsed.title,
        content: parsed.content,
        kind: parsed.kind,
        kinds: parsed.kinds,
        summary: parsed.summary,
        domainTags: parsed.domainTags,
        contextTags: parsed.contextTags,
        encodingContext: parsed.encodingContext,
        importance: parsed.importance,
        confidence: parsed.confidence,
        emotionalValence: parsed.emotionalValence,
        sourceType: parsed.sourceType,
        visibility: parsed.visibility,
        decayHalfLifeDays: parsed.decayHalfLifeDays,
        createdBy,
      });
      invalidateSearchIndex(ctx);
      ctx.auditLog?.append({
        actor: "user",
        action: "create",
        engramId: engram.id,
        metadata: {
          title: parsed.title,
          kind: parsed.kind,
          domainTags: parsed.domainTags,
          createdBy,
        },
      });
      return {
        id: engram.id,
        verdict: "NEW",
        candidatesConsidered: 0,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    },
  };

// ============================================================
// engram_get
// ============================================================

export const engramGetTool: Tool<EngramGetToolInput, EngramView> = {
  name: "engram_get",
  description:
    "按披露层级（catalog / digest / content / meta / synapses / auto）读取 Engram。auto 模式按 contextBudget 自动选 tier。",
  inputSchema: EngramGetInputSchema,
  execute(input, ctx) {
    const parsed = validateInput<EngramGetToolInput>(
      EngramGetInputSchema,
      input,
    );
    if (parsed.tier === "auto") {
      return readEngramViewAuto(ctx.repository, parsed.id, {
        contextBudget: parsed.contextBudget,
        score: parsed.score,
      });
    }
    return readEngramView(ctx.repository, parsed.id, parsed.tier);
  },
};

/**
 * auto 模式：调用 adaptiveDisclosure 决定 tier
 *
 * 把单条 engram 当作唯一的候选传入。
 */
function readEngramViewAuto(
  repo: EngramRepository,
  id: string,
  options: {
    contextBudget?: { totalTokens: number; reserved?: number };
    score?: number;
  },
): EngramView {
  const totalTokens = options.contextBudget?.totalTokens ?? 4096;
  const reserved = options.contextBudget?.reserved ?? 0;
  const budget = createBudget(totalTokens, reserved);
  const digest = repo.readDigest(id);
  if (!digest) throw new Error(`Engram not found: ${id}`);

  const line: DigestLine = {
    id,
    title: digest.title,
    kind: digest.kind,
    kinds: [digest.kind],
    summary: digest.summary,
    domainTags: digest.domainTags,
    contextTags: [],
    importance: digest.importance,
    emotionalValence: digest.emotionalValence,
    freshness: digest.freshness,
    status: "active",
    sourceType: "firsthand",
    createdBy: "",
    createdAt: digest.updatedAt,
    updatedAt: digest.updatedAt,
    lastRetrievedAt: null,
    lastEffectiveAt: null,
    retrievalCount: 0,
    effectiveRetrievals: 0,
    failedUses: 0,
    reinforcementScore: 0,
    decayHalfLifeDays: 90,
    contentSize: digest.contentSize,
    contentHash: "",
    outgoingSynapseCount: 0,
    incomingSynapseCount: 0,
    activeContradictionCount: 0,
  };

  const result = adaptiveDisclosure({
    repository: repo,
    candidates: [{ id, score: options.score ?? 1 }],
    digestLines: { [id]: line },
    budget,
  });
  const entry = result.loaded[0];
  if (!entry) {
    // 预算极小，连 catalog 都装不下 → 降级为直接读 catalog
    return readEngramView(repo, id, "catalog");
  }
  return entry.view;
}

/**
 * 读取 EngramView（被工具 / adapter 共用）
 */
export function readEngramView(
  repo: EngramRepository,
  id: string,
  tier: "catalog" | "digest" | "content" | "meta" | "synapses",
): EngramView {
  switch (tier) {
    case "catalog": {
      const entry = repo.readCatalogEntry(id);
      if (!entry) throw new Error(`Engram not found: ${id}`);
      return { tier: "catalog", entry };
    }
    case "digest": {
      const digest = repo.readDigest(id);
      if (!digest) throw new Error(`Engram not found: ${id}`);
      return { tier: "digest", digest };
    }
    case "content": {
      const engram = repo.readEngram(id);
      return {
        tier: "content",
        entry: toCatalogEntry(engram),
        content: engram.content,
      };
    }
    case "meta": {
      const engram = repo.readEngram(id);
      return {
        tier: "meta",
        entry: toCatalogEntry(engram),
        meta: stripContentFromMeta(engram),
      };
    }
    case "synapses": {
      const entry = repo.readCatalogEntry(id);
      if (!entry) throw new Error(`Engram not found: ${id}`);
      const outgoingFile = repo.readSynapses(id);
      const incoming = collectIncoming(repo, id);
      const neighborDigests = collectNeighborDigests(
        repo,
        id,
        outgoingFile.outgoing,
        incoming,
      );
      const bundle: SynapseBundle = {
        engramId: id,
        outgoing: outgoingFile.outgoing,
        incoming,
        neighborDigests,
      };
      return { tier: "synapses", bundle };
    }
  }
}

function toCatalogEntry(engram: Engram): EngramCatalogEntry {
  return {
    id: engram.id,
    title: engram.title,
    kind: engram.kind,
    domainTags: engram.domainTags,
  };
}

/** meta tier 不暴露 body（避免双重传输） */
function stripContentFromMeta(engram: Engram): Record<string, unknown> {
  const { content: _content, ...rest } = engram;
  return rest as unknown as Record<string, unknown>;
}

/** 收集指向 id 的 incoming synapses（需要扫所有 engram） */
function collectIncoming(repo: EngramRepository, id: string) {
  const all = repo.collectAllSynapses();
  return all
    .filter(({ synapse }) => synapse.to === id)
    .map(({ synapse }) => synapse);
}

function collectNeighborDigests(
  repo: EngramRepository,
  _selfId: string,
  outgoing: readonly { to: string }[],
  incoming: readonly { from: string }[],
): EngramDigest[] {
  const neighborIds = new Set<string>();
  for (const s of outgoing) neighborIds.add(s.to);
  for (const s of incoming) neighborIds.add(s.from);
  const digests: EngramDigest[] = [];
  for (const nid of neighborIds) {
    const d = repo.readDigest(nid);
    if (d) digests.push(d);
  }
  return digests;
}

// ============================================================
// engram_update
// ============================================================

/**
 * 跟踪 engram_update 的字段对比(用于 audit log)
 *
 * 不在表中的字段(version / updatedAt / retrievalCount 等系统字段)不算"用户修改"。
 */
const TRACKED_ENGRAM_FIELDS = [
  "title",
  "summary",
  "content",
  "kinds",
  "domainTags",
  "contextTags",
  "encodingContext",
  "importance",
  "confidence",
  "emotionalValence",
  "decayHalfLifeDays",
  "visibility",
] as const;

/** 字段值在 audit 中的最大长度(超出截断,防 audit.jsonl 爆炸) */
const FIELD_TRUNCATE: Readonly<Record<string, number>> = {
  title: 80,
  summary: 120,
  content: 240,
  encodingContext: 120,
};

function truncateFieldValue(field: string, value: unknown): unknown {
  if (typeof value === "string") {
    const max = FIELD_TRUNCATE[field] ?? 0;
    if (max > 0 && value.length > max) {
      const head = Math.ceil(max * 0.6);
      const tail = Math.floor(max * 0.3);
      const omitted = value.length - head - tail;
      return (
        value.slice(0, head) +
        `…[${omitted} chars omitted]…` +
        value.slice(-tail)
      );
    }
  }
  return value;
}

/**
 * 对比 before / after,返回每个变化字段的 { from, to }
 *
 * 用 JSON.stringify 等价比较覆盖数组 / 对象 / 基本类型,简单稳健。
 */
function diffEngramFields(
  before: Engram,
  after: Engram,
): Record<string, { from: unknown; to: unknown }> {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const f of TRACKED_ENGRAM_FIELDS) {
    const b = before[f];
    const a = after[f];
    if (JSON.stringify(b) === JSON.stringify(a)) continue;
    changes[f] = {
      from: truncateFieldValue(f, b),
      to: truncateFieldValue(f, a),
    };
  }
  return changes;
}

export const engramUpdateTool: Tool<
  EngramUpdateToolInput,
  { id: string; version: number }
> = {
  name: "engram_update",
  description: "更新 Engram 的字段（content / title / importance / 等）。",
  inputSchema: EngramUpdateInputSchema,
  execute(input, ctx) {
    const parsed = validateInput<EngramUpdateToolInput>(
      EngramUpdateInputSchema,
      input,
    );
    // 取 before 用于 audit diff;若 engram 不存在 updateEngram 会抛,这里 readEngram 也抛
    const before = ctx.repository.readEngram(parsed.id);
    const engram = ctx.repository.updateEngram(parsed.id, {
      title: parsed.title,
      content: parsed.content,
      summary: parsed.summary,
      kinds: parsed.kinds,
      domainTags: parsed.domainTags,
      contextTags: parsed.contextTags,
      encodingContext: parsed.encodingContext,
      importance: parsed.importance,
      confidence: parsed.confidence,
      emotionalValence: parsed.emotionalValence,
      decayHalfLifeDays: parsed.decayHalfLifeDays,
      visibility: parsed.visibility,
      updatedBy: parsed.updatedBy,
    });
    invalidateSearchIndex(ctx);
    ctx.auditLog?.append({
      actor: "user",
      action: "update",
      engramId: engram.id,
      metadata: {
        updatedBy: parsed.updatedBy,
        changes: diffEngramFields(before, engram),
      },
    });
    return { id: engram.id, version: engram.version };
  },
};

// ============================================================
// engram_delete
// ============================================================

export const engramDeleteTool: Tool<
  EngramDeleteToolInput,
  { id: string; deleted: true }
> = {
  name: "engram_delete",
  description: "删除 Engram（content + meta + synapses 三文件一起删）。",
  inputSchema: EngramDeleteInputSchema,
  execute(input, ctx) {
    const parsed = validateInput<EngramDeleteToolInput>(
      EngramDeleteInputSchema,
      input,
    );
    if (!ctx.repository.exists(parsed.id)) {
      throw new Error(`Engram not found: ${parsed.id}`);
    }
    ctx.repository.deleteEngram(parsed.id);
    // F1 修复(fail-loud 契约):post-check 验证删除真的生效。
    // 防止 deleteEngram 内部静默 noop(resolvePath 失败、跨进程 race 中
    // 文件/index 被恢复等)导致工具层"伪成功" + audit 撒谎。
    // 用户报告的真实场景:engram_delete 返回 {deleted:true},但网页 viewer
    // 还显示该 engram,因为另一进程的 cache 把旧 entry 写回了。
    // 这里发现不一致立即抛错,让调用方跑 engram_doctor 自愈,而非撒谎。
    if (ctx.repository.exists(parsed.id)) {
      throw new Error(
        `engram_delete failed: ${parsed.id} still exists after deleteEngram ` +
          `(race condition or index/file inconsistency — run engram_doctor to self-heal)`,
      );
    }
    invalidateSearchIndex(ctx);
    ctx.auditLog?.append({
      actor: "user",
      action: "purge",
      engramId: parsed.id,
    });
    return { id: parsed.id, deleted: true as const };
  },
};

// ============================================================
// engram_search
// ============================================================

export const engramSearchTool: Tool<
  EngramSearchToolInput,
  {
    results: Array<{
      id: string;
      score: number;
      title: string;
      kind: string;
      domainTags: readonly string[];
    }>;
    total: number;
  }
> = {
  name: "engram_search",
  description: "FTS 全文检索（中文 bigram + 英文 word），可选过滤器。",
  inputSchema: EngramSearchInputSchema,
  execute(input, ctx) {
    const parsed = validateInput<EngramSearchToolInput>(
      EngramSearchInputSchema,
      input,
    );
    if (!ctx.searchOrchestrator) {
      throw new Error("SearchOrchestrator not available in ToolContext");
    }
    const results = ctx.searchOrchestrator.search(
      parsed.query,
      parsed.filter,
      parsed.limit,
    );
    // P4 自动维护：命中后立即 bump retrieval stats（不触发 version++）
    // 用于 RPE 公式的 expected 基准
    const timestamp = new Date().toISOString();
    for (const r of results) {
      try {
        ctx.repository.bumpRetrievalStats(r.id, {
          retrievedDelta: 1,
          lastRetrievalScore: r.score,
          lastRetrievedAt: timestamp,
        });
      } catch {
        // bump 失败不阻塞 search 结果（可能 engram 已被并发删除）
      }
      // M1: 为每个 hit 开观察窗口（如果配置了 effectivenessTracker）
      const engram = safeReadEngram(ctx, r.id);
      if (engram) {
        ctx.effectivenessTracker?.openWindow({
          engramId: r.id,
          query: parsed.query,
          score: r.score,
          kinds: engram.kinds ?? [engram.kind],
          sessionId: ctx.sessionId,
        });
      }
    }
    return {
      // title/kind/domainTags 让 LLM 不必再 engram_get 才知道每条结果是啥。
      // orchestrator 已经从 DigestLine 带出了 entry 字段,直接展开。
      results: results.map((r) => ({
        id: r.id,
        score: r.score,
        title: r.entry.title,
        kind: r.entry.kind,
        domainTags: r.entry.domainTags,
      })),
      total: results.length,
    };
  },
};

// ============================================================
// engram_list
// ============================================================

export const engramListTool: Tool<
  EngramListToolInput,
  { results: EngramCatalogEntry[]; total: number }
> = {
  name: "engram_list",
  description: "按过滤器列出 Engram（无查询，按元数据过滤，直接读最新数据）。",
  inputSchema: EngramListInputSchema,
  execute(input, ctx) {
    const parsed = validateInput<EngramListToolInput>(
      EngramListInputSchema,
      input,
    );
    const entries = ctx.repository.listEngrams();
    const lines: DigestLine[] = [];
    for (const entry of entries) {
      const engram = ctx.repository.readEngram(entry.id);
      lines.push(engramToDigestLine(engram));
    }
    const filtered = lines.filter((line) => matchesFilter(line, parsed.filter));
    const limited = filtered.slice(0, parsed.limit);
    return {
      results: limited.map((line) => ({
        id: line.id,
        title: line.title,
        kind: line.kind as EngramCatalogEntry["kind"],
        domainTags: line.domainTags,
      })),
      total: filtered.length,
    };
  },
};

/** Engram → DigestLine（用于过滤） */
function engramToDigestLine(engram: Engram): DigestLine {
  return {
    id: engram.id,
    title: engram.title,
    kind: engram.kind,
    kinds: engram.kinds,
    summary: engram.summary,
    domainTags: engram.domainTags,
    contextTags: engram.contextTags,
    importance: engram.importance,
    emotionalValence: engram.emotionalValence,
    freshness: engram.freshness,
    status: engram.status,
    sourceType: engram.sourceType,
    createdBy: engram.createdBy,
    createdAt: engram.createdAt,
    updatedAt: engram.updatedAt,
    lastRetrievedAt: engram.lastRetrievedAt ?? null,
    lastEffectiveAt: engram.lastEffectiveAt ?? null,
    retrievalCount: engram.retrievalCount,
    effectiveRetrievals: engram.effectiveRetrievals,
    failedUses: engram.failedUses,
    reinforcementScore: engram.reinforcementScore,
    decayHalfLifeDays: engram.decayHalfLifeDays,
    contentSize: engram.contentSize,
    contentHash: engram.contentHash,
    outgoingSynapseCount: engram.outgoingSynapseCount,
    incomingSynapseCount: engram.incomingSynapseCount,
    activeContradictionCount: engram.activeContradictionCount,
  };
}

/**
 * 写入操作后失效搜索索引,并立即从 repository 重建
 *
 * 之前的实现是 no-op,依赖 host adapter 手动 rebuild,但 host 无从得知何时该 rebuild,
 * 导致用户新建 engram 后立即 engram_search 搜不到（索引是启动时的快照）。
 *
 * 当前实现:用 collectDigestLines(repo) 拉取真实 DigestLine[](含真实 importance /
 * decayHalfLifeDays / retrievalCount / reinforcementScore 等),让三因子打分能正常工作。
 *
 * 代价是每次写入都做一次 O(N) rebuild；N 通常 < 10k,可接受。
 * 后续 P1 改为增量更新（只插入/更新被改动的 engram）。
 */
function invalidateSearchIndex(ctx: ToolContext): void {
  if (!ctx.searchOrchestrator) return;
  ctx.searchOrchestrator.build(collectDigestLines(ctx.repository));
}

/** 读取 engram,失败时返回 null（不抛） */
function safeReadEngram(ctx: ToolContext, id: string): Engram | null {
  try {
    return ctx.repository.readEngram(id);
  } catch {
    return null;
  }
}

// ============================================================
// engram_reinforce（P1：三信号追踪 - 有效检索 LTP）
// ============================================================

export const engramReinforceTool: Tool<
  EngramReinforceToolInput,
  {
    id: string;
    retrievalCount: number;
    effectiveRetrievals: number;
    reinforcementScore: number;
    reinforcementScoreBand: import("../concepts/types.js").ScoreBand;
    importance: number;
    importanceBand: import("../concepts/types.js").ScoreBand;
    importanceDelta: number;
    importanceDeltaBand: import("../concepts/types.js").ScoreBand;
    lastEffectiveAt: string;
    reinforcedNeighborIds: readonly string[];
  }
> = {
  name: "engram_reinforce",
  description:
    "上报一次有效检索（LTP 强化 + Hebbian 关联强化）。更新 effectiveRetrievals / reinforcementScore / importance（每次 += effectiveness × 0.02，clamp [0,1]）；邻居 engram 得到 50% 增益（contradicts 除外）。",
  inputSchema: EngramReinforceInputSchema,
  execute(input, ctx) {
    const parsed = validateInput<EngramReinforceToolInput>(
      EngramReinforceInputSchema,
      input,
    );
    if (!ctx.repository.exists(parsed.id)) {
      throw new Error(`Engram not found: ${parsed.id}`);
    }
    const nowIso = new Date().toISOString();
    const direct = recordRetrievalSuccess(
      ctx.repository,
      parsed.id,
      parsed.effectiveness,
      DEFAULT_REINFORCEMENT_CONFIG,
      nowIso,
    );
    const related = reinforceRelated(
      ctx.repository,
      parsed.id,
      direct.importanceDelta,
      DEFAULT_REINFORCEMENT_CONFIG,
      nowIso,
      // P0-9 修复:透传 auditLog + triggeredBy,让邻居联动也写 reinforce audit
      {
        auditLog: ctx.auditLog,
        triggeredBy: parsed.id,
        triggerTool: "engram_reinforce",
        host: ctx.host,
      },
    );
    // M1: 关闭观察窗口并标记为 effective（有效性信号）
    ctx.effectivenessTracker?.closeAsEffective(parsed.id);
    ctx.auditLog?.append({
      actor: "user",
      action: "reinforce",
      engramId: parsed.id,
      host: ctx.host,
      metadata: { effectiveness: parsed.effectiveness, note: parsed.note },
    });
    // 数值字段经 formatScoreField 封装:raw 2 位小数(杀浮点噪声如
    // 0.018000000000000002)+ band(high/medium/low,host adapter 本地化)。
    // 见 fix-1 Task 1.3 / R8 R11 R15 实证。
    const reinforcement = formatScoreField(direct.reinforcementScore);
    const importance = formatScoreField(direct.importance);
    const importanceDelta = formatScoreField(direct.importanceDelta);
    return {
      id: parsed.id,
      retrievalCount: direct.retrievalCount,
      effectiveRetrievals: direct.effectiveRetrievals,
      reinforcementScore: reinforcement.raw,
      reinforcementScoreBand: reinforcement.band,
      importance: importance.raw,
      importanceBand: importance.band,
      importanceDelta: importanceDelta.raw,
      importanceDeltaBand: importanceDelta.band,
      lastEffectiveAt: direct.lastEffectiveAt,
      reinforcedNeighborIds: related.reinforcedNeighborIds,
    };
  },
};

// ============================================================
// engram_report_failure（P1：三信号追踪 - 失败使用 LTD）
// ============================================================

export const engramReportFailureTool: Tool<
  EngramReportFailureToolInput,
  {
    id: string;
    failedUses: number;
    retrievalCount: number;
    importance: number;
    importanceBand: import("../concepts/types.js").ScoreBand;
    importanceDelta: number;
    importanceDeltaBand: import("../concepts/types.js").ScoreBand;
    shouldArchive: boolean;
    shouldForget: boolean;
  }
> = {
  name: "engram_report_failure",
  description:
    "上报一次失败使用（LTD 削弱）。更新 failedUses / retrievalCount / importance（单次 -0.03，超阈值后 ×1.5 升级）。failedUses≥3 建议 archive，≥5 建议 forget。",
  inputSchema: EngramReportFailureInputSchema,
  execute(input, ctx) {
    const parsed = validateInput<EngramReportFailureToolInput>(
      EngramReportFailureInputSchema,
      input,
    );
    if (!ctx.repository.exists(parsed.id)) {
      throw new Error(`Engram not found: ${parsed.id}`);
    }
    const result = recordRetrievalFailure(
      ctx.repository,
      parsed.id,
      DEFAULT_REINFORCEMENT_CONFIG,
    );
    // M1: 关闭观察窗口（标记为 failure,不再触发 inconclusive）
    ctx.effectivenessTracker?.closeAsFailure(parsed.id);
    ctx.auditLog?.append({
      actor: "user",
      action: "report_failure",
      engramId: parsed.id,
      metadata: { reason: parsed.reason, context: parsed.context },
    });
    // 同 engram_reinforce:formatScoreField 杀浮点噪声 + 加 band。
    const importance = formatScoreField(result.importance);
    const importanceDelta = formatScoreField(result.importanceDelta);
    return {
      id: parsed.id,
      failedUses: result.failedUses,
      retrievalCount: result.retrievalCount,
      importance: importance.raw,
      importanceBand: importance.band,
      importanceDelta: importanceDelta.raw,
      importanceDeltaBand: importanceDelta.band,
      shouldArchive: result.shouldArchive,
      shouldForget: result.shouldForget,
    };
  },
};

// ============================================================
// engram_archive / restore / forget（P1：生命周期管理）
// ============================================================

export const engramArchiveTool: Tool<
  EngramArchiveToolInput,
  { id: string; status: "archived"; freshness: string }
> = {
  name: "engram_archive",
  description:
    "归档 engram（移出默认检索，但保留数据可恢复）。检索默认排除 archived，可用 filter 包含。",
  inputSchema: EngramArchiveInputSchema,
  execute(input, ctx) {
    const parsed = validateInput<EngramArchiveToolInput>(
      EngramArchiveInputSchema,
      input,
    );
    if (!ctx.repository.exists(parsed.id)) {
      throw new Error(`Engram not found: ${parsed.id}`);
    }
    ctx.repository.updateLifecycle(parsed.id, "archived", undefined);
    const updated = ctx.repository.readEngram(parsed.id);
    ctx.auditLog?.append({
      actor: "user",
      action: "update_lifecycle",
      engramId: parsed.id,
      metadata: { to: "archived", reason: parsed.reason },
    });
    return {
      id: parsed.id,
      status: "archived",
      freshness: computeFreshness(
        updated.lastEffectiveAt,
        updated.decayHalfLifeDays,
      ),
    };
  },
};

export const engramRestoreTool: Tool<
  EngramRestoreToolInput,
  {
    id: string;
    status: "active";
    freshness: string;
    restoredFromTrash?: boolean;
  }
> = {
  name: "engram_restore",
  description:
    "从 archived/forgotten 恢复为 active，重新进入默认检索。若 engram 已被 sweep 到 .trash/,会先从回收站移回再恢复。",
  inputSchema: EngramRestoreInputSchema,
  execute(input, ctx) {
    const parsed = validateInput<EngramRestoreToolInput>(
      EngramRestoreInputSchema,
      input,
    );

    // 双路径查找：先查 active 区,再查 trash
    let restoredFromTrash = false;
    if (!ctx.repository.exists(parsed.id)) {
      const trashResult = restoreFromTrash(ctx.repository, parsed.id, {
        auditLog: ctx.auditLog,
      });
      if (!trashResult.ok) {
        throw new Error(
          `Engram not found: ${parsed.id} (${trashResult.reason})`,
        );
      }
      restoredFromTrash = true;
    }

    ctx.repository.updateLifecycle(parsed.id, "active", undefined);
    const updated = ctx.repository.readEngram(parsed.id);
    ctx.auditLog?.append({
      actor: "user",
      action: "restore",
      engramId: parsed.id,
      metadata: { reason: parsed.reason },
    });
    return {
      id: parsed.id,
      status: "active",
      freshness: computeFreshness(
        updated.lastEffectiveAt,
        updated.decayHalfLifeDays,
      ),
      ...(restoredFromTrash ? { restoredFromTrash: true } : {}),
    };
  },
};

export const engramForgetTool: Tool<
  EngramForgetToolInput,
  { id: string; status: "forgotten"; freshness: "forgotten" }
> = {
  name: "engram_forget",
  description:
    "主动遗忘 engram（RIF 检索诱导遗忘）。文件保留（Git 可追溯）但移出所有默认检索。需要 reason。",
  inputSchema: EngramForgetInputSchema,
  execute(input, ctx) {
    const parsed = validateInput<EngramForgetToolInput>(
      EngramForgetInputSchema,
      input,
    );
    if (!ctx.repository.exists(parsed.id)) {
      throw new Error(`Engram not found: ${parsed.id}`);
    }
    ctx.repository.updateLifecycle(parsed.id, "forgotten", "forgotten");
    ctx.auditLog?.append({
      actor: "user",
      action: "forget",
      engramId: parsed.id,
      metadata: { reason: parsed.reason },
    });
    return { id: parsed.id, status: "forgotten", freshness: "forgotten" };
  },
};

// ============================================================
// engram_recompute_importance（P2：多维重要性）
// ============================================================

export const engramRecomputeImportanceTool: Tool<
  EngramRecomputeImportanceToolInput,
  {
    id: string;
    previous?: {
      personal: number;
      team: number;
      project: number;
      network: number;
      temporal: number;
      composite: number;
    };
    next: {
      personal: number;
      team: number;
      project: number;
      network: number;
      temporal: number;
      composite: number;
    };
    persisted: boolean;
  }
> = {
  name: "engram_recompute_importance",
  description:
    "重新计算 engram 的多维重要性（personal/team/project/network/temporal）。network 和 temporal 由系统派生（incomingSynapseCount + 艾宾浩斯衰退），其余可通过 overrides 手动设置。结果 composite 写回 engram.importance。",
  inputSchema: EngramRecomputeImportanceInputSchema,
  execute(input, ctx) {
    const parsed = validateInput<EngramRecomputeImportanceToolInput>(
      EngramRecomputeImportanceInputSchema,
      input,
    );
    const result = recomputeImportance(ctx.repository, parsed.id, {
      overrides: parsed.overrides,
      persist: parsed.persist,
      updatedBy: parsed.updatedBy,
    });
    return {
      id: result.id,
      previous: result.previous,
      next: result.next,
      persisted: result.persisted,
    };
  },
};

// ============================================================
// contradiction_resolve（P2：spec §3.9 人工裁决）
// ============================================================

export const contradictionResolveTool: Tool<
  ContradictionResolveToolInput,
  { fromId: string; synapseId: string; status: string; resolved: true }
> = {
  name: "contradiction_resolve",
  description:
    "人工裁决一个 contradicts synapse（spec §3.9 阶段 2 人工介入）。必须给 verdict + rationale + resolvedBy。系统会自动把 synapse.resolutionState 标记为 resolved 并记录到 evidence 数组。",
  inputSchema: ContradictionResolveInputSchema,
  execute(input, ctx) {
    const parsed = validateInput<ContradictionResolveToolInput>(
      ContradictionResolveInputSchema,
      input,
    );
    const result = manualResolveContradiction(
      ctx.repository,
      {
        fromId: parsed.fromId,
        synapseId: parsed.synapseId,
        verdict: parsed.verdict,
        rationale: parsed.rationale,
        resolvedBy: parsed.resolvedBy,
      },
      // P0-5 修复:透传 auditLog + host,让 merge_resolved audit 写入
      { auditLog: ctx.auditLog, host: ctx.host },
    );
    return {
      fromId: parsed.fromId,
      synapseId: parsed.synapseId,
      status: result.finalStatus,
      resolved: true,
    };
  },
};

// ============================================================
// close_learning_loop（P2：闭合学习回路，spec §5.3.5）
// ============================================================

export const closeLearningLoopTool: Tool<
  CloseLearningLoopToolInput,
  {
    engramId: string;
    outcome: string;
    importance: number;
    importanceDelta: number;
    hebbianTriggered: boolean;
    provenanceTriggered: boolean;
    shouldArchive: boolean;
    shouldForget: boolean;
  }
> = {
  name: "close_learning_loop",
  description:
    "闭合学习回路（多巴胺闭环）：把使用结果反馈到系统。success/partial → LTP 强化 + Hebbian 邻居强化；failure → LTD 削弱 + 触发降级阈值检查。同步触发 Provenance 奖惩回路（如已配置）。",
  inputSchema: CloseLearningLoopInputSchema,
  execute(input, ctx) {
    const parsed = validateInput<CloseLearningLoopToolInput>(
      CloseLearningLoopInputSchema,
      input,
    );
    const result = closeLearningLoop(
      ctx.repository,
      {
        engramId: parsed.engramId,
        outcome: parsed.outcome,
        effectiveness: parsed.effectiveness,
        reason: parsed.reason,
        reportedBy: parsed.reportedBy,
      },
      // P0-1 修复:透传 auditLog + host,让 learning_loop_* audit 写入
      // P0-9 修复:auditLog 同时透传给 reinforceRelated,邻居联动也写 audit
      { auditLog: ctx.auditLog, host: ctx.host },
    );
    return {
      engramId: result.engramId,
      outcome: result.outcome,
      importance: result.importance,
      importanceDelta: result.importanceDelta,
      hebbianTriggered: result.hebbianReinforcement.triggered,
      provenanceTriggered: result.provenanceUpdate.triggered,
      shouldArchive: result.shouldArchive,
      shouldForget: result.shouldForget,
    };
  },
};

// ============================================================
// upgrade_verification（P3 4.5.3：验证状态升级）
// ============================================================

export const upgradeVerificationTool: Tool<
  UpgradeVerificationToolInput,
  {
    engramId: string;
    previousStatus: string | undefined;
    newStatus: string;
    eligible: boolean;
    applied: boolean;
    evidenceAppended: boolean;
    synapseIds: readonly string[];
    reason: string;
    checks: ReadonlyArray<{
      key: string;
      required: string;
      actual: string;
      passed: boolean;
    }>;
  }
> = {
  name: "upgrade_verification",
  description:
    "升级 engram 的验证状态（unverified → plausible → probable → verified → refuted）。必须给出证据说明 + 验证人。系统会校验状态机（不允许跳级）+ 三维证据条件（evidenceCount + 跨情境 domainTags + 时间稳定天数）。force=true 可跳过条件检查但保留状态机校验（人工裁决场景）。",
  inputSchema: UpgradeVerificationInputSchema,
  execute(input, ctx) {
    const parsed = validateInput<UpgradeVerificationToolInput>(
      UpgradeVerificationInputSchema,
      input,
    );
    const result = upgradeVerification(
      ctx.repository,
      parsed.engramId,
      parsed.newStatus,
      {
        description: parsed.evidenceDescription,
        verifiedBy: parsed.verifiedBy,
        confidence: parsed.confidence,
        domainTags: parsed.evidenceDomainTags,
      },
      {
        force: parsed.force,
      },
    );
    return {
      engramId: result.engramId,
      previousStatus: result.previousStatus,
      newStatus: result.newStatus,
      eligible: result.eligible,
      applied: result.applied,
      evidenceAppended: result.evidenceAppended,
      synapseIds: result.synapseIds,
      reason: result.reason,
      checks: result.checks,
    };
  },
};

// ============================================================
// get_evolution_lineage（P3 4.6.3：进化血统追溯）
// ============================================================

export const getEvolutionLineageTool: Tool<
  GetEvolutionLineageToolInput,
  {
    rootId: string;
    nodes: ReadonlyArray<{
      engramId: string;
      title: string;
      kind: string;
      depth: number;
      relation: string;
      viaSynapseId?: string;
      createdAt: string;
      createdBy: string;
    }>;
    edges: ReadonlyArray<{
      from: string;
      to: string;
      kind: string;
      synapseId: string;
      direction: string;
    }>;
    maxDepth: number;
    totalNodes: number;
    origins: readonly string[];
    terminals: readonly string[];
    hasCycle: boolean;
  }
> = {
  name: "get_evolution_lineage",
  description:
    "追溯 engram 的进化血统（spec §12.7 场景 6）。沿 derives_from / consolidates / supersedes synapse 双向追溯：ancestors = 来源（observation 等），descendants = 演化结果（pattern/procedure 等）。返回 DAG 节点和边，可用于 Graph View 可视化。spec §4.6 验收：从 Skill 可反向追溯到原 observation 的完整链路。",
  inputSchema: GetEvolutionLineageInputSchema,
  execute(input, ctx) {
    const parsed = validateInput<GetEvolutionLineageToolInput>(
      GetEvolutionLineageInputSchema,
      input,
    );
    const lineage = getEvolutionLineage(ctx.repository, parsed.engramId, {
      direction: parsed.direction,
      maxDepth: parsed.maxDepth,
      kinds: parsed.kinds,
    });
    return {
      rootId: lineage.rootId,
      nodes: lineage.nodes,
      edges: lineage.edges,
      maxDepth: lineage.maxDepth,
      totalNodes: lineage.totalNodes,
      origins: lineage.origins,
      terminals: lineage.terminals,
      hasCycle: lineage.hasCycle,
    };
  },
};

export const ALL_ENGRAM_TOOLS: readonly Tool[] = [
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
  engramRecomputeImportanceTool,
  contradictionResolveTool,
  closeLearningLoopTool,
  upgradeVerificationTool,
  getEvolutionLineageTool,
];
