/**
 * Engram 文件合并入口
 *
 * 组装 frontmatter 合并 + content 合并 + 收尾(contentHash / contentSize 重算,
 * updatedAt 取 max, version 取 max+1, updatedBy='merge-driver')。
 * 失败模式:任一方解析失败 → throw;frontmatter/content escalate → 用 git marker
 * 形式包装输给 driver 写 %A + exit 1。
 *
 * @module @co-engram/core/merge
 */

import { createHash } from "node:crypto";
import { stripDerivedSection } from "../storage/derived-marker.js";
import {
  parseEngramFile,
  serializeEngramFile,
  detectEngramFileLanguage,
  type EngramFile,
} from "../storage/engram-store.js";
import { mergeFrontmatter, mergeFrontmatterAsync } from "./frontmatter.js";
import { mergeContent, mergeContentAsync } from "./content.js";
import { snapshotLoser } from "./backup.js";
import type { AuditLog } from "../observability/audit-log.js";
import type { LlmArbiter } from "./llm-arbiter.js";

export interface EngramMergeResult {
  readonly mergedContent: string;
  readonly strategy: string;
  readonly winner: "ours" | "theirs" | null;
  readonly escalated: boolean;
  readonly backupPath?: string;
}

function computeContentHashAndSize(content: string): {
  hash: string;
  size: number;
} {
  // 先剥除派生突触段:与 computeContentHash 口径一致(派生段每次 doctor 重写,
  // 纳入 hash 会漂移)。merge 产物的 contentHash/contentSize 也定义在原始内容上。
  const hashable = stripDerivedSection(content);
  const hash = createHash("sha256").update(hashable, "utf8").digest("hex");
  const size = Buffer.byteLength(hashable, "utf8");
  return { hash, size };
}

function buildEscalatedContent(oursRaw: string, theirsRaw: string): string {
  return `<<<<<<< ours\n${oursRaw}\n=======\n${theirsRaw}\n>>>>>>> theirs\n`;
}

export async function mergeEngramFile(params: {
  baseRaw: string;
  oursRaw: string;
  theirsRaw: string;
  relPath: string;
  dataRoot?: string;
  auditLog?: AuditLog;
  /**
   * 可选 LLM 仲裁器。提供时,frontmatter 在 Layer A escalate 后会调 LLM 兜底。
   * 不提供时,仅走 Layer A(机械规则)—— 行为与 Phase 1 sync 版完全一致。
   */
  llmArbiter?: LlmArbiter;
}): Promise<EngramMergeResult> {
  const { baseRaw, oursRaw, theirsRaw, relPath, dataRoot, auditLog } = params;

  // Step 1: Parse (may throw — caller exits 1)
  const baseFile = parseEngramFile(baseRaw);
  const oursFile = parseEngramFile(oursRaw);
  const theirsFile = parseEngramFile(theirsRaw);

  // Detect language from base (fallback to ours / theirs) so output preserves input format.
  const language =
    detectEngramFileLanguage(baseRaw) ??
    detectEngramFileLanguage(oursRaw) ??
    detectEngramFileLanguage(theirsRaw);

  // Step 2: Frontmatter merge (with optional LLM Layer B)
  const fmOutcome = params.llmArbiter
    ? await mergeFrontmatterAsync({
        base: baseFile.frontmatter,
        ours: oursFile.frontmatter,
        theirs: theirsFile.frontmatter,
        arbiter: params.llmArbiter,
        path: relPath,
        meta: {
          oursUpdatedAt: oursFile.frontmatter.updatedAt as string,
          theirsUpdatedAt: theirsFile.frontmatter.updatedAt as string,
          oursUpdatedBy:
            (oursFile.frontmatter.updatedBy as string) ?? "unknown",
          theirsUpdatedBy:
            (theirsFile.frontmatter.updatedBy as string) ?? "unknown",
        },
      })
    : mergeFrontmatter({
        base: baseFile.frontmatter,
        ours: oursFile.frontmatter,
        theirs: theirsFile.frontmatter,
      });

  // Step 3: Content merge (with optional LLM Layer B)
  const contentOutcome = params.llmArbiter
    ? await mergeContentAsync({
        base: baseFile.content,
        ours: oursFile.content,
        theirs: theirsFile.content,
        oursUpdatedAt: oursFile.frontmatter.updatedAt as string,
        theirsUpdatedAt: theirsFile.frontmatter.updatedAt as string,
        oursUpdatedBy: oursFile.frontmatter.updatedBy as string | undefined,
        theirsUpdatedBy: theirsFile.frontmatter.updatedBy as string | undefined,
        arbiter: params.llmArbiter,
        path: relPath,
      })
    : mergeContent({
        base: baseFile.content,
        ours: oursFile.content,
        theirs: theirsFile.content,
        oursUpdatedAt: oursFile.frontmatter.updatedAt,
        theirsUpdatedAt: theirsFile.frontmatter.updatedAt,
      });

  // Step 4: Decide escalation
  const escalated =
    fmOutcome.escalatedFields.length > 0 ||
    contentOutcome.strategy === "escalate";

  if (escalated) {
    const strategyParts: string[] = [];
    if (fmOutcome.escalatedFields.length > 0) {
      strategyParts.push(
        `frontmatter-escalate:${fmOutcome.escalatedFields.join(",")}`,
      );
    }
    if (contentOutcome.strategy === "escalate") {
      strategyParts.push("content-escalate:updatedAt-collision");
    }
    return {
      mergedContent: buildEscalatedContent(oursRaw, theirsRaw),
      strategy: `escalate(${strategyParts.join(" + ")})`,
      winner: null,
      escalated: true,
    };
  }

  // Step 5: Recompute contentHash / contentSize + finalize
  // updatedAt / version are 'max' fields — orchestrator already computed max(ours, theirs).
  // Per spec §4.5 we additionally:
  //   - bump version by +1 (merge produces a new state)
  //   - set updatedBy = 'merge-driver'
  const { hash, size } = computeContentHashAndSize(contentOutcome.merged);
  const oursVersion = (oursFile.frontmatter.version as number | undefined) ?? 0;
  const theirsVersion =
    (theirsFile.frontmatter.version as number | undefined) ?? 0;
  const mergedFm: Record<string, unknown> = {
    ...fmOutcome.merged,
    contentHash: hash,
    contentSize: size,
    updatedBy: "merge-driver",
    version: Math.max(oursVersion, theirsVersion) + 1,
  };
  // fmOutcome.merged.updatedAt is already max(ours, theirs) via the 'max' rule; leave as-is.
  // Guard against the case where both sides omitted updatedAt (rare; treat as Date.now).
  if (mergedFm.updatedAt === undefined) {
    mergedFm.updatedAt = new Date().toISOString();
  }

  const mergedFile: EngramFile = {
    frontmatter: mergedFm as EngramFile["frontmatter"],
    content: contentOutcome.merged,
  };
  const serialized = serializeEngramFile(mergedFile, language);

  // Step 6: Backup + audit
  let backupPath: string | undefined;
  const loserSide =
    contentOutcome.winner === "ours"
      ? "theirs"
      : contentOutcome.winner === "theirs"
        ? "ours"
        : null;
  if (loserSide && dataRoot) {
    try {
      const backup = snapshotLoser({
        dataRoot,
        relPath,
        side: loserSide,
        content: loserSide === "ours" ? oursRaw : theirsRaw,
      });
      backupPath = backup.backupPath;
    } catch (e) {
      auditLog?.append({
        actor: "system",
        action: "merge_backup_failed",
        metadata: {
          path: relPath,
          reason: e instanceof Error ? e.message : String(e),
        },
      });
    }
  }

  auditLog?.append({
    actor: "system",
    action: "merge_resolved",
    engramId: mergedFm.id as string | undefined,
    metadata: {
      path: relPath,
      strategy: `${fmOutcome.strategy} + ${contentOutcome.strategy}`,
      winner: contentOutcome.winner ?? fmOutcome.arbitratedWinner,
      backupPath,
    },
  });

  return {
    mergedContent: serialized,
    strategy: `${fmOutcome.strategy} + ${contentOutcome.strategy}`,
    winner: contentOutcome.winner ?? fmOutcome.arbitratedWinner,
    escalated: false,
    backupPath,
  };
}
