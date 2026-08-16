/**
 * Proposal 工具集（M1：候选提示机制 + AI-8 batch 扩展）
 *
 * 5 个工具：
 *   - engram_list_proposals              列出 pending/全部提案
 *   - engram_accept_proposal             接受单个提案 → 创建 engram
 *   - engram_dismiss_proposal            拒绝单个提案(带冷却期)
 *   - engram_accept_proposals_by_source  (AI-8) 按 source 批量 accept
 *   - engram_dismiss_proposals_by_filter (AI-8) 按 source/domainTags/时间窗批量 dismiss
 *
 * Proposal 有三种来源(由 `source` 字段区分):
 *   - `conversation`：对话流聚类(ProposalEngine.observe)生成;payload=undefined,
 *     accept 时必须显式传 title/content/domainTags
 *   - `auto-memory`：Claude Code auto-memory 文件(AutoMemorySyncEngine)生成;
 *     payload 携带完整 engram 字段,accept 时可省略 title/content/domainTags/kind
 *   - `external-markdown`:dataRoot 下未跟踪 .md 文件(watcher 扫描);
 *     payload 携带 frontmatter 字段,与 auto-memory 同语义
 *
 * 详见 spec §2.2（候选提示机制）+ AI-8 设计。
 *
 * @module @co-engram/core/tools
 */

import type { z } from "zod";
import type { Proposal, ProposalSource } from "../observability/proposal-engine.js";
import type { Tool, ToolContext } from "./tool.js";
import {
  validateInput,
  validationError,
  configError,
} from "./tool.js";
import {
  EngramListProposalsInputSchema,
  EngramAcceptProposalInputSchema,
  EngramDismissProposalInputSchema,
  EngramAcceptProposalsBySourceInputSchema,
  EngramDismissProposalsByFilterInputSchema,
  type EngramListProposalsToolInput,
  type EngramAcceptProposalToolInput,
  type EngramDismissProposalToolInput,
  type EngramListProposalsToolResult,
} from "./schemas.js";

// ============================================================
// engram_list_proposals — cursor 分页 helper(Task 3.5)
// ============================================================

/**
 * Proposal sort key:createdAt DESC + entityId ASC。
 *
 * 选择 createdAt 而非 lastSeenAt:createdAt 是不可变的(提案首次创建时间),
 * 适合做稳定分页;lastSeenAt 在 observe 时被更新,会导致 cursor 漂移。
 * entityId ASC 作为 tiebreaker 保证完全稳定。
 */
type ProposalSortKey = readonly [createdAt: string, entityId: string];

function proposalSortKey(p: Proposal): ProposalSortKey {
  return [p.createdAt, p.entityId];
}

function encodeProposalCursor(key: ProposalSortKey): string {
  return Buffer.from(JSON.stringify(key), "utf8").toString("base64url");
}

function decodeProposalCursor(cursor: string): ProposalSortKey {
  let json: string;
  try {
    json = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw validationError("invalid proposal cursor: base64 decode failed", {
      suggestion:
        "Cursor must be a base64url-encoded JSON array. Use the nextCursor value returned by the previous engram_list_proposals call.",
      resourceId: "cursor",
    });
  }
  let arr: unknown;
  try {
    arr = JSON.parse(json);
  } catch {
    throw validationError("invalid proposal cursor: JSON parse failed", {
      suggestion:
        "Cursor payload is not valid JSON. Use the nextCursor value returned by the previous engram_list_proposals call.",
      resourceId: "cursor",
    });
  }
  if (
    !Array.isArray(arr) ||
    arr.length !== 2 ||
    typeof arr[0] !== "string" ||
    typeof arr[1] !== "string"
  ) {
    throw validationError(
      "invalid proposal cursor: shape mismatch (expected [createdAt, entityId])",
      {
        suggestion:
          "Cursor payload shape is invalid. Use the nextCursor value returned by the previous engram_list_proposals call.",
        resourceId: "cursor",
      },
    );
  }
  return [arr[0] as string, arr[1] as string];
}

/**
 * 比较 proposal sort key。
 *
 * 返回 -1 表示 a 排在 b 前面,1 表示 a 排在 b 后面,0 表示相等。
 * 顺序:createdAt 大→小(最新优先);同 createdAt 时 entityId 字典序升序(稳定)。
 *
 * 用于 cursor 分页:`compareProposalKey(item, cursor) > 0` 的项是 cursor 之后
 * 的项(应包含在下一页);`<= 0` 的项是 cursor 之前或等于的(跳过)。
 */
function compareProposalKey(a: ProposalSortKey, b: ProposalSortKey): number {
  if (a[0] !== b[0]) return a[0] > b[0] ? -1 : 1;
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
  return 0;
}

// ============================================================
// engram_list_proposals
// ============================================================

export const engramListProposalsTool: Tool<
  EngramListProposalsToolInput,
  EngramListProposalsToolResult
> = {
  name: "engram_list_proposals",
  description:
    "列出主题候选提案(cursor 分页)。当某主题在对话中被多次提及但无匹配 engram 时,系统会生成 pending 提案等待确认。默认只返回 pending;传 includeAll=true 可查看历史 accepted/dismissed。每条提案带 source 字段(conversation=对话流聚类 / auto-memory=Claude Code auto-memory 文件);auto-memory 来源还带 proposedTitle/proposedContent/proposedDomainTags 等预填字段,可直接 accept 无需重复填表。limit 必填(1-500),翻页把 nextCursor 原样回传到下一页的 cursor 参数。",
  inputSchema: EngramListProposalsInputSchema,
  execute(input, ctx) {
    const parsed = validateInput<EngramListProposalsToolInput>(
      EngramListProposalsInputSchema,
      input,
    );
    if (!ctx.proposalEngine) {
      throw configError(
        "ctx.proposalEngine",
        "ProposalEngine is not injected into ToolContext — host adapter must wire it during bootstrap.",
      );
    }
    const all = parsed.includeAll
      ? ctx.proposalEngine.listAll()
      : ctx.proposalEngine.listPending();
    // 稳定排序:createdAt DESC + entityId ASC
    const sorted = [...all].sort((a, b) =>
      compareProposalKey(proposalSortKey(a), proposalSortKey(b)),
    );
    // cursor 过滤:跳过 cursor 之前/等于的项
    let startIdx = 0;
    if (parsed.cursor) {
      const ck = decodeProposalCursor(parsed.cursor);
      startIdx = sorted.findIndex(
        (p) => compareProposalKey(proposalSortKey(p), ck) > 0,
      );
      if (startIdx === -1) startIdx = sorted.length;
    }
    const slice = sorted.slice(startIdx, startIdx + parsed.limit);
    const hasMore = startIdx + parsed.limit < sorted.length && slice.length > 0;
    const nextCursor =
      hasMore && slice.length > 0
        ? encodeProposalCursor(proposalSortKey(slice[slice.length - 1]!))
        : null;
    return {
      items: slice.map((p) => {
        const base: {
          entityId: string;
          occurrences: number;
          sampleQuotes: readonly string[];
          centroidExcerpt: string;
          firstSeenAt: string;
          lastSeenAt: string;
          createdAt: string;
          status: Proposal["status"];
          source: ProposalSource;
          slug?: string;
          proposedTitle?: string;
          proposedSummary?: string;
          proposedKind?: string;
          proposedDomainTags?: readonly string[];
          proposedContextTags?: readonly string[];
          proposedImportance?: number;
          proposedVisibility?: string;
          proposedEncodingContext?: string;
          proposedSourceType?: string;
          proposedCreatedBy?: string;
          suggestedTitle?: string;
          necessityReason?: string;
          necessityRule?: string;
          acceptedEngramId?: string;
          sourcePath?: string;
          synapseOp?: "add" | "delete" | "retype";
          synapseFrom?: string;
          synapseTo?: string;
          synapseKind?: string;
          synapseOldKind?: string;
          synapseId?: string;
          synapseConfidence?: number;
          synapseReason?: string;
          synapseFromTitle?: string;
          synapseToTitle?: string;
          // rem-tag-refresh 投影
          tagEngramId?: string;
          tagOldTags?: readonly string[];
          tagNewTags?: readonly string[];
          tagReason?: string;
          tagDrift?: number;
          // rem-insight 投影
          insightMode?: string;
          insightType?: string;
          criticScore?: number;
          criticRationale?: string;
          incubationId?: string;
          insightRound?: number;
        } = {
          entityId: p.entityId,
          occurrences: p.occurrences,
          sampleQuotes: p.sampleQuotes,
          centroidExcerpt: p.centroidExcerpt,
          firstSeenAt: p.firstSeenAt,
          lastSeenAt: p.lastSeenAt,
          createdAt: p.createdAt,
          status: p.status,
          source: p.source ?? "conversation",
        };
        if (p.slug) base.slug = p.slug;
        if (p.suggestedTitle) base.suggestedTitle = p.suggestedTitle;
        if (p.necessityReason) base.necessityReason = p.necessityReason;
        if (p.necessityRule) base.necessityRule = p.necessityRule;
        if (p.acceptedEngramId) base.acceptedEngramId = p.acceptedEngramId;
        if (p.sourcePath) base.sourcePath = p.sourcePath;
        // payload 投影(仅 auto-memory 来源时填)
        const payload = p.payload;
        if (payload) {
          base.proposedTitle = payload.title;
          if (payload.summary) base.proposedSummary = payload.summary;
          base.proposedKind = payload.kind;
          base.proposedDomainTags = payload.domainTags;
          if (payload.contextTags) base.proposedContextTags = payload.contextTags;
          if (payload.importance !== undefined)
            base.proposedImportance = payload.importance;
          if (payload.visibility) base.proposedVisibility = payload.visibility;
          if (payload.encodingContext)
            base.proposedEncodingContext = payload.encodingContext;
          if (payload.sourceType) base.proposedSourceType = payload.sourceType;
          if (payload.createdBy) base.proposedCreatedBy = payload.createdBy;
          // rem-synapse 投影
          if (payload.synapseOp) base.synapseOp = payload.synapseOp;
          if (payload.synapseFrom) base.synapseFrom = payload.synapseFrom;
          if (payload.synapseTo) base.synapseTo = payload.synapseTo;
          if (payload.synapseKind) base.synapseKind = payload.synapseKind;
          if (payload.synapseOldKind) base.synapseOldKind = payload.synapseOldKind;
          if (payload.synapseId) base.synapseId = payload.synapseId;
          if (payload.remSynapseConfidence !== undefined)
            base.synapseConfidence = payload.remSynapseConfidence;
          if (payload.remSynapseReason) base.synapseReason = payload.remSynapseReason;
          if (payload.synapseFromTitle) base.synapseFromTitle = payload.synapseFromTitle;
          if (payload.synapseToTitle) base.synapseToTitle = payload.synapseToTitle;
          // rem-tag-refresh 投影
          if (payload.tagEngramId) base.tagEngramId = payload.tagEngramId;
          if (payload.tagOldTags) base.tagOldTags = payload.tagOldTags;
          if (payload.tagNewTags) base.tagNewTags = payload.tagNewTags;
          if (payload.tagReason) base.tagReason = payload.tagReason;
          if (payload.tagDrift !== undefined) base.tagDrift = payload.tagDrift;
          // rem-insight 投影
          if (payload.insightMode) base.insightMode = payload.insightMode;
          if (payload.insightType) base.insightType = payload.insightType;
          if (payload.criticScore !== undefined)
            base.criticScore = payload.criticScore;
          if (payload.criticRationale)
            base.criticRationale = payload.criticRationale;
          if (payload.incubationId)
            base.incubationId = payload.incubationId;
          if (payload.insightRound !== undefined)
            base.insightRound = payload.insightRound;
        }
        return base;
      }),
      nextCursor,
    };
  },
};

// ============================================================
// engram_accept_proposal
// ============================================================

export const engramAcceptProposalTool: Tool<
  EngramAcceptProposalToolInput,
  { engramId: string; entityId: string; status: "accepted" }
> = {
  name: "engram_accept_proposal",
  description:
    "接受一个候选提案 → 系统自动创建对应 engram,并把提案标记为 accepted。后续相同主题不会再产生重复提案。auto-memory 来源(source='auto-memory')的提案自带 payload(title/content/domainTags/kind 等),可直接 accept 省略这些字段;conversation 来源必须显式传 title/content/domainTags。",
  inputSchema: EngramAcceptProposalInputSchema,
  execute(input, ctx) {
    const parsed = validateInput<EngramAcceptProposalToolInput>(
      EngramAcceptProposalInputSchema,
      input,
    );
    if (!ctx.proposalEngine) {
      throw configError(
        "ctx.proposalEngine",
        "ProposalEngine is not injected into ToolContext — host adapter must wire it during bootstrap.",
      );
    }
    // createdBy 完全由系统决定(2026-07 修复):忽略 parsed.createdBy 和
    // proposal.payload.createdBy。前者是 LLM 自填(常误填 host 标识如 "claude-code"),
    // 后者是 auto-memory / external-markdown 文件 frontmatter 的残留(同样是 host 标识)。
    // 权威来源是 ctx.defaultCreatedBy(host adapter 从 git config user.name > user.email 解析)。
    // LLM 想表达自动生成情境应走 encodingContext(accept 不暴露此字段,
    // 由 proposal.payload.encodingContext 在 proposal-engine.accept 内部继承)。
    void parsed.createdBy; // 向后兼容:schema 仍接受此字段,但值不生效
    const createdBy =
      ctx.resolveCreatedBy?.() ?? ctx.defaultCreatedBy ?? "unknown";
    const engramId = ctx.proposalEngine.accept(parsed.entityId, {
      ...(parsed.title !== undefined ? { title: parsed.title } : {}),
      ...(parsed.content !== undefined ? { content: parsed.content } : {}),
      ...(parsed.domainTags !== undefined ? { domainTags: parsed.domainTags } : {}),
      ...(parsed.kind !== undefined ? { kind: parsed.kind } : {}),
      ...(parsed.visibility !== undefined ? { visibility: parsed.visibility } : {}),
      createdBy,
    });
    return { engramId, entityId: parsed.entityId, status: "accepted" };
  },
};

// ============================================================
// engram_dismiss_proposal
// ============================================================

export const engramDismissProposalTool: Tool<
  EngramDismissProposalToolInput,
  { entityId: string; status: "dismissed"; dismissedUntil: string }
> = {
  name: "engram_dismiss_proposal",
  description:
    "拒绝一个候选提案。默认永久不再提示;显式传 dismissDays > 0 时 N 天后可被新事件重新激活。审计日志始终保留。",
  inputSchema: EngramDismissProposalInputSchema,
  execute(input, ctx) {
    const parsed = validateInput<EngramDismissProposalToolInput>(
      EngramDismissProposalInputSchema,
      input,
    );
    if (!ctx.proposalEngine) {
      throw configError(
        "ctx.proposalEngine",
        "ProposalEngine is not injected into ToolContext — host adapter must wire it during bootstrap.",
      );
    }
    ctx.proposalEngine.dismiss(
      parsed.entityId,
      parsed.reason,
      parsed.dismissDays,
    );
    const all = ctx.proposalEngine.listAll();
    const target = all.find((p) => p.entityId === parsed.entityId);
    const dismissedUntil = target?.dismissedUntil ?? new Date().toISOString();
    return {
      entityId: parsed.entityId,
      status: "dismissed",
      dismissedUntil,
    };
  },
};

// ============================================================
// engram_accept_proposals_by_source (AI-8)
// ============================================================

export const engramAcceptProposalsBySourceTool: Tool<
  z.infer<typeof EngramAcceptProposalsBySourceInputSchema>,
  {
    readonly source: "auto-memory" | "external-markdown" | "skill";
    readonly acceptedCount: number;
    readonly dismissedCount: number;
    readonly remainingCount: number;
    readonly engramIds: readonly string[];
    readonly failures: ReadonlyArray<{
      readonly entityId: string;
      readonly reason: string;
    }>;
  }
> = {
  name: "engram_accept_proposals_by_source",
  description:
    "AI-8 批量接受候选提案(按 source)。仅支持 source='auto-memory'、'external-markdown' 或 'skill' —— 这三种 proposal 自带 payload,无需 LLM 填表。conversation 来源必须用单条 engram_accept_proposal(LLM 需要为每条填 title/content)。limit 默认 200(最大 500),超过的 pending 留到下次。单条 accept 失败不阻塞 batch,记录到 failures 数组。",
  inputSchema: EngramAcceptProposalsBySourceInputSchema,
  execute(input, ctx) {
    const parsed = validateInput<
      z.infer<typeof EngramAcceptProposalsBySourceInputSchema>
    >(EngramAcceptProposalsBySourceInputSchema, input);
    if (!ctx.proposalEngine) {
      throw configError(
        "ctx.proposalEngine",
        "ProposalEngine is not injected into ToolContext — host adapter must wire it during bootstrap.",
      );
    }
    // createdBy 完全由系统决定(2026-07 修复):忽略 parsed.createdBy,
    // 走 ctx.defaultCreatedBy(host adapter 从 git config 解析)。
    void parsed.createdBy; // 向后兼容:schema 仍接受此字段,但值不生效
    const createdBy =
      ctx.resolveCreatedBy?.() ?? ctx.defaultCreatedBy ?? "unknown";
    const result = ctx.proposalEngine.acceptBatch(
      {
        source: parsed.source,
        limit: parsed.limit,
      },
      {
        createdBy,
        ...(parsed.visibility !== undefined
          ? { visibility: parsed.visibility }
          : {}),
      },
    );
    // batch 后查 remaining pending(所有 source,不限当前 filter)
    const remainingCount = ctx.proposalEngine.listPending().length;
    return {
      source: parsed.source,
      acceptedCount: result.acceptedIds.length,
      // Plan 里要求返回 dismissedCount;但 accept 工具语义上不 dismiss。
      // 这里固定返回 0,保持返回 shape 与 dismiss_by_filter 对称。
      dismissedCount: 0,
      remainingCount,
      engramIds: result.engramIds,
      failures: result.failures,
    };
  },
};

// ============================================================
// engram_dismiss_proposals_by_filter (AI-8)
// ============================================================

export const engramDismissProposalsByFilterTool: Tool<
  z.infer<typeof EngramDismissProposalsByFilterInputSchema>,
  {
    readonly dismissedCount: number;
    readonly acceptedCount: number;
    readonly remainingCount: number;
    readonly dismissedIds: readonly string[];
    readonly failures: ReadonlyArray<{
      readonly entityId: string;
      readonly reason: string;
    }>;
  }
> = {
  name: "engram_dismiss_proposals_by_filter",
  description:
    "AI-8 批量拒绝候选提案(按 source/domainTags/时间窗组合 filter)。典型用法:`{source:'conversation', reason:'load-test 噪声'}` 一次清空对话流聚类的 load-test 污染;或 `{source:'rem-synapse', reason:'REM 突触占位提案积压清理', dismissDays:30}` 清理 REM 突触提案积压(30 天后高值对可被新规则重新 propose);或 `{domainTags:['load-test'], reason:'clear load-test'}` 按 tag 清空。默认永久驳回(dismissDays 不传或 0);显式传 dismissDays > 0 时 N 天后可被新事件重新激活。limit 默认 1000(最大 5000)。reason 必填(审计留存)。",
  inputSchema: EngramDismissProposalsByFilterInputSchema,
  execute(input, ctx) {
    const parsed = validateInput<
      z.infer<typeof EngramDismissProposalsByFilterInputSchema>
    >(EngramDismissProposalsByFilterInputSchema, input);
    if (!ctx.proposalEngine) {
      throw configError(
        "ctx.proposalEngine",
        "ProposalEngine is not injected into ToolContext — host adapter must wire it during bootstrap.",
      );
    }
    const result = ctx.proposalEngine.dismissBatch(
      {
        ...(parsed.source !== undefined ? { source: parsed.source } : {}),
        ...(parsed.domainTags !== undefined
          ? { domainTags: parsed.domainTags }
          : {}),
        ...(parsed.createdBefore !== undefined
          ? { createdBefore: parsed.createdBefore }
          : {}),
        ...(parsed.createdAfter !== undefined
          ? { createdAfter: parsed.createdAfter }
          : {}),
        limit: parsed.limit,
      },
      parsed.reason,
      parsed.dismissDays,
    );
    const remainingCount = ctx.proposalEngine.listPending().length;
    return {
      dismissedCount: result.dismissedIds.length,
      // Plan 里要求返回 acceptedCount;但 dismiss 工具语义上不 accept。
      // 这里固定返回 0,保持返回 shape 与 accept_by_source 对称。
      acceptedCount: 0,
      remainingCount,
      dismissedIds: result.dismissedIds,
      failures: result.failures,
    };
  },
};

export const ALL_PROPOSAL_TOOLS: readonly Tool[] = [
  engramListProposalsTool,
  engramAcceptProposalTool,
  engramDismissProposalTool,
  engramAcceptProposalsBySourceTool,
  engramDismissProposalsByFilterTool,
];
