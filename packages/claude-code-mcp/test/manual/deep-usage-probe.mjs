#!/usr/bin/env node
/**
 * 深度探针:UX 关键点检查
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER =
  "/home/10192021@zte.intra/AIOS/co-engram/packages/claude-code-mcp/dist/mcp-server.js";
const DATA_ROOT = process.argv[2] ?? "/tmp/co-engram-probe-data";

const env = {
  ...process.env,
  CO_ENGRAM_DATA_ROOT: DATA_ROOT,
  CO_ENGRAM_DEFAULT_CREATED_BY: "real-user",
  CO_ENGRAM_MAINTENANCE: "0",
  CO_ENGRAM_TOOLS_PROFILE: "full",
  CO_ENGRAM_LANGUAGE: "zh",
};

const transport = new StdioClientTransport({
  stdio: ["ignore", "pipe", "inherit"],
  command: "node",
  args: [SERVER],
  env,
});

const client = new Client(
  { name: "deep-probe", version: "1.0" },
  { capabilities: {} },
);
await client.connect(transport);

async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) {
    const text = r.content?.[0]?.text ?? JSON.stringify(r.content);
    throw new Error(`${name}: ${text}`);
  }
  if (r.structuredContent) return r.structuredContent;
  const text = r.content?.[0]?.text;
  if (text) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return r;
}

console.log(`\n[deep-probe] dataRoot=${DATA_ROOT}\n`);

// 1. doctor 详细输出
console.log("--- engram_doctor 详情 ---");
const doc = await call("engram_doctor", {});
console.log(JSON.stringify(doc, null, 2));

// 2. list_paths 看实际目录结构
console.log("\n--- engram_list_paths ---");
const paths = await call("engram_list_paths", {});
console.log(JSON.stringify(paths, null, 2).slice(0, 1000));

// 3. 测试 upgrade_verification
console.log("\n--- upgrade_verification 流程 ---");
const search = await call("engram_search", { query: "typescript" });
const targetId = search.results[0]?.id;
if (targetId) {
  try {
    const r = await call("upgrade_verification", {
      engramId: targetId,
      newStatus: "plausible",
      evidenceDescription: "深度探针验证:在实际 TS 项目中见过这个模式",
      verifiedBy: "real-user",
      confidence: 0.85,
    });
    console.log("upgrade ok:", JSON.stringify(r));
  } catch (err) {
    console.log("upgrade failed:", err.message);
  }
}

// 4. 测试 contradiction_resolve 流程
console.log("\n--- contradiction 流程 ---");
const syn = await call("engram_search", { query: "SSH" });
if (syn.results.length > 0) {
  const synId = syn.results[0].id;
  try {
    // 创建第二个 contradicting engram
    const contra = await call("engram_create", {
      title: "SSH 隧道不可用",
      content: "在内网封锁环境下 ssh -L 转发失败",
      kind: "observation",
      domainTags: ["ops", "linux"],
    });
    if (contra.id && contra.id !== synId) {
      const synCreate = await call("synapse_create", {
        from: synId,
        to: contra.id,
        kind: "contradicts",
        direction: "bidirectional",
      });
      console.log("contradicts synapse:", JSON.stringify(synCreate));
    }
  } catch (err) {
    console.log("contradiction setup failed:", err.message);
  }
}

// 5. 看 prompts — 用户体验的另一半
console.log("\n--- prompts/list (system prompt 入口) ---");
try {
  const prompts = await client.listPrompts();
  console.log("prompts:", JSON.stringify(prompts, null, 2).slice(0, 800));
} catch (err) {
  console.log("listPrompts failed:", err.message);
}

// 6. 看 resources — 用户能否浏览数据
console.log("\n--- resources/list ---");
try {
  const resources = await client.listResources();
  console.log("resources count:", resources.resources?.length ?? 0);
  if (resources.resources?.length > 0) {
    console.log(
      "first 3:",
      JSON.stringify(resources.resources.slice(0, 3), null, 2),
    );
  }
} catch (err) {
  console.log("listResources failed:", err.message);
}

await client.close();
