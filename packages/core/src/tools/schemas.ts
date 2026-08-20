/**
 * 工具输入 Zod schemas
 *
 * 所有 Self-Editing Tool 的入参都用 Zod 校验，
 * 用于 host-agnostic 的 boundary validation。
 *
 * @module @co-engram/core/tools
 */

import { z } from "zod";
import { normalizeUlid } from "./normalization.js";
import type { ProposalSource } from "../observability/proposal-engine.js";

/**
 * ULID canonical 字段(P1-78 修复:ULID 大小写敏感未规范化)
 *
 * ULID 规范本身大小写不敏感,但 co-engram 创建时返回大写;工具入口若用户/LLM
 * 传小写(某些 markdown 渲染器、URL encoder、shell 变量展开会转小写),会
 * 返回 INVALID_ID。统一在 schema 层 transform 解决所有工具的 id/synapseId/
 * fromId/toId 字段。
 */
const ulidField = z
  .string()
  .min(1)
  .transform((s) => normalizeUlid(s));

// ============================================================
// 基础枚举
// ============================================================

export const EngramKindSchema = z.enum([
  "observation",
  "fact",
  "pattern",
  "procedure",
  "hypothesis",
]);

export const EngramStatusSchema = z.enum([
  "active",
  "draft",
  "frozen",
  "forgotten",
]);

export const EngramFreshnessSchema = z.enum([
  "fresh",
  "aging",
  "stale",
  "forgotten",
]);

export const EngramSourceTypeSchema = z.enum([
  "firsthand",
  "secondhand",
  "inferred",
]);

export const EngramVisibilitySchema = z.enum([
  "public",
  "team",
  "private",
  "restricted",
]);

export const DisclosureTierSchema = z.enum([
  "catalog",
  "digest",
  "content",
  "meta",
  "synapses",
]);

export const SynapseKindSchema = z.enum([
  "extends",
  "part_of",
  "similar_to",
  "depends_on",
  "causes",
  "follows",
  "derives_from",
  "contradicts",
  "exemplifies",
  "supersedes",
  "consolidates",
  "contextualizes",
]);

// ============================================================
// engram_create
// ============================================================

export const EngramCreateInputSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(1),
  kind: EngramKindSchema,
  kinds: z.array(EngramKindSchema).optional(),
  summary: z.string().max(300).optional(),
  domainTags: z
    .array(z.string().min(1))
    .min(1)
    .refine((tags) => tags.every((t) => !/^[.\u2026\u00B7]+$/.test(t.trim())), {
      message:
        'domainTags 不接受纯点号占位(如 "...")—— 请提供真实领域标签或留空让系统分类',
    }),
  contextTags: z.array(z.string().min(1)).optional(),
  encodingContext: z.string().optional(),
  importance: z.coerce.number().min(0).max(1).optional(),
  confidence: z.coerce.number().min(0).max(1).optional(),
  sourceType: EngramSourceTypeSchema.optional(),
  visibility: EngramVisibilitySchema.optional(),
  /**
   * @deprecated 已废弃(2026-07 修复)。createdBy 现由系统从 git config
   * (user.name > user.email)解析,LLM 传入的值会被忽略。
   *
   * 这是「人类责任归属」字段,权威来源是本机 git 身份,不该让 LLM 自填
   * host 标识(如 "claude-code")。自动生成情境(如「Claude Code 自动捕获」
   * 「PR review」「调试 session」)请走 encodingContext 字段。
   *
   * 字段保留是为了向后兼容(老 LLM 调用不会因 schema 报错),但值不生效。
   */
  createdBy: z.string().min(1).optional(),
  dedupe: z.boolean().default(true),
});

// ============================================================
// engram_get
// ============================================================

/**
 * engram_get 支持的 tier：
 *   - 显式：catalog / digest / content / meta / synapses
 *   - auto：按 budget 自动选 tier（P1 任务 2.2 引入）
 *
 * 'auto' 模式下会读取可选的 contextBudget 字段，
 * 调用 adaptiveDisclosure 决定 tier。
 */
export const EngramGetTierSchema = z.enum([
  "catalog",
  "digest",
  "content",
  "meta",
  "synapses",
  "auto",
]);

export const EngramGetInputSchema = z.object({
  id: ulidField,
  tier: EngramGetTierSchema.default("digest"),
  /** tier='auto' 时使用的 token 预算；省略则用默认 4K */
  contextBudget: z
    .object({
      totalTokens: z.coerce.number().int().positive(),
      reserved: z.number().min(0).default(0),
    })
    .optional(),
  /** auto 模式下传入的相关度分数（默认 1.0，表示 top 候选） */
  score: z.coerce.number().min(0).max(1).optional(),
});

// ============================================================
// engram_update
// ============================================================

export const EngramUpdateInputSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(200).optional(),
  content: z.string().min(1).optional(),
  summary: z.string().max(300).optional(),
  kinds: z.array(EngramKindSchema).optional(),
  domainTags: z
    .array(z.string().min(1))
    .min(1)
    .refine((tags) => tags.every((t) => !/^[.\u2026\u00B7]+$/.test(t.trim())), {
      message:
        'domainTags 不接受纯点号占位(如 "...")—— 请提供真实领域标签或留空让系统分类',
    })
    .optional(),
  contextTags: z.array(z.string().min(1)).optional(),
  encodingContext: z.string().optional(),
  importance: z.coerce.number().min(0).max(1).optional(),
  confidence: z.coerce.number().min(0).max(1).optional(),
  visibility: EngramVisibilitySchema.optional(),
  // 署名契约对齐(r15 修复):与 engram_create 的 createdBy 同一原则——
  // 「人类责任归属」字段由宿主 git 身份决定,LLM 传入值不生效(schema 仍
  // 接受该字段以向后兼容)。此前 update 直接透传 parsed.updatedBy 落盘,
  // LLM 自填的机器标签(如 "claude-code")会写进 frontmatter「更新者」,
  // 与 create 的忽略策略分裂。
  updatedBy: z
    .string()
    .min(1)
    .describe(
      "Ignored (kept for backward compat): authorship is resolved from the host git identity, same as engram_create.createdBy. Use encodingContext to convey automation context.",
    ),
});

// ============================================================
// engram_delete
// ============================================================

export const EngramDeleteInputSchema = z.object({
  id: z.string().min(1),
});

// ============================================================
// engram_reinforce（P1：三信号追踪 - 有效检索）
// ============================================================

export const EngramReinforceInputSchema = z.object({
  id: ulidField,
  /** 有效性 [0,1]，1=完全有效，0.5=部分有效 */
  effectiveness: z.coerce.number().min(0).max(1).default(1),
  /** 可选：有效性说明（供审计） */
  note: z.string().max(500).optional(),
});

// ============================================================
// engram_report_failure（P1：三信号追踪 - 失败使用）
// ============================================================

export const EngramReportFailureInputSchema = z.object({
  id: z.string().min(1),
  /** 失败原因（必填，供 LTD 学习） */
  reason: z.string().min(1).max(500),
  /** 可选：失败上下文 */
  context: z.string().max(500).optional(),
});

// ============================================================
// engram_archive / engram_restore / engram_forget（P1：生命周期）
// ============================================================

export const EngramArchiveInputSchema = z.object({
  id: z.string().min(1),
  /** 可选：归档原因（审计） */
  reason: z.string().max(500).optional(),
});

export const EngramRestoreInputSchema = z.object({
  id: z.string().min(1),
  /** 可选：恢复原因（审计） */
  reason: z.string().max(500).optional(),
});

export const EngramForgetInputSchema = z.object({
  id: z.string().min(1),
  /** 必填：遗忘原因（不可逆操作，需说明） */
  reason: z.string().min(1).max(500),
});

// ============================================================
// engram_search
// ============================================================

export const SearchFilterSchema = z
  .object({
    domainTags: z.array(z.string()).optional(),
    kinds: z.array(z.string()).optional(),
    status: z.array(z.string()).optional(),
    freshness: z.array(z.string()).optional(),
    createdBy: z.array(z.string()).optional(),
    createdAfter: z.string().optional(),
    createdBefore: z.string().optional(),
    minImportance: z.coerce.number().min(0).max(1).optional(),
    // P0-3 修复:此前 contextTags 字段在 SearchFilter interface / Zod schema /
    // matchesFilter 三方都缺失,用户传入被 Zod 默认 strip 静默吞掉
    contextTags: z.array(z.string()).optional(),
    // M2 修复:verificationStatus 同样此前三方缺失 + applyPostFilter,且检索
    // 默认应排除 refuted。开放该字段让管理面能显式查询已证伪记忆。
    verificationStatus: z.array(z.string()).optional(),
  })
  // P0-3 修复:.strict() 拒绝 unknown keys(此前默认 strip 让所有 filter 字段错写
  // 都被静默吞,导致调试困难)。同 Tier 0 在 engram_search / engram_list /
  // engram_audit_query 三个工具启用;其他工具用既有 validateInput(向后兼容)
  .strict();

// ============================================================
// contradiction_resolve（P2：矛盾解决，spec §3.9）
// ============================================================

export const ContradictionVerdictSchema = z.enum([
  "keep_new",
  "keep_old",
  "merge",
  "archive",
]);

export const ContradictionResolveInputSchema = z.object({
  fromId: ulidField,
  // synapseId 是 `syn-<hex>` 小写格式,不是 ULID——不能走 ulidField(toUpperCase),
  // 否则 synapse_create 返回小写、contradiction_resolve 查大写 → NOT_FOUND。
  synapseId: z.string().min(1),
  /** 裁决选项（必填） */
  verdict: ContradictionVerdictSchema,
  /** 必填依据（供审计） */
  rationale: z.string().min(1).max(1000),
  /** 裁决者 */
  resolvedBy: z.string().min(1),
});

// ============================================================
// close_learning_loop（P2：闭合学习回路，spec §5.3.5）
// ============================================================

export const LearningOutcomeSchema = z.enum(["success", "failure", "partial"]);

export const CloseLearningLoopInputSchema = z.object({
  engramId: z.string().min(1),
  outcome: LearningOutcomeSchema,
  effectiveness: z.coerce.number().min(0).max(1).optional(),
  reason: z.string().max(500).optional(),
  reportedBy: z.string().min(1),
});

// ============================================================
// upgrade_verification（P3 4.5.3：验证状态升级）
// ============================================================

export const VerificationStatusSchema = z.enum([
  "unverified",
  "plausible",
  "probable",
  "verified",
  "refuted",
]);

export const UpgradeVerificationInputSchema = z.object({
  engramId: z.string().min(1),
  newStatus: VerificationStatusSchema,
  /** 证据说明（必填） */
  evidenceDescription: z.string().min(1).max(1000),
  /** 验证人 / 升级发起人 */
  verifiedBy: z.string().min(1),
  /** 证据置信度（0..1，可选） */
  confidence: z.coerce.number().min(0).max(1).optional(),
  /** 跨情境 domainTags（用于 distinct 统计） */
  evidenceDomainTags: z.array(z.string().min(1)).optional(),
  /** 强制升级（跳过条件检查，但仍然校验状态机） */
  force: z.boolean().optional(),
});

// ============================================================
// get_evolution_lineage（P3 4.6.3：进化血统追溯）
// ============================================================

export const LineageDirectionSchema = z.enum([
  "ancestors",
  "descendants",
  "both",
]);

export const GetEvolutionLineageInputSchema = z.object({
  engramId: z.string().min(1),
  /** 追溯方向（默认 both） */
  direction: LineageDirectionSchema.optional(),
  /** 最大深度（默认 10） */
  maxDepth: z.coerce.number().int().positive().max(20).optional(),
  /** 限制使用的 synapse kind */
  kinds: z.array(SynapseKindSchema).optional(),
});

export const EngramSearchInputSchema = z.object({
  query: z.string().min(1),
  filter: SearchFilterSchema.optional(),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

// ============================================================
// engram_list
// ============================================================

export const EngramListInputSchema = z
  .object({
    filter: SearchFilterSchema.optional(),
    limit: z.coerce.number().int().positive().max(500),
    cursor: z.string().nullable().optional(),
  })
  .strict();

/**
 * engram_list 工具返回 shape(BREAKING,Phase 3 PR3)。
 *
 * - items: 当前页的 Catalog Entry 列表(已按 importance DESC / updatedAt DESC / id ASC 排序)
 * - nextCursor: 下一页的 opaque token;null 表示已是最后一页
 *
 * 调用方翻页:把上一次返回的 nextCursor 原样作为下一次 input.cursor 传入。
 */
export interface EngramListToolResult {
  items: Array<{
    id: string;
    title: string;
    kind: string;
    domainTags: readonly string[];
  }>;
  nextCursor: string | null;
}

// ============================================================
// synapse_create
// ============================================================

export const SynapseEvidenceInputSchema = z.object({
  description: z.string().min(1),
  source: z.string().optional(),
  confidence: z.coerce.number().min(0).max(1).optional(),
  addedBy: z.string().min(1),
});

export const SynapseCreateInputSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  kind: SynapseKindSchema,
  weight: z.coerce.number().min(0).max(1).default(0.5),
  evidence: z.array(SynapseEvidenceInputSchema).optional(),
  /**
   * @deprecated 已废弃(2026-07 修复)。createdBy 现由系统从 git config 解析,
   * LLM 传入的值会被忽略(与 engram_create 对齐)。字段保留是为了向后兼容,
   * 但值不生效。
   */
  createdBy: z.string().min(1).optional(),
  sourceSemantic: z.string().optional(),
  targetSemantic: z.string().optional(),
});

// ============================================================
// synapse_get
// ============================================================

export const SynapseGetInputSchema = z.object({
  from: z.string().min(1),
  synapseId: z.string().min(1),
});

// ============================================================
// synapse_delete
// ============================================================

export const SynapseDeleteInputSchema = SynapseGetInputSchema;

// ============================================================
// synapse_list
// ============================================================

export const SynapseListInputSchema = z.object({
  engramId: z.string().min(1),
  direction: z.enum(["outgoing", "incoming", "both"]).default("both"),
});

// ============================================================
// skill_get / skill_invoke
// ============================================================

export const SkillGetInputSchema = z.object({
  id: z.string().min(1),
});

export const SkillInvokeInputSchema = z
  .object({
    id: z.string().min(1),
    success: z.boolean(),
    effectiveness: z.number().min(0).max(1).optional(),
    args: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

// ============================================================
// skill_create / skill_list / skill_update（S1）
// ============================================================

export const SkillCreateInputSchema = z
  .object({
    skillId: z.string().min(1),
    sourcePath: z.string().min(1),
    initiationSet: z.string().min(1),
    allowedTools: z.array(z.string()).optional(),
    license: z.string().optional(),
    skillVersion: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
    compatibility: z.string().optional(),
    visibility: z.enum(["public", "team", "private"]).optional(),
    createdBy: z.string().min(1),
  })
  .strict();

export const SkillListInputSchema = z
  .object({
    acquisitionStage: z.enum(["draft", "compiled", "tuned"]).optional(),
    retentionStage: z
      .enum(["active", "aging", "stale", "forgotten"])
      .optional(),
    /** 是否包含已退役(retired)技能;默认 false —— 退役技能不再列出 */
    includeRetired: z.boolean().optional(),
  })
  .strict();

export const SkillUpdateInputSchema = z
  .object({
    id: z.string().min(1),
    initiationSet: z.string().optional(),
    visibility: z.enum(["public", "team", "private"]).optional(),
    acquisitionStage: z.enum(["draft", "compiled", "tuned"]).optional(),
  })
  .strict();

export type SkillCreateToolInput = z.infer<typeof SkillCreateInputSchema>;
export type SkillListToolInput = z.infer<typeof SkillListInputSchema>;
export type SkillUpdateToolInput = z.infer<typeof SkillUpdateInputSchema>;

// ============================================================
// skill_compose（S5：Skill 组合关系）
// ============================================================

export const SkillComposeAddInputSchema = z
  .object({
    skillId: z.string().min(1),
    targetSkillId: z.string().min(1),
  })
  .strict();

export const SkillComposeListInputSchema = z
  .object({
    skillId: z.string().min(1),
  })
  .strict();

export type SkillComposeAddToolInput = z.infer<
  typeof SkillComposeAddInputSchema
>;
export type SkillComposeListToolInput = z.infer<
  typeof SkillComposeListInputSchema
>;

// skill_related_engram（skill ↔ engram 关联：程序性 ↔ 陈述性）
export const SkillRelatedEngramInputSchema = z
  .object({
    skillId: z.string().min(1),
    engramId: z.string().min(1),
  })
  .strict();
export type SkillRelatedEngramToolInput = z.infer<
  typeof SkillRelatedEngramInputSchema
>;

// ============================================================
// engram_list_proposals / engram_accept_proposal / engram_dismiss_proposal
// （M1：候选提示机制）
// ============================================================

export const EngramListProposalsInputSchema = z
  .object({
    /** 是否包含已 accepted/dismissed 的提案（默认 false，只列 pending） */
    includeAll: z.boolean().default(false),
    /**
     * 返回上限(必填,1-500)。与 cursor 配合做翻页。
     *
     * 提案列表通常远小于 engram 列表(典型 <100),但保留 cursor 分页保持
     * API 形态一致性,也覆盖 proposal-engine 候选量随观察窗口增长的场景。
     */
    limit: z.coerce.number().int().positive().max(500),
    /**
     * 分页 cursor(上一页返回的 nextCursor)。
     *
     * 编码上一页最后一条的 sort key(createdAt + entityId)。
     * 下一页返回排序更靠后的提案。
     */
    cursor: z.string().nullable().optional(),
  })
  .strict();

/**
 * engram_list_proposals 工具的返回 shape(Task 3.5 cursor 分页)。
 */
export interface EngramListProposalsToolResult {
  readonly items: ReadonlyArray<{
    entityId: string;
    occurrences: number;
    sampleQuotes: readonly string[];
    centroidExcerpt: string;
    firstSeenAt: string;
    lastSeenAt: string;
    createdAt: string;
    status: "pending" | "accepted" | "dismissed";
    /** 与 ProposalSource 类型同源(避免字面量联合与源头 drift,skill-retire 曾漏) */
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
    insightMode?: string;
    insightType?: string;
    criticScore?: number;
    criticRationale?: string;
    incubationId?: string;
    insightRound?: number;
  }>;
  readonly nextCursor: string | null;
}

export const EngramAcceptProposalInputSchema = z.object({
  /** 簇 id(= proposal.entityId;auto-memory 来源形如 `am:<slug>`) */
  entityId: z.string().min(1),
  /**
   * 可选:engram 标题。
   *
   * conversation 来源 proposal 必填。
   * auto-memory 来源 proposal 可省略 —— 缺失时从 proposal.payload.title 兜底。
   */
  title: z.string().min(1).max(200).optional(),
  /**
   * 可选:engram 内容。
   *
   * conversation 来源 proposal 必填。
   * auto-memory 来源 proposal 可省略 —— 缺失时从 proposal.payload.content 兜底。
   */
  content: z.string().min(1).optional(),
  /**
   * 可选:engram domainTags。
   *
   * conversation 来源 proposal 必填。
   * auto-memory 来源 proposal 可省略 —— 缺失时从 proposal.payload.domainTags 兜底。
   */
  domainTags: z
    .array(z.string().min(1))
    .min(1)
    .refine((tags) => tags.every((t) => !/^[.\u2026\u00B7]+$/.test(t.trim())), {
      message:
        'domainTags 不接受纯点号占位(如 "...")—— 请提供真实领域标签或留空让系统分类',
    })
    .optional(),
  /**
   * @deprecated 已废弃(2026-07 修复)。createdBy 现由系统从 git config
   * (user.name > user.email)解析,LLM 传入的值会被忽略(与 engram_create 对齐)。
   *
   * 自动生成情境请走 encodingContext(accept 不暴露此字段,
   * 由 proposal.payload.encodingContext 在 proposal-engine.accept 内部继承)。
   *
   * 字段保留是为了向后兼容(老 LLM 调用不会因 schema 报错),但值不生效。
   */
  createdBy: z.string().min(1).optional(),
  /** 可选：engram kind(默认 fact;auto-memory 来源也可从 payload 兜底) */
  kind: EngramKindSchema.optional(),
  /**
   * 可选:engram 可见性(默认 public;LLM 在 content 含风险信号时应主动询问用户后传 "private")。
   *
   * 不传时:若 proposal.payload 自带 visibility 则兜底,否则走 createEngram 默认 public。
   */
  visibility: EngramVisibilitySchema.optional(),
});

export const EngramDismissProposalInputSchema = z.object({
  entityId: z.string().min(1),
  /** 拒绝原因（可选，便于元学习） */
  reason: z.string().max(500).optional(),
  /** 多少天内不再提示（默认 30） */
  dismissDays: z.coerce.number().int().positive().max(365).optional(),
});

// ============================================================
// AI-8: batch proposal 工具
//
// 背景:2044+ 条 load-test 候选时,LLM 逐条 dismiss 会 token 爆炸。
// 用户报告「一次性清空 load-test 来源的 2000+ 候选」是高频诉求。
// batch 工具让 LLM 一次工具调用清空一批,避免 N 次往返。
// ============================================================

/** proposal source enum 复用 */
/**
 * proposal source 枚举(与 ProposalSource TS 类型对齐)。
 *
 * 2026-08-18 补齐 REM 来源:此前只枚举 4 值,rem-synapse/rem-pattern 等 REM 提案
 * 无法通过 engram_dismiss_proposals_by_filter 按 source 批量清理(95 条积压只能
 * 逐条 dismiss)。accept batch(EngramAcceptProposalsBySourceInputSchema)用独立
 * 窄 enum(仅 auto-memory/external-markdown/skill),不受本枚举扩展影响。
 * 2026-08-20 加 skill-retire(技能退役提案,dismiss-by-filter 可批量清理)。
 */
const ProposalSourceSchema = z.enum([
  "conversation",
  "auto-memory",
  "external-markdown",
  "rem-verification",
  "rem-pattern",
  "rem-synapse",
  "rem-tag-refresh",
  "rem-insight",
  "skill",
  "skill-retire",
]);

export const EngramAcceptProposalsBySourceInputSchema = z
  .object({
    /**
     * 按 source 批量 accept。
     *
     * 仅 auto-memory / external-markdown / skill 来源的 proposal 可批量 accept ——
     * 它们自带 payload(完整 title/content/domainTags/kind),无需 LLM 填表。
     * conversation 来源的 proposal 没有 payload,必须 LLM 显式提供 title/content,
     * 因此不支持 batch accept(防止批量创建垃圾 engram)。
     */
    source: z.enum(["auto-memory", "external-markdown", "skill"]),
    /**
     * @deprecated 已废弃(2026-07 修复)。createdBy 现由系统从 git config
     * (user.name > user.email)解析,LLM 传入的值会被忽略
     * (与 engram_create / engram_accept_proposal 对齐)。
     */
    createdBy: z.string().min(1).optional(),
    /** 可选:覆盖所有 accept 的 visibility(缺省走 proposal.payload.visibility → 默认 public) */
    visibility: EngramVisibilitySchema.optional(),
    /**
     * 批量上限(默认 200,最大 500)。
     *
     * 防止意外一次性创建海量 engram 触发 N+1 性能问题。
     * 超过的部分留 pending,用户可再次调用本工具。
     */
    limit: z.coerce.number().int().min(1).max(500).default(200),
  })
  .strict();

export const EngramDismissProposalsByFilterInputSchema = z
  .object({
    /**
     * 按 source 过滤(可选,缺省所有 source)。
     *
     * 典型用法:source="conversation" 清掉对话流聚类的噪声;不传 source 仅按
     * domainTags 过滤。
     */
    source: ProposalSourceSchema.optional(),
    /**
     * 按 domainTags 过滤(可选,语义:proposal.payload.domainTags 与此有交集)。
     *
     * 典型用法:domainTags=["load-test"] 清掉所有 load-test 来源的候选。
     * 对 conversation 来源(无 payload),按 proposal 自带的 centroid 派生 tags
     * 匹配;若无可派生 tags,则不命中(避免误删)。
     */
    domainTags: z
      .array(z.string().min(1))
      .min(1)
      .refine(
        (tags) => tags.every((t) => !/^[.\u2026\u00B7]+$/.test(t.trim())),
        {
          message:
            'domainTags 不接受纯点号占位(如 "...")—— 请提供真实领域标签或留空让系统分类',
        },
      )
      .optional(),
    /**
     * 按 createdAt 过滤(可选,ISO8601 字符串)。
     *
     * 典型用法:清理某时间窗内产生的候选(如 load-test 运行期间)。
     */
    createdBefore: z.string().min(1).optional(),
    createdAfter: z.string().min(1).optional(),
    /** 拒绝原因(必填,审计日志留存)。 */
    reason: z.string().min(1).max(500),
    /**
     * 暂时屏蔽天数(可选)。
     *
     *   - 不传:永久驳回(status=dismissed,dismissedUntil 留空)
     *   - 0:等同不传(永久)
     *   - 正数:N 天后该候选可被新事件重新激活
     *
     * 对 batch 场景,通常希望永久驳回(clear out load-test),所以默认是永久。
     */
    dismissDays: z.coerce.number().int().min(0).max(365).optional(),
    /**
     * 批量上限(默认 1000,最大 5000)。
     *
     * batch dismiss 通常面向数千条候选(load-test 场景),上限比 batch accept 宽松。
     * 超过的部分留 pending,用户可再次调用。
     */
    limit: z.coerce.number().int().min(1).max(5000).default(1000),
  })
  .strict();

// ============================================================
// engram_synthesize
// （Feature 1：手工触发 REM — 综合多条 engram 形成 pattern）
// ============================================================

export const EngramSynthesizeInputSchema = z.object({
  /**
   * 待综合的源 engram id 列表。
   *
   * 至少 2 条（单条无综合价值），最多 20 条（防 LLM 上下文超长 + 成本失控）。
   * id 重复会自动去重；不存在的 id 抛错并标明缺哪个。
   */
  ids: z.array(z.string().min(1)).min(2).max(20),
  /** 可选：综合结果归属的 domainTags；不传时由 LLM 推断 */
  domainTags: z.array(z.string().min(1)).max(5).optional(),
  /**
   * 可选：给 LLM 的综合提示（如"聚焦在测试稳定性"）。
   *
   * 让用户在不对 LLM 输出做兜底修改的前提下引导综合方向。
   */
  synthesisHints: z.string().max(500).optional(),
  /**
   * @deprecated 已废弃(2026-07 修复)。createdBy 现由系统从 git config 解析,
   * LLM 传入的值会被忽略(与 engram_create 对齐)。字段保留是为了向后兼容,
   * 但值不生效。
   */
  createdBy: z.string().min(1).optional(),
  /**
   * 可选：dry-run 模式（默认 false）。
   *
   * true 时只让 LLM 草拟 title/content/summary/domainTags 但不实际创建 engram/synapse，
   * 供调用方预览综合质量；返回里会带 draft 字段，patternEngramId/synapseIds 为空。
   */
  dryRun: z.boolean().optional(),
});

// ============================================================
// 类型导出（Zod 推导）
// ============================================================

export type EngramCreateToolInput = z.infer<typeof EngramCreateInputSchema>;
export type EngramGetToolInput = z.infer<typeof EngramGetInputSchema>;
export type EngramUpdateToolInput = z.infer<typeof EngramUpdateInputSchema>;
export type EngramDeleteToolInput = z.infer<typeof EngramDeleteInputSchema>;
export type EngramReinforceToolInput = z.infer<
  typeof EngramReinforceInputSchema
>;
export type EngramReportFailureToolInput = z.infer<
  typeof EngramReportFailureInputSchema
>;
export type EngramArchiveToolInput = z.infer<typeof EngramArchiveInputSchema>;
export type EngramRestoreToolInput = z.infer<typeof EngramRestoreInputSchema>;
export type EngramForgetToolInput = z.infer<typeof EngramForgetInputSchema>;
export type ContradictionResolveToolInput = z.infer<
  typeof ContradictionResolveInputSchema
>;
export type CloseLearningLoopToolInput = z.infer<
  typeof CloseLearningLoopInputSchema
>;
export type UpgradeVerificationToolInput = z.infer<
  typeof UpgradeVerificationInputSchema
>;
export type GetEvolutionLineageToolInput = z.infer<
  typeof GetEvolutionLineageInputSchema
>;
export type EngramSearchToolInput = z.infer<typeof EngramSearchInputSchema>;
export type EngramListToolInput = z.infer<typeof EngramListInputSchema>;
export type SynapseCreateToolInput = z.infer<typeof SynapseCreateInputSchema>;
export type SynapseGetToolInput = z.infer<typeof SynapseGetInputSchema>;
export type SynapseDeleteToolInput = z.infer<typeof SynapseDeleteInputSchema>;
export type SynapseListToolInput = z.infer<typeof SynapseListInputSchema>;
export type SkillGetToolInput = z.infer<typeof SkillGetInputSchema>;
export type SkillInvokeToolInput = z.infer<typeof SkillInvokeInputSchema>;
export type EngramListProposalsToolInput = z.infer<
  typeof EngramListProposalsInputSchema
>;
export type EngramAcceptProposalToolInput = z.infer<
  typeof EngramAcceptProposalInputSchema
>;
export type EngramDismissProposalToolInput = z.infer<
  typeof EngramDismissProposalInputSchema
>;
export type EngramSynthesizeToolInput = z.infer<
  typeof EngramSynthesizeInputSchema
>;

// ============================================================
// ponder_*(沉思,2026-08-17 重设计:提问即深思、纯本地、无排程)
// ============================================================

export const IncubationCreateInputSchema = z
  .object({
    /** 沉思问题(自由文本,可以比记忆更丰富) */
    question: z.string().min(4).max(2000),
    /** 可选重点记忆 id(留空自动全库检索;种子是起点提示不是边界) */
    seedEngramIds: z.array(z.string().min(1)).max(20).optional(),
  })
  .strict();

export const IncubationRunInputSchema = z
  .object({
    id: z.string().min(1),
    /**
     * agent(默认,对话入口):返回固化协议任务包,当前会话现场执行;
     * auto(viewer/CLI 异步任务):直接跑 L2 headless(失败显式报错,
     * 仅环境无 claude CLI 时降级 L1),同步返回。
     */
    mode: z.enum(["agent", "auto"]).optional(),
  })
  .strict();

export const IncubationListInputSchema = z.object({}).strict();

/** ponder_delete:删除条目本体(已产出的提案与审计保留) */
export const IncubationDeleteInputSchema = z
  .object({
    id: z.string().min(1),
  })
  .strict();

const InsightDraftSchema = z.object({
  type: z.enum(["theme", "lesson", "analogy", "hypothesis", "pattern"]),
  title: z.string().min(1).max(200),
  content: z.string().min(1),
  summary: z.string().min(1).max(300),
  sourceIds: z.array(z.string().min(1)).min(1),
  domainTags: z
    .array(z.string().min(1))
    .min(1)
    .refine((tags) => tags.every((t) => !/^[.\u2026\u00B7]+$/.test(t.trim())), {
      message:
        'domainTags 不接受纯点号占位(如 "...")—— 请提供真实领域标签或留空让系统分类',
    }),
  reason: z.string().min(1),
  aar: z
    .object({
      expected: z.string().min(1),
      actual: z.string().min(1),
      cause: z.string().min(1),
      improvement: z.string().min(1),
    })
    .optional(),
});

export const IncubationReportInputSchema = z
  .object({
    incubationId: z.string().min(1),
    report: z.object({
      /** 回答(M1:执行现场生产;缺省由 core 综合层兜底补写) */
      answer: z.string().min(1).optional(),
      insights: z.array(InsightDraftSchema),
      plan: z.array(
        z.object({ step: z.string().min(1), capability: z.string().min(1) }),
      ),
      trace: z.array(
        z.object({
          step: z.string().min(1),
          action: z.string().min(1),
          detail: z.string(),
        }),
      ),
      /** 资源使用申报(「依据」区;engram id 过试读清洗) */
      resourcesUsed: z
        .object({
          engrams: z.array(z.string().min(1)),
          skills: z.array(z.string().min(1)),
          logs: z.array(z.string().min(1)),
        })
        .optional(),
      /**
       * 需求清单(PDCA Phase1,L2 引擎侧必填;Phase2 按计划核覆盖):
       * 计划项经 planItemId 链接(缺失的计划项由引擎合成缺口,降级被
       * 覆写);closed 的 engrams/skills 条目由引擎用调用流水复核
       * (evidence.ids 必须真实调用过);瞒报/零盘点整单拒绝;有未闭合
       * 缺口时 report 被退回,修复后全量重报。
       */
      requirements: z
        .array(
          z
            .object({
              /** Phase2 计划先行:任务包 task.plan[].id(计划项必带) */
              planItemId: z.string().min(1).max(40).optional(),
              resourceType: z.enum(["engrams", "skills", "logs", "web", "mcp"]),
              description: z.string().min(1).max(500),
              necessity: z.enum(["logic-needed", "helpful"]),
              closed: z.boolean(),
              evidence: z
                .object({ ids: z.array(z.string().min(1)).max(50) })
                .optional(),
            })
            .strict(),
        )
        .max(50)
        .optional(),
    }),
  })
  .strict();

export type IncubationCreateToolInput = z.infer<
  typeof IncubationCreateInputSchema
>;
export type IncubationReportToolInput = z.infer<
  typeof IncubationReportInputSchema
>;
