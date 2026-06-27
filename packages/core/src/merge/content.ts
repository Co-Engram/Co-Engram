/**
 * Content body 段落级 3-way 合并
 *
 * 调 `git merge-file -p --diff3` 让 git 做机械合并。
 * 干净合并 → 直接用;有 marker → fallback updatedAt 取赢家整段;
 * updatedAt 一致 → 尝试 LLM 兜底(若提供 arbiter);失败 → escalate,
 * 把带 marker 的输出原样返回(由 driver 写入 %A + exit 1)。
 *
 * @module @co-engram/core/merge
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmArbiter } from "./llm-arbiter.js";
import type { LlmMergeInput } from "./llm-contract.js";

export interface ContentMergeOutcome {
  readonly merged: string;
  readonly strategy:
    | "git-3way-clean"
    | "updatedAt-fallback"
    | "llm-resolved"
    | "escalate";
  readonly conflictMarkersPresent: boolean;
  readonly winner: "ours" | "theirs" | null;
}

const CONFLICT_MARKER_RE = /^(<{7}|={7}|>{7})/m;

export function mergeContent(params: {
  base: string;
  ours: string;
  theirs: string;
  oursUpdatedAt: string;
  theirsUpdatedAt: string;
  markerSize?: number;
}): ContentMergeOutcome {
  const {
    base,
    ours,
    theirs,
    oursUpdatedAt,
    theirsUpdatedAt,
    markerSize = 7,
  } = params;

  const dir = mkdtempSync(join(tmpdir(), "co-engram-merge-"));
  const oursPath = join(dir, "ours.tmp");
  const basePath = join(dir, "base.tmp");
  const theirsPath = join(dir, "theirs.tmp");
  try {
    writeFileSync(oursPath, ours, "utf8");
    writeFileSync(basePath, base, "utf8");
    writeFileSync(theirsPath, theirs, "utf8");

    const result = spawnSync(
      "git",
      [
        "merge-file",
        "-p",
        "--diff3",
        `--marker-size=${markerSize}`,
        oursPath,
        basePath,
        theirsPath,
      ],
      { encoding: "utf8" },
    );

    // git merge-file: exit 0 = clean; exit >0 = conflict count; null = error
    const stdout = result.stdout ?? "";
    const hasMarkers = CONFLICT_MARKER_RE.test(stdout);

    if (!hasMarkers && result.status === 0) {
      return {
        merged: stdout,
        strategy: "git-3way-clean",
        conflictMarkersPresent: false,
        winner: null,
      };
    }

    // Conflict — try updatedAt fallback
    if (oursUpdatedAt > theirsUpdatedAt) {
      return {
        merged: ours,
        strategy: "updatedAt-fallback",
        conflictMarkersPresent: false,
        winner: "ours",
      };
    }
    if (theirsUpdatedAt > oursUpdatedAt) {
      return {
        merged: theirs,
        strategy: "updatedAt-fallback",
        conflictMarkersPresent: false,
        winner: "theirs",
      };
    }

    // updatedAt collision — escalate, pass through git's marked output
    return {
      merged: stdout,
      strategy: "escalate",
      conflictMarkersPresent: true,
      winner: null,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Async 版 content 合并,在 updatedAt collision 时追加 LLM 兜底(spec §5.6)。
 *
 * 注意:content 冲突对 LLM 是困难场景(段落级语义合并),所以仅当:
 *   1. 提供 arbiter
 *   2. updatedAt 完全一致(机械规则无解)
 *
 * 才调 LLM。LLM 必须返回 verdict=merge + mergedValue 才会被采用;
 * verdict=ours/theirs 也接受,采用对应整段。
 *
 * 调用方约束:path 必须是 engram 相对路径(写 audit + prompt 用)。
 */
export async function mergeContentAsync(params: {
  base: string;
  ours: string;
  theirs: string;
  oursUpdatedAt: string;
  theirsUpdatedAt: string;
  oursUpdatedBy?: string;
  theirsUpdatedBy?: string;
  markerSize?: number;
  arbiter: LlmArbiter;
  path: string;
}): Promise<ContentMergeOutcome> {
  const layerA = mergeContent(params);

  if (layerA.strategy !== "escalate") {
    return layerA;
  }

  // Layer B: LLM 兜底
  const llmInput: LlmMergeInput = {
    conflictType: "engram_content",
    path: params.path,
    base: params.base,
    ours: params.ours,
    theirs: params.theirs,
    meta: {
      oursUpdatedAt: params.oursUpdatedAt,
      theirsUpdatedAt: params.theirsUpdatedAt,
      oursUpdatedBy: params.oursUpdatedBy ?? "unknown",
      theirsUpdatedBy: params.theirsUpdatedBy ?? "unknown",
    },
  };
  const result = await params.arbiter.arbitrate(llmInput);

  if (result.verdict.kind === "resolved") {
    const output = result.verdict.output;
    if (output.verdict === "merge" && typeof output.mergedValue === "string") {
      return {
        merged: output.mergedValue,
        strategy: "llm-resolved",
        conflictMarkersPresent: false,
        winner: null, // merge 综合,无单边 winner
      };
    }
    if (output.verdict === "ours") {
      return {
        merged: params.ours,
        strategy: "llm-resolved",
        conflictMarkersPresent: false,
        winner: "ours",
      };
    }
    if (output.verdict === "theirs") {
      return {
        merged: params.theirs,
        strategy: "llm-resolved",
        conflictMarkersPresent: false,
        winner: "theirs",
      };
    }
    // verdict=escalate: fall through to layerA
  }

  return layerA;
}
