/**
 * rem-synapse proposal behavior 契约测试
 *
 * 验证两宿主(claude-code-mcp ≡ openclaw-plugin)对 rem-synapse proposal
 * 的 accept 行为一致:
 *
 *   1. proposalEngine 都非空
 *   2. proposeSynapseOp 返回 true
 *   3. accept rem-synapse add 后突触出现(kind=similar_to)
 *
 * 本契约测试保障 ProposalEngine 按 source 分派逻辑正确,
 * 双宿主共享同一份 @co-engram/core 行为实现。
 */

import { describe, it, expect } from "vitest";
import { runProposalBehaviorContractTests } from "../src/proposal-behavior-contract.js";

describe("runProposalBehaviorContractTests · rem-synapse accept 一致性", () => {
  it("两宿主都能 accept rem-synapse add,且突触落库一致", async () => {
    const result = await runProposalBehaviorContractTests();
    if (!result.passed) {
      console.error(
        "proposal behavior contract failures:\n" +
          result.diffs.map((d) => `  - [${d.kind}] ${d.detail}`).join("\n"),
      );
    }
    expect(result.passed).toBe(true);
    expect(result.diffs).toEqual([]);
  });
});
