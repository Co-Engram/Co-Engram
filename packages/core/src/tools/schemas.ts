/**
 * 工具输入 Zod schemas
 *
 * 所有 Self-Editing Tool 的入参都用 Zod 校验，
 * 用于 host-agnostic 的 boundary validation。
 *
 * @module @co-engram/core/tools
 */

import { z } from "zod";

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
  "archived",
  "forgotten",
]);

export const EngramFreshnessSchema = z.enum([
  "fresh",
  "aging",
  "stale",
  "forgotten",
]);

export const EmotionalValenceSchema = z.enum([
  "positive",
  "negative",
  "neutral",
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

export const SynapseDirectionSchema = z.enum(["directional", "bidirectional"]);

// ============================================================
// engram_create
// ============================================================

export const EngramCreateInputSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(1),
  kind: EngramKindSchema,
  kinds: z.array(EngramKindSchema).optional(),
  summary: z.string().max(300).optional(),
  domainTags: z.array(z.string().min(1)).min(1),
  contextTags: z.array(z.string().min(1)).optional(),
  encodingContext: z.string().optional(),
  importance: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  emotionalValence: EmotionalValenceSchema.optional(),
  sourceType: EngramSourceTypeSchema.optional(),
  visibility: EngramVisibilitySchema.optional(),
  decayHalfLifeDays: z.number().int().positive().nullable().optional(),
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
  id: z.string().min(1),
  tier: EngramGetTierSchema.default("digest"),
  /** tier='auto' 时使用的 token 预算；省略则用默认 4K */
  contextBudget: z
    .object({
      totalTokens: z.number().int().positive(),
      reserved: z.number().min(0).default(0),
    })
    .optional(),
  /** auto 模式下传入的相关度分数（默认 1.0，表示 top 候选） */
  score: z.number().min(0).max(1).optional(),
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
  domainTags: z.array(z.string().min(1)).min(1).optional(),
  contextTags: z.array(z.string().min(1)).optional(),
  encodingContext: z.string().optional(),
  importance: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  emotionalValence: EmotionalValenceSchema.optional(),
  decayHalfLifeDays: z.number().int().positive().nullable().optional(),
  visibility: EngramVisibilitySchema.optional(),
  updatedBy: z.string().min(1),
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
  id: z.string().min(1),
  /** 有效性 [0,1]，1=完全有效，0.5=部分有效 */
  effectiveness: z.number().min(0).max(1).default(1),
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

export const SearchFilterSchema = z.object({
  domainTags: z.array(z.string()).optional(),
  kinds: z.array(z.string()).optional(),
  status: z.array(z.string()).optional(),
  freshness: z.array(z.string()).optional(),
  emotionalValence: z.array(z.string()).optional(),
  createdBy: z.array(z.string()).optional(),
  createdAfter: z.string().optional(),
  createdBefore: z.string().optional(),
  minImportance: z.number().min(0).max(1).optional(),
});

// ============================================================
// engram_recompute_importance（P2：多维重要性）
// ============================================================

export const EngramRecomputeImportanceInputSchema = z.object({
  id: z.string().min(1),
  /** 手动覆盖 personal/team/project（network/temporal 永远派生） */
  overrides: z
    .object({
      personal: z.number().min(0).max(1),
      team: z.number().min(0).max(1),
      project: z.number().min(0).max(1),
    })
    .partial()
    .optional(),
  /** 是否落盘（默认 true） */
  persist: z.boolean().default(true),
  /** 调用者标识 */
  updatedBy: z.string().min(1).default("engram_recompute_importance"),
});

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
  fromId: z.string().min(1),
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
  effectiveness: z.number().min(0).max(1).optional(),
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
  confidence: z.number().min(0).max(1).optional(),
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
  maxDepth: z.number().int().positive().max(20).optional(),
  /** 限制使用的 synapse kind */
  kinds: z.array(SynapseKindSchema).optional(),
});

export const EngramSearchInputSchema = z.object({
  query: z.string().min(1),
  filter: SearchFilterSchema.optional(),
  limit: z.number().int().positive().max(100).default(20),
});

// ============================================================
// engram_list
// ============================================================

export const EngramListInputSchema = z.object({
  filter: SearchFilterSchema.optional(),
  limit: z.number().int().positive().max(500).default(100),
});

// ============================================================
// synapse_create
// ============================================================

export const SynapseEvidenceInputSchema = z.object({
  description: z.string().min(1),
  source: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  addedBy: z.string().min(1),
});

export const SynapseCreateInputSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  kind: SynapseKindSchema,
  weight: z.number().min(0).max(1).default(0.5),
  direction: SynapseDirectionSchema.default("directional"),
  evidence: z.array(SynapseEvidenceInputSchema).optional(),
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

export const SkillInvokeInputSchema = z.object({
  id: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({}),
});

// ============================================================
// engram_list_proposals / engram_accept_proposal / engram_dismiss_proposal
// （M1：候选提示机制）
// ============================================================

export const EngramListProposalsInputSchema = z.object({
  /** 是否包含已 accepted/dismissed 的提案（默认 false，只列 pending） */
  includeAll: z.boolean().default(false),
});

export const EngramAcceptProposalInputSchema = z.object({
  /** 簇 id（= proposal.entityId） */
  entityId: z.string().min(1),
  title: z.string().min(1).max(200),
  content: z.string().min(1),
  domainTags: z.array(z.string().min(1)).min(1),
  /**
   * 可选：创建者标识。
   *
   * 留空时,工具层走与 engram_create 相同的解析链:
   * ctx.defaultCreatedBy(MCP env / OpenClaw plugin config / git 身份) → 'unknown'。
   * 修复前此处用 Zod `.default('proposal-engine')` 把该字段写死,
   * 绕过了 ctx.defaultCreatedBy,导致采纳提案后的 engram 不走 git 身份解析。
   */
  createdBy: z.string().min(1).optional(),
  /** 可选：engram kind（默认 fact） */
  kind: EngramKindSchema.optional(),
});

export const EngramDismissProposalInputSchema = z.object({
  entityId: z.string().min(1),
  /** 拒绝原因（可选，便于元学习） */
  reason: z.string().max(500).optional(),
  /** 多少天内不再提示（默认 30） */
  dismissDays: z.number().int().positive().max(365).optional(),
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
export type EngramRecomputeImportanceToolInput = z.infer<
  typeof EngramRecomputeImportanceInputSchema
>;
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
