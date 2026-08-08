/**
 * Synapse per-edge 存储
 *
 * 设计要点:
 * - 每条 synapse 一个 YAML 文件:`synapses/{kind}/syn-{hash}.yaml`
 * - from/to 引用 stable id(ULID),不是路径
 * - bidirectional 只存一次,解决对称边悖论
 * - 同 (from, to, kind) 必同 id(确定性哈希),支持 idempotent create
 * - evidence[] append-only,多人追加天然不冲突
 *
 * @module @co-engram/core/storage
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  unlinkSync,
  readdirSync,
} from "node:fs";
import { dirname, join, basename } from "node:path";
import { parse, stringify } from "yaml";

import type { EngramId, EngramVisibility, SynapseId } from "../types/engram.js";
import type {
  Synapse,
  SynapseKind,
  SynapseDirection,
  SynapseEvidence,
  SynapseResolutionState,
} from "../types/synapse.js";
import { computeSynapseId, isSynapseId } from "../types/synapse-id.js";
import type { Language } from "../i18n/types.js";
import { DEFAULT_LANGUAGE } from "../i18n/index.js";
import { delocalizeSynapse, localizeSynapse } from "../i18n/field-names.js";
import { internalError } from "../tools/error-schema.js";

/** Synapse 文件结构(per-edge 单文件) */
export type SynapseFile = Synapse;

/** synapses/ 顶层目录名(与人类笔记平级) */
export const SYNAPSES_DIR = "synapses";

/**
 * 计算 synapse 文件的相对路径(相对 dataRoot):
 * `synapses/{kind}/syn-{hash}.yaml`
 */
export function synapseRelativePath(
  synapseId: SynapseId,
  kind: SynapseKind,
): string {
  return join(SYNAPSES_DIR, kind, `${synapseId}.yaml`);
}

/**
 * 序列化 synapse 文件
 *
 * @param language `'en'`(默认)用英文字段名;`'zh'` 用中文字段名 + 追加 `__语言: zh` 标记
 */
export function serializeSynapseFile(
  file: SynapseFile,
  language: Language = DEFAULT_LANGUAGE,
): string {
  const obj = localizeSynapse(
    file as unknown as Record<string, unknown>,
    language,
    {
      attachLangMarker: true,
    },
  );
  return stringify(obj, { lineWidth: 0 });
}

/**
 * 解析 synapse 文件,自动归一化字段名(中/英 → 英文运行时)
 */
export function parseSynapseFile(raw: string): SynapseFile {
  const parsed = parse(raw);
  if (!parsed || typeof parsed !== "object") {
    throw internalError("Invalid synapse file: not an object");
  }
  const { normalized } = delocalizeSynapse(parsed as Record<string, unknown>);
  const s = normalized as Partial<Synapse>;
  if (typeof s.id !== "string" || !isSynapseId(s.id)) {
    throw internalError(`Invalid synapse file: bad id "${s.id}"`);
  }
  if (typeof s.from !== "string" || typeof s.to !== "string") {
    throw internalError("Invalid synapse file: missing from/to");
  }
  if (typeof s.kind !== "string") {
    throw internalError("Invalid synapse file: missing kind");
  }
  return {
    id: s.id,
    from: s.from,
    to: s.to,
    kind: s.kind,
    weight: typeof s.weight === "number" ? s.weight : 0.5,
    direction: s.direction ?? "directional",
    evidence: Array.isArray(s.evidence)
      ? (s.evidence as SynapseEvidence[])
      : [],
    createdBy: s.createdBy ?? "",
    createdAt: s.createdAt ?? "",
    updatedAt: s.updatedAt ?? "",
    sourceSemantic: s.sourceSemantic,
    targetSemantic: s.targetSemantic,
    resolutionState: s.resolutionState,
    // 旧 synapse 文件(visibility 字段引入前)无此字段,兜底 'public'
    visibility:
      s.visibility === "private" ||
      s.visibility === "team" ||
      s.visibility === "restricted" ||
      s.visibility === "public"
        ? s.visibility
        : "public",
  };
}

/**
 * 读取单条 synapse 文件
 */
export function readSynapseFile(filePath: string): SynapseFile {
  const raw = readFileSync(filePath, "utf8");
  return parseSynapseFile(raw);
}

/**
 * 写入 synapse 文件(自动创建父目录)
 */
export function writeSynapseFile(
  filePath: string,
  file: SynapseFile,
  language: Language = DEFAULT_LANGUAGE,
): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, serializeSynapseFile(file, language), "utf8");
}

/**
 * 删除 synapse 文件
 */
export function deleteSynapseFile(filePath: string): void {
  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }
}

/**
 * 从 (from, to, kind, direction) 计算并落盘一条 synapse。
 *
 * 幂等性:
 * - 同 (from, to, kind) 必同 id
 * - 文件已存在时合并 evidence(去重),不覆盖
 * - weight/direction 以新值为准(更新 updatedAt)
 *
 * @returns 写入后的 synapse 完整对象
 */
export function upsertSynapse(
  dataRoot: string,
  params: {
    from: EngramId;
    to: EngramId;
    kind: SynapseKind;
    direction?: SynapseDirection;
    weight?: number;
    evidence?: readonly Omit<SynapseEvidence, "addedAt">[];
    createdBy: string;
    sourceSemantic?: string;
    targetSemantic?: string;
    resolutionState?: SynapseResolutionState;
    /**
     * synapse 可见性,取两端 engram 的最严(`private` > `restricted` > `team` > `public`)。
     * 调用方(repository.createSynapse)负责计算并传入。
     * 已存在的 synapse 重新 upsert 时,若未提供 visibility,沿用 existing.visibility。
     */
    visibility?: EngramVisibility;
    now?: string;
    language?: Language;
  },
): Synapse {
  const now = params.now ?? new Date().toISOString();
  const direction = params.direction ?? "directional";
  const language = params.language ?? DEFAULT_LANGUAGE;
  const id = computeSynapseId(params.from, params.to, params.kind, direction);
  const relativePath = synapseRelativePath(id, params.kind);
  const absolutePath = join(dataRoot, relativePath);

  let existing: Synapse | undefined;
  if (existsSync(absolutePath)) {
    try {
      existing = readSynapseFile(absolutePath);
    } catch {
      existing = undefined;
    }
  }

  const newEvidence: SynapseEvidence[] = (params.evidence ?? []).map((e) => ({
    description: e.description,
    source: e.source,
    confidence: e.confidence,
    addedBy: e.addedBy,
    addedAt: now,
  }));

  // 合并 evidence:去重(description + addedBy 相同视为重复)
  const evidenceMap = new Map<string, SynapseEvidence>();
  for (const ev of existing?.evidence ?? []) {
    evidenceMap.set(`${ev.description}|${ev.addedBy}`, ev);
  }
  for (const ev of newEvidence) {
    evidenceMap.set(`${ev.description}|${ev.addedBy}`, ev);
  }

  const merged: Synapse = {
    id,
    from: params.from,
    to: params.to,
    kind: params.kind,
    weight: params.weight ?? existing?.weight ?? 0.5,
    direction,
    evidence: Array.from(evidenceMap.values()),
    createdBy: existing?.createdBy ?? params.createdBy,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    sourceSemantic: params.sourceSemantic ?? existing?.sourceSemantic,
    targetSemantic: params.targetSemantic ?? existing?.targetSemantic,
    resolutionState: params.resolutionState ?? existing?.resolutionState,
    visibility: params.visibility ?? existing?.visibility ?? "public",
  };

  writeSynapseFile(absolutePath, merged, language);
  return merged;
}

/**
 * 扫描所有 synapse 文件并返回 Synapse[]。
 *
 * 遍历 `synapses/{kind}/*.yaml`,按 kind 分组失败时跳过单条不阻塞整体。
 *
 * @param dataRoot 仓库根目录
 * @param onCorrupt 可选回调,遇到损坏文件时调用(用于 doctor 收集 issue)
 */
export function collectAllSynapses(
  dataRoot: string,
  onCorrupt?: (filePath: string, error: Error) => void,
): Synapse[] {
  const root = join(dataRoot, SYNAPSES_DIR);
  if (!existsSync(root)) return [];

  const results: Synapse[] = [];
  for (const kindDir of readdirSync(root, { withFileTypes: true })) {
    if (!kindDir.isDirectory()) continue;
    for (const entry of readdirSync(join(root, kindDir.name), {
      withFileTypes: true,
    })) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".yaml") && !entry.name.endsWith(".yml"))
        continue;
      const filePath = join(root, kindDir.name, entry.name);
      try {
        results.push(readSynapseFile(filePath));
      } catch (err) {
        if (onCorrupt)
          onCorrupt(
            filePath,
            err instanceof Error ? err : new Error(String(err)),
          );
      }
    }
  }
  return results;
}

/**
 * 按 endpoints 查单条 synapse(确定性 ID 让 O(1))。
 *
 * @returns 找到的 Synapse 或 undefined
 */
export function readSynapseByEndpoints(
  dataRoot: string,
  from: EngramId,
  to: EngramId,
  kind: SynapseKind,
  direction: SynapseDirection = "directional",
): Synapse | undefined {
  const id = computeSynapseId(from, to, kind, direction);
  const absolutePath = join(dataRoot, synapseRelativePath(id, kind));
  if (!existsSync(absolutePath)) return undefined;
  return readSynapseFile(absolutePath);
}

/**
 * 按 id 查 synapse。
 *
 * 需要遍历所有 kind 子目录(因为 id 不包含 kind 信息,kind 由路径承载)。
 */
export function readSynapseById(
  dataRoot: string,
  synapseId: SynapseId,
): Synapse | undefined {
  if (!isSynapseId(synapseId)) return undefined;
  const root = join(dataRoot, SYNAPSES_DIR);
  if (!existsSync(root)) return undefined;
  for (const kindDir of readdirSync(root, { withFileTypes: true })) {
    if (!kindDir.isDirectory()) continue;
    const candidate = join(root, kindDir.name, `${synapseId}.yaml`);
    if (existsSync(candidate)) return readSynapseFile(candidate);
  }
  return undefined;
}

/**
 * 删除所有触及 engramId 的 edge(级联删除)。
 *
 * @returns 删除的 edge 数
 */
export function deleteSynapsesTouching(
  dataRoot: string,
  engramId: EngramId,
): number {
  const all = collectAllSynapses(dataRoot);
  let count = 0;
  for (const syn of all) {
    if (syn.from !== engramId && syn.to !== engramId) continue;
    const path = join(dataRoot, synapseRelativePath(syn.id, syn.kind));
    deleteSynapseFile(path);
    count++;
  }
  return count;
}

/**
 * 列出某 engram 的所有相关 edge(出 + 入)。
 *
 * bidirectional synapse 同时计入 outgoing 和 incoming(对称语义)。
 */
export function listSynapsesForEngram(
  dataRoot: string,
  engramId: EngramId,
): { outgoing: Synapse[]; incoming: Synapse[] } {
  const all = collectAllSynapses(dataRoot);
  const outgoing: Synapse[] = [];
  const incoming: Synapse[] = [];
  for (const syn of all) {
    const touchesFrom = syn.from === engramId;
    const touchesTo = syn.to === engramId;
    if (syn.direction === "bidirectional") {
      if (touchesFrom || touchesTo) {
        outgoing.push(syn);
        incoming.push(syn);
      }
    } else {
      if (touchesFrom) outgoing.push(syn);
      if (touchesTo) incoming.push(syn);
    }
  }
  return { outgoing, incoming };
}

/**
 * 从文件名提取 synapse id。
 *
 * `syn-a1b2c3d4e5f67890.yaml` → `syn-a1b2c3d4e5f67890`
 */
export function extractSynapseIdFromFilename(
  filename: string,
): SynapseId | undefined {
  const base = basename(filename).replace(/\.(ya?ml)$/, "");
  return isSynapseId(base) ? base : undefined;
}
