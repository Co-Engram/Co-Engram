/**
 * Frontmatter 整体合并入口
 *
 * 遍历 base/ours/theirs 的所有字段 key,按 classifyField 分发到对应规则。
 * updatedAt_arbitrated 字段在双方都改时调 arbitrateByUpdatedAt;
 * 返回 'escalate' 时把字段名记入 escalatedFields(调用方应该 leave markers)。
 *
 * `mergeFrontmatter` 是 sync 版本,只走 Layer A(机械规则)。
 * `mergeFrontmatterAsync` 在 Layer A escalate 后,对每个 escalate 字段
 * 追加 Layer B(LLM)调用,失败的留下 escalatedFields。
 *
 * contentHash / contentSize 不在此处算,由 mergeEngram 在 content 合并后回填。
 *
 * @module @co-engram/core/merge
 */

import type { EngramFrontmatter } from "../storage/engram-store.js";
import {
  classifyField,
  mergeImmutableField,
  mergeAdditiveField,
  mergeMaxField,
  ImmutableViolationError,
} from "./frontmatter-rules.js";
import { arbitrateByUpdatedAt } from "./arbitration.js";
import type { LlmArbiter } from "./llm-arbiter.js";
import type { LlmMergeInput } from "./llm-contract.js";

export interface FrontmatterMergeOutcome {
  readonly merged: Record<string, unknown>;
  readonly strategy: string;
  readonly escalatedFields: readonly string[];
  readonly arbitratedWinner: "ours" | "theirs" | null;
}

type Front = Record<string, unknown>;

function toRecord(fm: EngramFrontmatter): Front {
  return fm as unknown as Front;
}

function fieldChanged(base: Front, side: Front, key: string): boolean {
  return JSON.stringify(side[key]) !== JSON.stringify(base[key]);
}

export function mergeFrontmatter(params: {
  base: EngramFrontmatter;
  ours: EngramFrontmatter;
  theirs: EngramFrontmatter;
}): FrontmatterMergeOutcome {
  const base = toRecord(params.base);
  const ours = toRecord(params.ours);
  const theirs = toRecord(params.theirs);

  const allKeys = new Set([
    ...Object.keys(base),
    ...Object.keys(ours),
    ...Object.keys(theirs),
  ]);

  const merged: Record<string, unknown> = {};
  const escalatedFields: string[] = [];
  let nAdditive = 0;
  let nMax = 0;
  let nArbitrated = 0;
  let arbitratedWinner: "ours" | "theirs" | null = null;

  for (const key of allKeys) {
    const cls = classifyField(key);
    const baseV = base[key];
    const oursV = ours[key];
    const theirsV = theirs[key];

    if (cls === "legacy_derived") continue;
    if (cls === "recomputed") continue; // filled after content merge

    if (cls === "immutable") {
      try {
        const r = mergeImmutableField({
          base: baseV,
          ours: oursV,
          theirs: theirsV,
          fieldName: key,
        });
        merged[key] = r.value;
      } catch (e) {
        if (e instanceof ImmutableViolationError) {
          escalatedFields.push(key);
          merged[key] = baseV; // preserve base; driver will leave markers
        } else {
          throw e;
        }
      }
      continue;
    }

    if (cls === "additive") {
      const r = mergeAdditiveField({
        base: baseV as number | undefined,
        ours: oursV as number | undefined,
        theirs: theirsV as number | undefined,
      });
      merged[key] = r.value;
      nAdditive++;
      continue;
    }

    if (cls === "max") {
      const r = mergeMaxField({
        base: baseV as number | string,
        ours: oursV as number | string,
        theirs: theirsV as number | string,
      });
      merged[key] = r.value;
      nMax++;
      continue;
    }

    // updatedAt_arbitrated
    const oursChanged = fieldChanged(base, ours, key);
    const theirsChanged = fieldChanged(base, theirs, key);

    if (!oursChanged && !theirsChanged) {
      merged[key] = baseV;
      continue;
    }
    if (oursChanged && !theirsChanged) {
      merged[key] = oursV;
      nArbitrated++;
      arbitratedWinner = "ours";
      continue;
    }
    if (theirsChanged && !oursChanged) {
      merged[key] = theirsV;
      nArbitrated++;
      arbitratedWinner = "theirs";
      continue;
    }

    // both changed → arbitrate
    const verdict = arbitrateByUpdatedAt({
      oursUpdatedAt: ours.updatedAt as string,
      theirsUpdatedAt: theirs.updatedAt as string,
      baseContentHash: base.contentHash as string | undefined,
      oursContentHash: ours.contentHash as string | undefined,
      theirsContentHash: theirs.contentHash as string | undefined,
    });
    nArbitrated++;
    if (verdict === "escalate") {
      escalatedFields.push(key);
      merged[key] = oursV; // placeholder; driver will leave markers
      // Don't update arbitratedWinner on escalate; outcome tracks winner only on resolution
    } else {
      merged[key] = verdict === "ours" ? oursV : theirsV;
      arbitratedWinner = verdict;
    }
  }

  const winnerLabel =
    escalatedFields.length > 0 && nArbitrated > 0 && arbitratedWinner === null
      ? "escalated"
      : (arbitratedWinner ?? "none");
  const strategy = `frontmatter: ${nAdditive} additive + ${nMax} max + ${nArbitrated} arbitrated(${winnerLabel})`;

  return {
    merged,
    strategy,
    escalatedFields,
    arbitratedWinner: escalatedFields.length > 0 ? null : arbitratedWinner,
  };
}

/**
 * Async 版 frontmatter 合并,在 Layer A escalate 后追加 Layer B(LLM)兜底。
 *
 * 流程(spec §5.6 三层仲裁):
 *   1. 调 sync `mergeFrontmatter` 拿到 Layer A 结果
 *   2. 对每个 escalatedField 单独构造 LlmMergeInput(engram_frontmatter 类型)
 *   3. 调 LlmArbiter.arbitrate → resolved 则替换字段值,从 escalatedFields 移除
 *   4. 仍然 escalate 的字段保留在 escalatedFields,driver 写 marker
 *
 * 调用方需提供:
 *   - arbiter:已配置好的 LlmArbiter
 *   - path/relPath:engram 相对路径(写 audit + LLM prompt 用)
 *   - meta:双边的 updatedBy/updatedAt(LLM prompt 用)
 */
export async function mergeFrontmatterAsync(params: {
  base: EngramFrontmatter;
  ours: EngramFrontmatter;
  theirs: EngramFrontmatter;
  arbiter: LlmArbiter;
  path: string;
  meta: LlmMergeInput["meta"];
}): Promise<FrontmatterMergeOutcome> {
  const { base, ours, theirs, arbiter, path, meta } = params;

  // Step 1: Layer A (sync)
  const layerA = mergeFrontmatter({ base, ours, theirs });
  if (layerA.escalatedFields.length === 0) {
    return layerA;
  }

  // Step 2: Layer B (LLM) — 对每个 escalate 字段尝试仲裁
  const merged: Record<string, unknown> = { ...layerA.merged };
  const stillEscalated: string[] = [];
  const baseRec = base as unknown as Record<string, unknown>;
  const oursRec = ours as unknown as Record<string, unknown>;
  const theirsRec = theirs as unknown as Record<string, unknown>;

  for (const fieldName of layerA.escalatedFields) {
    const llmInput: LlmMergeInput = {
      conflictType: "engram_frontmatter",
      path,
      fieldName,
      base: baseRec[fieldName],
      ours: oursRec[fieldName],
      theirs: theirsRec[fieldName],
      meta,
    };
    const result = await arbiter.arbitrate(llmInput);

    if (result.verdict.kind === "resolved") {
      const output = result.verdict.output;
      if (output.verdict === "merge" && "mergedValue" in output) {
        merged[fieldName] = output.mergedValue;
      } else if (output.verdict === "ours") {
        merged[fieldName] = oursRec[fieldName];
      } else if (output.verdict === "theirs") {
        merged[fieldName] = theirsRec[fieldName];
      }
      // LLM resolved; field leaves escalated set
    } else {
      // LLM escalate — preserve placeholder, leave in escalated set
      stillEscalated.push(fieldName);
    }
  }

  if (stillEscalated.length === layerA.escalatedFields.length) {
    // LLM couldn't resolve any — return Layer A outcome unchanged
    return layerA;
  }

  // Recompute strategy + arbitratedWinner
  const resolvedCount = layerA.escalatedFields.length - stillEscalated.length;
  const winnerLabel =
    stillEscalated.length > 0 ? "partial-llm" : "llm-resolved";
  const strategy = `${layerA.strategy} + llm:${resolvedCount} resolved, ${stillEscalated.length} escalated`;

  return {
    merged,
    strategy,
    escalatedFields: stillEscalated,
    arbitratedWinner: stillEscalated.length > 0 ? null : "ours",
    // Note: 当 LLM 完全解决时设 arbitratedWinner=ours 仅表示 "已解决";
    // 真正的双边 winner 语义由 mergeEngramFile 整合时给 content merge 决定。
  };
}
