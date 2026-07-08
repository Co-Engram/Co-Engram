/**
 * AI-5 hyper-pattern 5 first brick:adapter 契约测试
 *
 * 验证 createCoEngramMcpServer(CC)与 registerCoEngramTools(OC)的返回值
 * 经 extractHostRuntime 归一化后,在以下维度对称:
 *
 *   1. ctx.repository / ctx.searchOrchestrator 都非空(基础 ToolContext 字段)
 *   2. ctx.host 标识正确注入(P0-4 已修过的 dual-host 区分)
 *   3. 默认配置下 auditLog / effectivenessTracker / proposalEngine 三件套都非空
 *   4. lifecycle handle key 集合对称(stopMaintenance / stopAuditRotation /
 *      stopIndexWatcher / releaseProcessLock)
 *
 * 已知非对称(INTENTIONAL_ASYMMETRIES)在 adapter-contract.ts 显式 allowlist,
 * 不在本测试断言范围内。
 */

import { describe, it, expect } from "vitest";
import { runAdapterContractTests } from "../src/adapter-contract.js";

describe("runAdapterContractTests · AI-5 dual-host adapter shape", () => {
  it("两端入口归一化后 ctx / diagnostic refs / lifecycle handles 对称", async () => {
    const result = await runAdapterContractTests();
    if (!result.passed) {
      console.error(
        "adapter contract failures:\n" +
          result.diffs.map((d) => `  - [${d.kind}] ${d.detail}`).join("\n"),
      );
    }
    expect(result.passed).toBe(true);
    expect(result.diffs).toEqual([]);
  });
});
