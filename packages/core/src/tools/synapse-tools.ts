/**
 * Synapse 工具集（P0）
 *
 * 4 个工具：
 *   - synapse_create: 创建（含双方缓存更新）
 *   - synapse_get: 读取单条
 *   - synapse_delete: 删除（同步更新双方缓存）
 *   - synapse_list: 列出某 engram 的所有 synapses（出/入/双向）
 *
 * @module @co-engram/core/tools
 */

import type { Synapse, SynapseEvidence } from "../types/synapse.js";
import type { Tool } from "./tool.js";
import {
  validateInput,
  notFoundError,
  validationError,
} from "./tool.js";
import { randomUUID } from "node:crypto";
import {
  SynapseCreateInputSchema,
  SynapseGetInputSchema,
  SynapseDeleteInputSchema,
  SynapseListInputSchema,
  type SynapseCreateToolInput,
  type SynapseGetToolInput,
  type SynapseDeleteToolInput,
  type SynapseListToolInput,
} from "./schemas.js";

// ============================================================
// synapse_create
// ============================================================

export const synapseCreateTool: Tool<SynapseCreateToolInput, { id: string }> = {
  name: "synapse_create",
  description:
    '在两个 Engram 之间创建 Synapse（连接）。自动更新双方的 incoming/outgoing 缓存。createdBy 可选,缺省时回退到 ToolContext.defaultCreatedBy,再缺省回退到 "unknown"。',
  inputSchema: SynapseCreateInputSchema,
  execute(input, ctx) {
    const parsed = validateInput<SynapseCreateToolInput>(
      SynapseCreateInputSchema,
      input,
    );
    const createdBy = parsed.createdBy ?? ctx.defaultCreatedBy ?? "unknown";

    // 校验端点存在
    if (!ctx.repository.exists(parsed.from)) {
      throw notFoundError("Source engram", parsed.from);
    }
    if (!ctx.repository.exists(parsed.to)) {
      throw notFoundError("Target engram", parsed.to);
    }
    if (parsed.from === parsed.to) {
      throw validationError(
        "Self-synapse is not allowed: `from` and `to` must differ.",
        "Choose two different engram IDs. Self-connections are intentionally forbidden in P0.",
      );
    }

    const timestamp = new Date().toISOString();
    const synapseId = randomUUID();
    const evidence: readonly SynapseEvidence[] = (parsed.evidence ?? []).map(
      (e) => ({
        description: e.description,
        source: e.source,
        confidence: e.confidence,
        addedAt: timestamp,
        addedBy: e.addedBy,
      }),
    );

    const synapse: Synapse = {
      id: synapseId,
      from: parsed.from,
      to: parsed.to,
      kind: parsed.kind,
      weight: parsed.weight,
      direction: parsed.direction,
      evidence,
      createdBy,
      createdAt: timestamp,
      updatedAt: timestamp,
      retrievalWeight: parsed.weight,
      sourceSemantic: parsed.sourceSemantic,
      targetSemantic: parsed.targetSemantic,
      visibility: "public",
    };

    const stored = ctx.repository.addOutgoingSynapse(parsed.from, synapse);
    const storedId = stored.id;

    // audit:synapse_create 复用 'create' action,通过 synapseId 标记是 synapse
    ctx.auditLog?.append({
      actor: "user",
      action: "create",
      engramId: parsed.from,
      metadata: {
        target: "synapse",
        synapseId: storedId,
        from: parsed.from,
        to: parsed.to,
        kind: parsed.kind,
        weight: parsed.weight,
        direction: parsed.direction,
        createdBy,
      },
    });

    // M1: contradicts synapse 触发有效性信号（双方都记一次）
    if (parsed.kind === "contradicts") {
      ctx.auditLog?.append({
        actor: "user",
        action: "contradicted",
        engramId: parsed.from,
        metadata: { synapseId: storedId, contradictedBy: parsed.to, createdBy },
      });
      ctx.auditLog?.append({
        actor: "user",
        action: "contradicted",
        engramId: parsed.to,
        metadata: {
          synapseId: storedId,
          contradictedBy: parsed.from,
          createdBy,
        },
      });
    }

    return { id: storedId };
  },
};

// ============================================================
// synapse_get
// ============================================================

export const synapseGetTool: Tool<SynapseGetToolInput, Synapse> = {
  name: "synapse_get",
  description: "读取单条 Synapse（通过 from engramId + synapseId）。",
  inputSchema: SynapseGetInputSchema,
  execute(input, ctx) {
    const parsed = validateInput<SynapseGetToolInput>(
      SynapseGetInputSchema,
      input,
    );
    const file = ctx.repository.readSynapses(parsed.from);
    const found = file.outgoing.find((s) => s.id === parsed.synapseId);
    if (!found) {
      throw notFoundError(
        "Synapse",
        `${parsed.from}/${parsed.synapseId}`,
        `Use synapse_list on engram ${parsed.from} to enumerate its synapses.`,
      );
    }
    return found;
  },
};

// ============================================================
// synapse_delete
// ============================================================

export const synapseDeleteTool: Tool<
  SynapseDeleteToolInput,
  { id: string; deleted: true }
> = {
  name: "synapse_delete",
  description: "删除一条 Synapse（同步更新双方缓存）。",
  inputSchema: SynapseDeleteInputSchema,
  execute(input, ctx) {
    const parsed = validateInput<SynapseDeleteToolInput>(
      SynapseDeleteInputSchema,
      input,
    );
    // 删前先读出原 synapse 信息(audit 用)
    const before = ctx.repository
      .readSynapses(parsed.from)
      .outgoing.find((s) => s.id === parsed.synapseId);
    ctx.repository.removeOutgoingSynapse(parsed.from, parsed.synapseId);

    ctx.auditLog?.append({
      actor: "user",
      action: "purge",
      engramId: parsed.from,
      metadata: {
        target: "synapse",
        synapseId: parsed.synapseId,
        from: parsed.from,
        to: before?.to,
        kind: before?.kind,
        weight: before?.weight,
        direction: before?.direction,
      },
    });
    return { id: parsed.synapseId, deleted: true as const };
  },
};

// ============================================================
// synapse_list
// ============================================================

export const synapseListTool: Tool<
  SynapseListToolInput,
  { outgoing: Synapse[]; incoming: Synapse[] }
> = {
  name: "synapse_list",
  description: "列出某 Engram 的所有 Synapses（出边 / 入边 / 双向）。",
  inputSchema: SynapseListInputSchema,
  execute(input, ctx) {
    const parsed = validateInput<SynapseListToolInput>(
      SynapseListInputSchema,
      input,
    );

    const outgoing =
      parsed.direction === "outgoing" || parsed.direction === "both"
        ? ctx.repository.readSynapses(parsed.engramId).outgoing
        : [];

    const incoming =
      parsed.direction === "incoming" || parsed.direction === "both"
        ? ctx.repository
            .collectAllSynapses()
            .filter(({ synapse }) => synapse.to === parsed.engramId)
            .map(({ synapse }) => synapse)
        : [];

    return {
      outgoing: [...outgoing],
      incoming,
    };
  },
};

export const ALL_SYNAPSE_TOOLS: readonly Tool[] = [
  synapseCreateTool,
  synapseGetTool,
  synapseDeleteTool,
  synapseListTool,
];
