/**
 * Profile contract: claude-code-mcp ≡ openclaw-plugin
 *
 * 验证两宿主的 PROFILE_TOOL_SETS(minimal/standard/full)与 PROFILE_TOOL_COUNTS
 * 完全一致。因两宿主都从 @co-engram/core re-export 同一份 profile 定义,契约
 * trivially 满足(reference-equal);本测试作为预防未来某一方"私自 fork profile"
 * 的回归 guard。
 *
 * @module @co-engram/contracts-test
 */

import {
  PROFILE_TOOL_SETS as CC_SETS,
  PROFILE_TOOL_COUNTS as CC_COUNTS,
} from "@co-engram/claude-code";
import {
  PROFILE_TOOL_SETS as OC_SETS,
  PROFILE_TOOL_COUNTS as OC_COUNTS,
} from "@co-engram/openclaw";
import type { ToolProfile } from "@co-engram/core";
import type { ContractResult, ContractDiff } from "./index.js";

const PROFILES: readonly ToolProfile[] = ["minimal", "standard", "full"];

export async function runProfileContractTests(): Promise<ContractResult> {
  const diffs: ContractDiff[] = [];

  for (const p of PROFILES) {
    const cc = [...CC_SETS[p]].sort();
    const oc = [...OC_SETS[p]].sort();
    if (JSON.stringify(cc) !== JSON.stringify(oc)) {
      diffs.push({
        kind: "profile",
        detail: `${p}: CC=[${cc.join(",")}] vs OC=[${oc.join(",")}]`,
      });
    }
    if (CC_COUNTS[p] !== CC_SETS[p].size) {
      diffs.push({
        kind: "profile",
        detail: `${p}: CC count ${CC_COUNTS[p]} != set size ${CC_SETS[p].size}`,
      });
    }
    if (OC_COUNTS[p] !== OC_SETS[p].size) {
      diffs.push({
        kind: "profile",
        detail: `${p}: OC count ${OC_COUNTS[p]} != set size ${OC_SETS[p].size}`,
      });
    }
  }

  return { passed: diffs.length === 0, diffs };
}
