#!/usr/bin/env node
/**
 * 真实用户工作流冒烟脚本（手动跑，非自动化测试）
 *
 * 启动 co-engram-mcp 子进程(stdio),用 MCP SDK Client 连接,走一个完整流程:
 *   1. tools/list — 验证工具可见
 *   2. engram_create(不传 createdBy,验证 CO_ENGRAM_DEFAULT_CREATED_BY 回退)
 *   3. engram_search
 *   4. engram_reinforce
 *   5. synapse_create(不传 createdBy)
 *   6. engram_get(验证读回的 createdBy 是回退后的值)
 *   7. engram_doctor — 验证自愈扫描可跑
 *   8. close_learning_loop
 *   9. engram_list_paths (progressive disclosure)
 *  10. engram_update — 修改 title
 *  11. engram_archive → engram_get(验证已归档) → engram_restore
 *  12. 反复 engram_reinforce(验证 effectiveRetrievals 累积)
 *  13. close_learning_loop failure outcome(验证 LTD 路径不崩)
 *  14. engram_list filter(验证按 tag 过滤)
 *
 * 运行:
 *   pnpm -r build
 *   node test/manual/mcp-smoke-user-flow.mjs
 *
 * @module co-engram/test/manual
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const results = [];

async function recordStep(step, fn) {
  const start = Date.now();
  try {
    const summary = await fn();
    const result = { step, ok: true, durationMs: Date.now() - start, summary };
    results.push(result);
    return result;
  } catch (err) {
    const result = {
      step,
      ok: false,
      durationMs: Date.now() - start,
      summary: "",
      error: err instanceof Error ? err.message : String(err),
    };
    results.push(result);
    return result;
  }
}

function parseContent(content) {
  const text = content?.[0]?.text ?? "{}";
  return JSON.parse(text);
}

/**
 * 调用工具,若返回 isError=true 则抛错（让 recordStep 记录为失败）
 *
 * MCP server 对未知工具 / 内部错误会返回 isError=true,但 HTTP 层面是 200,
 * content[0].text 是错误消息字符串（不是 JSON）。旧脚本直接 JSON.parse 会崩。
 */
async function callToolOrThrow(client, params) {
  const res = await client.callTool(params);
  if (res.isError) {
    const text = res.content?.[0]?.text ?? "unknown MCP error";
    throw new Error(`MCP error: ${text}`);
  }
  return res;
}

async function runUserFlow() {
  const dataRoot = mkdtempSync(join(tmpdir(), "co-engram-smoke-"));
  const mcpServerPath = resolve(__dirname, "../../dist/mcp-server.js");

  console.log(`[smoke] dataRoot=${dataRoot}`);
  console.log(`[smoke] mcpServer=${mcpServerPath}`);
  console.log(`[smoke] CO_ENGRAM_DEFAULT_CREATED_BY=smoke-tester\n`);

  const transport = new StdioClientTransport({
    command: "node",
    args: [mcpServerPath],
    env: {
      ...process.env,
      CO_ENGRAM_DATA_ROOT: dataRoot,
      CO_ENGRAM_DEFAULT_CREATED_BY: "smoke-tester",
      CO_ENGRAM_LANGUAGE: "en",
      CO_ENGRAM_TOOLS_PROFILE: "full",
    },
  });
  const client = new Client(
    { name: "smoke-client", version: "0.0.0" },
    { capabilities: {} },
  );

  try {
    await client.connect(transport);
    console.log("[smoke] connected to MCP server\n");

    // Step 1: tools/list
    await recordStep("tools/list", async () => {
      const list = await client.listTools();
      return `${list.tools.length} tools visible`;
    });

    // Step 2: engram_create WITHOUT createdBy
    const stepCreateA = await recordStep(
      "engram_create A (no createdBy)",
      async () => {
        const res = await callToolOrThrow(client, {
          name: "engram_create",
          arguments: {
            title: "Docker bridge network is isolated by default",
            content:
              "Containers on the default `bridge` network cannot reach each other unless explicitly connected. User-defined bridge networks enable automatic DNS-based service discovery.",
            kind: "fact",
            domainTags: ["docker", "networking"],
          },
        });
        const parsed = parseContent(res.content);
        return `id=${parsed.id}`;
      },
    );
    const idA = stepCreateA.summary.match(/id=([^\s]+)/)[1];

    // Step 3: engram_create with explicit createdBy
    const stepCreateB = await recordStep(
      "engram_create B (explicit createdBy=manual)",
      async () => {
        const res = await callToolOrThrow(client, {
          name: "engram_create",
          arguments: {
            title: "Docker host network mode bypasses isolation",
            content:
              "Containers using `--network host` share the host networking namespace — no isolation, no port mapping required. Useful for performance-sensitive workloads but reduces security boundary.",
            kind: "fact",
            domainTags: ["docker", "networking"],
            createdBy: "manual",
          },
        });
        const parsed = parseContent(res.content);
        return `id=${parsed.id}`;
      },
    );
    const idB = stepCreateB.summary.match(/id=([^\s]+)/)[1];

    // Step 4: engram_search
    await recordStep('engram_search "docker network"', async () => {
      const res = await callToolOrThrow(client, {
        name: "engram_search",
        arguments: { query: "docker network isolation", limit: 5 },
      });
      const parsed = parseContent(res.content);
      const hits = parsed.results?.length ?? 0;
      return `${hits} hits`;
    });

    // Step 5: engram_get — verify createdBy fallback
    await recordStep("engram_get A — verify createdBy fallback", async () => {
      const res = await callToolOrThrow(client, {
        name: "engram_get",
        arguments: { id: idA, tier: "meta" },
      });
      const parsed = parseContent(res.content);
      // meta tier 返回 { tier, entry, meta },createdBy 在 meta 下
      const actual = parsed.meta?.createdBy ?? "?";
      return actual === "smoke-tester"
        ? `createdBy='${actual}' ✓ matches CO_ENGRAM_DEFAULT_CREATED_BY`
        : `createdBy='${actual}' ✗ expected 'smoke-tester'`;
    });

    // Step 6: synapse_create WITHOUT createdBy
    await recordStep(
      "synapse_create A → B contradicts (no createdBy)",
      async () => {
        const res = await callToolOrThrow(client, {
          name: "synapse_create",
          arguments: {
            from: idA,
            to: idB,
            kind: "contradicts",
            evidence: [
              {
                description: "bridge=isolated vs host=no isolation",
                source: "manual review",
                confidence: 0.9,
                addedBy: "smoke-tester",
              },
            ],
          },
        });
        const parsed = parseContent(res.content);
        return `synapseId=${parsed.id}`;
      },
    );

    // Step 7: engram_reinforce
    await recordStep("engram_reinforce A", async () => {
      await callToolOrThrow(client, {
        name: "engram_reinforce",
        arguments: { id: idA, effectiveness: 0.8 },
      });
      return "reinforced";
    });

    // Step 8: engram_doctor
    await recordStep("engram_doctor", async () => {
      const res = await callToolOrThrow(client, {
        name: "engram_doctor",
        arguments: {},
      });
      const parsed = parseContent(res.content);
      return `engrams=${parsed.totalEngrams} synapses=${parsed.totalSynapses} fixes=${parsed.autoFixesApplied} pending=${parsed.pendingManualReview}`;
    });

    // Step 9: close_learning_loop
    await recordStep("close_learning_loop A (success)", async () => {
      await callToolOrThrow(client, {
        name: "close_learning_loop",
        arguments: {
          engramId: idA,
          outcome: "success",
          reportedBy: "smoke-tester",
          effectiveness: 0.9,
        },
      });
      return "loop closed";
    });

    // Step 10: engram_list_paths
    await recordStep("engram_list_paths", async () => {
      const res = await callToolOrThrow(client, {
        name: "engram_list_paths",
        arguments: { maxDepth: 3 },
      });
      const parsed = parseContent(res.content);
      return `root=${parsed.root?.path} engramCount=${parsed.root?.engramCount}`;
    });

    // Step 11: engram_update — 修改 title
    await recordStep("engram_update A (rename title)", async () => {
      const res = await callToolOrThrow(client, {
        name: "engram_update",
        arguments: {
          id: idA,
          title: "Docker default bridge network is isolated (renamed)",
          updatedBy: "smoke-tester",
        },
      });
      const parsed = parseContent(res.content);
      return `id=${parsed.id} version=${parsed.version}`;
    });

    // Step 12: engram_archive → engram_get(验证已归档) → engram_restore
    await recordStep("engram_archive A → get → restore", async () => {
      await callToolOrThrow(client, {
        name: "engram_archive",
        arguments: { id: idA, reason: "smoke test archive" },
      });
      // 归档后读回,验证 status='archived'
      const getRes = await callToolOrThrow(client, {
        name: "engram_get",
        arguments: { id: idA, tier: "meta" },
      });
      const parsed = parseContent(getRes.content);
      const status = parsed.meta?.status ?? parsed.entry?.status ?? "?";
      // 恢复
      await callToolOrThrow(client, {
        name: "engram_restore",
        arguments: { id: idA, reason: "smoke test restore" },
      });
      return `archived status='${status}' → restored`;
    });

    // Step 13: 反复 engram_reinforce B (3 次) — 验证 effectiveRetrievals 累积
    await recordStep("engram_reinforce B ×3 (累积效应)", async () => {
      for (let i = 0; i < 3; i++) {
        await callToolOrThrow(client, {
          name: "engram_reinforce",
          arguments: { id: idB, effectiveness: 0.7 },
        });
      }
      // 读回 meta 验证 effectiveRetrievals
      const getRes = await callToolOrThrow(client, {
        name: "engram_get",
        arguments: { id: idB, tier: "meta" },
      });
      const parsed = parseContent(getRes.content);
      const count = parsed.meta?.effectiveRetrievals ?? "?";
      return `effectiveRetrievals=${count}`;
    });

    // Step 14: close_learning_loop failure outcome — 验证 LTD 路径不崩
    await recordStep("close_learning_loop B (failure, LTD)", async () => {
      const res = await callToolOrThrow(client, {
        name: "close_learning_loop",
        arguments: {
          engramId: idB,
          outcome: "failure",
          reportedBy: "smoke-tester",
          reason: "smoke test failure outcome",
        },
      });
      return "failure loop closed";
    });

    // Step 15: engram_list filter by domainTag
    await recordStep('engram_list filter: domainTags=["docker"]', async () => {
      const res = await callToolOrThrow(client, {
        name: "engram_list",
        arguments: {
          filter: { domainTags: ["docker"] },
          limit: 10,
        },
      });
      const parsed = parseContent(res.content);
      const total = parsed.total ?? parsed.entries?.length ?? "?";
      return `matched=${total}`;
    });
  } catch (err) {
    console.error("[smoke] FATAL:", err);
    process.exitCode = 1;
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    try {
      rmSync(dataRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  console.log("\n[smoke] Summary:");
  for (const r of results) {
    const status = r.ok ? "✓" : "✗";
    const err = r.error ? ` ERROR=${r.error}` : "";
    const dur = r.durationMs.toString().padStart(5);
    console.log(
      `  ${status} ${r.step.padEnd(50)} ${dur}ms  ${r.summary}${err}`,
    );
  }
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`\n[smoke] ${failed.length} step(s) failed`);
    process.exitCode = 1;
  } else {
    console.log(`\n[smoke] All ${results.length} steps passed`);
  }
}

runUserFlow().catch((err) => {
  console.error(err);
  process.exit(1);
});
