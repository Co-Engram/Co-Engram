/**
 * Proposal 工具集（M1：候选提示机制）
 *
 * 3 个工具：
 *   - engram_list_proposals   列出 pending/全部提案
 *   - engram_accept_proposal  接受提案 → 创建 engram
 *   - engram_dismiss_proposal 拒绝提案（带冷却期）
 *
 * Proposal 有两种来源(由 `source` 字段区分):
 *   - `conversation`：对话流聚类(ProposalEngine.observe)生成;payload=undefined,
 *     accept 时必须显式传 title/content/domainTags
 *   - `auto-memory`：Claude Code auto-memory 文件(AutoMemorySyncEngine)生成;
 *     payload 携带完整 engram 字段,accept 时可省略 title/content/domainTags/kind
 *
 * 详见 spec §2.2（候选提示机制）。
 *
 * @module @co-engram/core/tools
 */

import type { Proposal, ProposalSource } from "../observability/proposal-engine.js";
import type { Tool, ToolContext } from "./tool.js";
import { validateInput } from "./tool.js";
import {
  EngramListProposalsInputSchema,
  EngramAcceptProposalInputSchema,
  EngramDismissProposalInputSchema,
  type EngramListProposalsToolInput,
  type EngramAcceptProposalToolInput,
  type EngramDismissProposalToolInput,
} from "./schemas.js";

// ============================================================
// engram_list_proposals
// ============================================================

export const engramListProposalsTool: Tool<
  EngramListProposalsToolInput,
  {
    proposals: ReadonlyArray<{
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
      // auto-memory 来源时携带的预填字段(便于 LLM/用户判断是否直接 accept)
      proposedTitle?: string;
      proposedSummary?: string;
      proposedKind?: string;
      proposedDomainTags?: readonly string[];
      proposedContextTags?: readonly string[];
      proposedImportance?: number;
      proposedVisibility?: string;
      proposedEncodingContext?: string;
      proposedSourceType?: string;
      proposedDecayHalfLifeDays?: number | null;
      proposedCreatedBy?: string;
      // conversation 来源时携带的建议标题(LLM 具象化的草稿)
      suggestedTitle?: string;
      necessityReason?: string;
      necessityRule?: string;
    }>;
    total: number;
  }
> = {
  name: "engram_list_proposals",
  description:
    "列出主题候选提案。当某主题在对话中被多次提及但无匹配 engram 时,系统会生成 pending 提案等待确认。默认只返回 pending;传 includeAll=true 可查看历史 accepted/dismissed。每条提案带 source 字段(conversation=对话流聚类 / auto-memory=Claude Code auto-memory 文件);auto-memory 来源还带 proposedTitle/proposedContent/proposedDomainTags 等预填字段,可直接 accept 无需重复填表。",
  inputSchema: EngramListProposalsInputSchema,
  execute(input, ctx) {
    const parsed = validateInput<EngramListProposalsToolInput>(
      EngramListProposalsInputSchema,
      input,
    );
    if (!ctx.proposalEngine) {
      throw new Error("ProposalEngine not available in ToolContext");
    }
    const all = parsed.includeAll
      ? ctx.proposalEngine.listAll()
      : ctx.proposalEngine.listPending();
    return {
      proposals: all.map((p) => {
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
          proposedDecayHalfLifeDays?: number | null;
          proposedCreatedBy?: string;
          suggestedTitle?: string;
          necessityReason?: string;
          necessityRule?: string;
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
          if (payload.decayHalfLifeDays !== undefined)
            base.proposedDecayHalfLifeDays = payload.decayHalfLifeDays;
          if (payload.createdBy) base.proposedCreatedBy = payload.createdBy;
        }
        return base;
      }),
      total: all.length,
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
      throw new Error("ProposalEngine not available in ToolContext");
    }
    // 与 engram_create 完全相同的 createdBy 解析链:
    // 显式传值 → ctx.defaultCreatedBy(MCP env / OpenClaw plugin config / git 身份) → 'unknown'
    // 修复前 Zod schema `.default('proposal-engine')` 把这里写死,绕过了整条链。
    const createdBy = parsed.createdBy ?? ctx.defaultCreatedBy ?? "unknown";
    const engramId = ctx.proposalEngine.accept(parsed.entityId, {
      ...(parsed.title !== undefined ? { title: parsed.title } : {}),
      ...(parsed.content !== undefined ? { content: parsed.content } : {}),
      ...(parsed.domainTags !== undefined ? { domainTags: parsed.domainTags } : {}),
      ...(parsed.kind !== undefined ? { kind: parsed.kind } : {}),
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
    "拒绝一个候选提案。默认 30 天内不再提示;可通过 dismissDays 自定义冷却期。可填 reason 便于元学习。",
  inputSchema: EngramDismissProposalInputSchema,
  execute(input, ctx) {
    const parsed = validateInput<EngramDismissProposalToolInput>(
      EngramDismissProposalInputSchema,
      input,
    );
    if (!ctx.proposalEngine) {
      throw new Error("ProposalEngine not available in ToolContext");
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

export const ALL_PROPOSAL_TOOLS: readonly Tool[] = [
  engramListProposalsTool,
  engramAcceptProposalTool,
  engramDismissProposalTool,
];
