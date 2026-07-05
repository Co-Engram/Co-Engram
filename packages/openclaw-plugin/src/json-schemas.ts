/**
 * 手写 JSON Schema 字典
 *
 * 与 packages/core/src/tools/schemas.ts 中的 Zod schemas 保持一致。
 * P0 阶段手写避免引入 zod-to-json-schema 依赖。
 * P1 阶段可改用 zod v4 的 z.toJSONSchema() 自动生成。
 *
 * @module @co-engram/openclaw
 */

import type { JsonSchemaObject } from "./types.js";

const ENGRAM_KIND_ENUM = [
  "observation",
  "fact",
  "pattern",
  "procedure",
  "hypothesis",
] as const;
const ENGRAM_STATUS_ENUM = [
  "active",
  "draft",
  "archived",
  "forgotten",
] as const;
const ENGRAM_FRESHNESS_ENUM = ["fresh", "aging", "stale", "forgotten"] as const;
const SOURCE_TYPE_ENUM = ["firsthand", "secondhand", "inferred"] as const;
const VISIBILITY_ENUM = ["public", "team", "private", "restricted"] as const;
const DISCLOSURE_TIER_ENUM = [
  "catalog",
  "digest",
  "content",
  "meta",
  "synapses",
] as const;
const ENGRAM_GET_TIER_ENUM = [
  "catalog",
  "digest",
  "content",
  "meta",
  "synapses",
  "auto",
] as const;
const SYNAPSE_KIND_ENUM = [
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
] as const;
const SYNAPSE_DIRECTION_ENUM = ["directional", "bidirectional"] as const;

const stringField = (
  description: string,
  maxLength?: number,
  minLength = 1,
): JsonSchemaObject => ({
  type: "string",
  description,
  minLength,
  ...(maxLength !== undefined ? { maxLength } : {}),
});

/** 可选字符串字段（minLength=0 允许空字符串/省略） */
const optionalStringField = (
  description: string,
  maxLength?: number,
): JsonSchemaObject => ({
  type: "string",
  description,
  ...(maxLength !== undefined ? { maxLength } : {}),
});

const numberField = (
  description: string,
  min = 0,
  max = 1,
): JsonSchemaObject => ({
  type: "number",
  description,
  minimum: min,
  maximum: max,
});

const engramIdField = stringField("Engram ID");

const searchFilterSchema: JsonSchemaObject = {
  type: "object",
  description: "可选过滤器",
  additionalProperties: false,
  properties: {
    domainTags: { type: "array", items: { type: "string" } },
    kinds: { type: "array", items: { type: "string" } },
    status: {
      type: "array",
      items: { type: "string", enum: ENGRAM_STATUS_ENUM },
    },
    freshness: {
      type: "array",
      items: { type: "string", enum: ENGRAM_FRESHNESS_ENUM },
    },
    createdBy: { type: "array", items: { type: "string" } },
    createdAfter: { type: "string", description: "ISO 8601 时间戳" },
    createdBefore: { type: "string", description: "ISO 8601 时间戳" },
    minImportance: numberField("最低重要性阈值", 0, 1),
  },
};

export const engramCreateSchema: JsonSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["title", "content", "kind", "domainTags"],
  properties: {
    title: stringField("标题（1-200 字符）", 200),
    content: stringField("正文（Markdown，非空）"),
    kind: { type: "string", enum: ENGRAM_KIND_ENUM },
    kinds: { type: "array", items: { type: "string", enum: ENGRAM_KIND_ENUM } },
    summary: stringField("摘要（≤300 字符）", 300),
    domainTags: {
      type: "array",
      items: { type: "string", minLength: 1 },
      minItems: 1,
    },
    contextTags: { type: "array", items: { type: "string", minLength: 1 } },
    encodingContext: optionalStringField("编码情境"),
    importance: numberField("重要性 [0,1]"),
    confidence: numberField("置信度 [0,1]"),
    sourceType: { type: "string", enum: SOURCE_TYPE_ENUM },
    visibility: { type: "string", enum: VISIBILITY_ENUM },
    createdBy: stringField("创建者标识（留空自动用 git user.name；不要填 'claude-code' / 'openclaw' / 'assistant' / 'system' 等工具名）"),
    dedupe: {
      type: "boolean",
      description:
        "是否触发智能去重（默认 true）。DUPLICATE 时强化原 engram 不重复创建；UPDATE 时合并；NEW 时正常创建。",
      default: true,
    },
  },
};

export const engramGetSchema: JsonSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: {
    id: engramIdField,
    tier: {
      type: "string",
      enum: ENGRAM_GET_TIER_ENUM,
      default: "digest",
      description: "披露层级（默认 digest）；auto 表示按 contextBudget 自动选",
    },
    contextBudget: {
      type: "object",
      description: "tier=auto 时的 token 预算；省略则默认 4096",
      additionalProperties: false,
      properties: {
        totalTokens: { type: "integer", minimum: 1, description: "总预算" },
        reserved: {
          type: "integer",
          minimum: 0,
          default: 0,
          description: "已被其他内容占用",
        },
      },
    },
    score: {
      type: "number",
      minimum: 0,
      maximum: 1,
      description: "auto 模式下该 engram 的相关度分数（默认 1.0）",
    },
  },
};

export const engramUpdateSchema: JsonSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["id", "updatedBy"],
  properties: {
    id: stringField("Engram ID"),
    title: stringField("新标题", 200),
    content: stringField("新正文"),
    summary: stringField("新摘要", 300),
    kinds: { type: "array", items: { type: "string", enum: ENGRAM_KIND_ENUM } },
    domainTags: {
      type: "array",
      items: { type: "string", minLength: 1 },
      minItems: 1,
    },
    contextTags: { type: "array", items: { type: "string", minLength: 1 } },
    encodingContext: optionalStringField("编码情境"),
    importance: numberField("重要性 [0,1]"),
    confidence: numberField("置信度 [0,1]"),
    visibility: { type: "string", enum: VISIBILITY_ENUM },
    updatedBy: stringField("更新者标识"),
  },
};

export const engramDeleteSchema: JsonSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: {
    id: engramIdField,
  },
};

export const engramReinforceSchema: JsonSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: {
    id: engramIdField,
    effectiveness: {
      type: "number",
      minimum: 0,
      maximum: 1,
      default: 1,
      description: "有效性 [0,1]，1=完全有效",
    },
    note: optionalStringField("有效性说明（≤500 字符，供审计）", 500),
  },
};

export const engramReportFailureSchema: JsonSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["id", "reason"],
  properties: {
    id: engramIdField,
    reason: stringField("失败原因（≤500 字符，供 LTD 学习）", 500),
    context: optionalStringField("失败上下文（≤500 字符）", 500),
  },
};

export const engramArchiveSchema: JsonSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: {
    id: engramIdField,
    reason: optionalStringField("归档原因（审计）", 500),
  },
};

export const engramRestoreSchema: JsonSchemaObject = engramArchiveSchema;

export const engramForgetSchema: JsonSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["id", "reason"],
  properties: {
    id: engramIdField,
    reason: stringField("遗忘原因（必填，不可逆操作）", 500),
  },
};

export const contradictionResolveSchema: JsonSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["fromId", "synapseId", "verdict", "rationale", "resolvedBy"],
  properties: {
    fromId: engramIdField,
    synapseId: stringField("Synapse ID", 100),
    verdict: {
      type: "string",
      enum: ["keep_new", "keep_old", "merge", "archive"],
      description: "裁决选项",
    },
    rationale: stringField("裁决依据（必填，供审计）", 1000),
    resolvedBy: stringField("裁决者标识", 100),
  },
};

export const closeLearningLoopSchema: JsonSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["engramId", "outcome", "reportedBy"],
  properties: {
    engramId: engramIdField,
    outcome: {
      type: "string",
      enum: ["success", "failure", "partial"],
      description: "使用结果",
    },
    effectiveness: {
      type: "number",
      minimum: 0,
      maximum: 1,
      description: "有效性 [0,1]（partial 时建议填写）",
    },
    reason: stringField("失败原因（outcome=failure 时建议填写）", 500),
    reportedBy: stringField("调用者标识", 100),
  },
};

export const engramSearchSchema: JsonSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["query"],
  properties: {
    query: stringField("查询字符串"),
    filter: searchFilterSchema,
    limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
  },
};

export const engramListSchema: JsonSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["limit"],
  properties: {
    filter: searchFilterSchema,
    // Task 3.1:limit 改必填(1-500),无默认值;调用方必须显式声明。
    limit: { type: "integer", minimum: 1, maximum: 500 },
    // Task 3.1:cursor 分页(上一页返回的 nextCursor 原样回传)
    cursor: { type: "string", nullable: true },
  },
};

export const synapseCreateSchema: JsonSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["from", "to", "kind"],
  properties: {
    from: engramIdField,
    to: engramIdField,
    kind: { type: "string", enum: SYNAPSE_KIND_ENUM },
    weight: { type: "number", minimum: 0, maximum: 1, default: 0.5 },
    direction: {
      type: "string",
      enum: SYNAPSE_DIRECTION_ENUM,
      default: "directional",
    },
    evidence: {
      type: "array",
      items: {
        type: "object",
        required: ["description", "addedBy"],
        properties: {
          description: { type: "string", minLength: 1 },
          source: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          addedBy: { type: "string", minLength: 1 },
        },
      },
    },
    createdBy: stringField("创建者（留空自动用 git user.name；不要填 'claude-code' / 'openclaw' 等工具名）"),
    sourceSemantic: optionalStringField("源语义标签"),
    targetSemantic: optionalStringField("目标语义标签"),
  },
};

export const synapseGetSchema: JsonSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["from", "synapseId"],
  properties: {
    from: engramIdField,
    synapseId: stringField("Synapse ID"),
  },
};

export const synapseDeleteSchema: JsonSchemaObject = synapseGetSchema;

export const synapseListSchema: JsonSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["engramId"],
  properties: {
    engramId: engramIdField,
    direction: {
      type: "string",
      enum: ["outgoing", "incoming", "both"],
      default: "both",
    },
  },
};

export const skillGetSchema: JsonSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: {
    id: stringField("Skill ID"),
  },
};

export const skillInvokeSchema: JsonSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: {
    id: stringField("Skill ID"),
    args: {
      type: "object",
      description: "调用参数（自由 key-value）",
      additionalProperties: true,
      default: {},
    },
  },
};

/**
 * 工具名 → JSON Schema 映射
 */
export const TOOL_JSON_SCHEMAS: Readonly<Record<string, JsonSchemaObject>> = {
  engram_create: engramCreateSchema,
  engram_get: engramGetSchema,
  engram_update: engramUpdateSchema,
  engram_delete: engramDeleteSchema,
  engram_search: engramSearchSchema,
  engram_list: engramListSchema,
  engram_reinforce: engramReinforceSchema,
  engram_report_failure: engramReportFailureSchema,
  engram_archive: engramArchiveSchema,
  engram_restore: engramRestoreSchema,
  engram_forget: engramForgetSchema,
  contradiction_resolve: contradictionResolveSchema,
  close_learning_loop: closeLearningLoopSchema,
  synapse_create: synapseCreateSchema,
  synapse_get: synapseGetSchema,
  synapse_delete: synapseDeleteSchema,
  synapse_list: synapseListSchema,
  skill_get: skillGetSchema,
  skill_invoke: skillInvokeSchema,
};
