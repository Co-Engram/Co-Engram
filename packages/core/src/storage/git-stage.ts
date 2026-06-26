/**
 * Git 暂存与提交消息生成（P0-C 规范化提交）
 *
 * 提供：
 *   - stageChanges: 根据 engramIds 收集对应三文件路径
 *   - generateCommitMessage: 分析暂存文件，生成规范化提交消息
 *   - assessChangeRisk: 根据 synapse 类型评估变更风险
 *
 * @module @co-engram/core/storage
 */

import { deriveAllFilePaths } from "./path.js";
import type { SynapseKind } from "../types/synapse.js";

/** 提交消息信息 */
export interface CommitInfo {
  /** 完整提交消息 */
  readonly message: string;
  /** 变更类型 */
  readonly kind: "create" | "update" | "delete" | "mixed";
  /** 涉及的 engram 数量 */
  readonly engramCount: number;
}

/** 风险等级 */
export type ChangeRisk = "low" | "medium" | "high";

/** 变更风险评估结果 */
export interface ChangeRiskAssessment {
  readonly risk: ChangeRisk;
  readonly reasons: readonly string[];
}

/** 低风险 synapse（建立性连接） */
const LOW_RISK_SYNAPSE_KINDS: ReadonlySet<SynapseKind> = new Set<SynapseKind>([
  "extends",
  "similar_to",
  "exemplifies",
  "contextualizes",
  "consolidates",
]);

/** 高风险 synapse（矛盾/取代） */
const HIGH_RISK_SYNAPSE_KINDS: ReadonlySet<SynapseKind> = new Set<SynapseKind>([
  "contradicts",
  "supersedes",
]);

/**
 * 将 engramIds 转换为三文件路径列表
 *
 * @param engramIds - 相对路径形式的 engram ID 列表
 * @returns 相对 rootPath 的文件路径数组（每个 engram 对应 3 个文件）
 */
export function stageChanges(engramIds: readonly string[]): string[] {
  const files: string[] = [];
  for (const id of engramIds) {
    const paths = deriveAllFilePaths(id);
    files.push(paths.content, paths.meta, paths.synapses);
  }
  return files;
}

/**
 * 分析变更类型
 *
 * 通过比较暂存文件路径的模式推断整体变更类型：
 *   - 全部含新增：create
 *   - 全部含更新：update
 *   - 全部含删除：delete
 *   - 混合：mixed
 */
function classifyChange(
  stagedFiles: readonly string[],
): "create" | "update" | "delete" | "mixed" {
  if (stagedFiles.length === 0) return "mixed";

  const kinds = new Set<"create" | "update" | "delete">();
  for (const f of stagedFiles) {
    if (
      f.startsWith("engrams/content/") ||
      f.startsWith("engrams/meta/") ||
      f.startsWith("engrams/synapses/")
    ) {
      kinds.add("create");
    }
  }

  if (kinds.size === 0) return "mixed";
  if (kinds.size === 1) {
    return [...kinds][0]!;
  }
  return "mixed";
}

/**
 * 从文件路径提取 engram id
 *
 * `engrams/content/a/b.md` → `a/b`
 * `engrams/meta/x.yaml` → `x`
 * `engrams/synapses/y/z.yaml` → `y/z`
 */
function extractEngramIdFromPath(filePath: string): string | null {
  const match = /^engrams\/(?:content|meta|synapses)\/(.+)\.(?:md|ya?ml)$/.exec(
    filePath,
  );
  return match ? match[1]! : null;
}

/**
 * 生成规范化提交消息
 *
 * 形如：`co-engram: 新增[设备ADB调试方法]及3条连接(supersedes, depends_on)`
 *
 * P0 简化版：只基于文件路径数量生成消息，不解析实际内容。
 * P1+ 版本会读 YAML 提取 title/kind/synapse kinds 生成更详细消息。
 */
export function generateCommitMessage(
  stagedFiles: readonly string[],
  options?: { title?: string; synapseKinds?: readonly SynapseKind[] },
): CommitInfo {
  if (stagedFiles.length === 0) {
    return { message: "co-engram: (空变更)", kind: "mixed", engramCount: 0 };
  }

  const engramIds = new Set<string>();
  for (const f of stagedFiles) {
    const id = extractEngramIdFromPath(f);
    if (id) engramIds.add(id);
  }
  const engramCount = engramIds.size;

  const changeKind = classifyChange(stagedFiles);
  const actionByKind: Record<typeof changeKind, string> = {
    create: "新增",
    update: "更新",
    delete: "删除",
    mixed: "调整",
  } as const;
  const action = actionByKind[changeKind];
  const titlePart = options?.title ?? `${engramCount} 个 engram`;
  const synapsePart =
    options?.synapseKinds && options.synapseKinds.length > 0
      ? `及 ${options.synapseKinds.length} 条连接(${options.synapseKinds.join(", ")})`
      : "";

  const message = `co-engram: ${action}[${titlePart}]${synapsePart}`;
  return { message, kind: changeKind, engramCount };
}

/**
 * 评估变更风险
 *
 * 规则（来自设计文档 §八）：
 *   低风险：新增 extends/similar_to/exemplifies/contextualizes/consolidates
 *   中风险：新增 depends_on/causes/follows/derives_from/part_of
 *   高风险：新增 contradicts/supersedes 或删除已有连接
 */
export function assessChangeRisk(
  synapseKinds: readonly SynapseKind[],
  hasDeletions: boolean,
): ChangeRiskAssessment {
  const reasons: string[] = [];

  if (hasDeletions) {
    return {
      risk: "high",
      reasons: ["删除已有连接（可能影响知识结构）"],
    };
  }

  const hasHigh = synapseKinds.some((k) => HIGH_RISK_SYNAPSE_KINDS.has(k));
  const hasLow = synapseKinds.some((k) => LOW_RISK_SYNAPSE_KINDS.has(k));
  const hasMedium = synapseKinds.length > 0 && !hasHigh && !hasLow;

  if (hasHigh) {
    if (synapseKinds.includes("contradicts"))
      reasons.push("新增 contradicts 连接");
    if (synapseKinds.includes("supersedes"))
      reasons.push("新增 supersedes 连接（取代关系）");
    return { risk: "high", reasons };
  }

  if (hasMedium) {
    const mediumKinds = synapseKinds.filter(
      (k) => !LOW_RISK_SYNAPSE_KINDS.has(k) && !HIGH_RISK_SYNAPSE_KINDS.has(k),
    );
    reasons.push(`新增中风险连接: ${mediumKinds.join(", ")}`);
    return { risk: "medium", reasons };
  }

  if (hasLow) {
    return { risk: "low", reasons: ["仅含建立性连接"] };
  }

  return { risk: "low", reasons: ["无连接变更"] };
}
