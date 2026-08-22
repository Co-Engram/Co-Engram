/**
 * 沉思取用归因 端到端验证(2026-08-22)
 *
 * 验证方案 A 的完整链路,分两段:
 *
 * 场景 1(spawn env 注入段):真实 defaultSpawn(非注入 spawnFn)+ 假 claude
 *   脚本 —— 断言 headless 子进程环境里携带 CO_ENGRAM_CONTEMPLATION_SESSION=1
 *   (headless 会话内的 co-engram MCP server 子进程靠继承此 env 归因)。
 *
 * 场景 2(真实 MCP server stdio 驱动):以隔离 HOME + 临时 dataRoot 启动
 *   dist/mcp-server.js,经 MCP 协议(initialize → tools/call)真实调用
 *   engram_search 命中预置记忆:
 *   - 对照组(无 env):retrievalCount +1 且 observation-windows.jsonl 有新窗
 *     (证明该调用路径确实写取用 —— 归因组的"不变"才有意义);
 *   - 归因组(CO_ENGRAM_CONTEMPLATION_SESSION=1):同调用,retrievalCount
 *     不变、无观察窗 —— 冷却榜/hotness/effectiveness 不被沉思检索污染。
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  EngramRepository,
  IndexDb,
  AuditLog,
  createHeadlessExecutor,
  CONTEMPLATION_SESSION_ENV,
  type NightThinkingTask,
} from "@co-engram/core";

const require = createRequire(import.meta.url);
const MCP_SERVER_JS = join(
  dirname(require.resolve("@co-engram/claude-code/package.json")),
  "dist",
  "mcp-server.js",
);

/** 隔离环境:独立 HOME(bootstrap config)+ dataRoot,预置一条可检索记忆 */
function makeEnv() {
  const home = mkdtempSync(join(tmpdir(), "attr-home-"));
  const dataRoot = mkdtempSync(join(tmpdir(), "attr-root-"));
  mkdirSync(join(home, ".co-engram"), { recursive: true });
  // bootstrap config:HOME/.co-engram/config.json → dataRoot
  writeFileSync(
    join(home, ".co-engram", "config.json"),
    JSON.stringify({ version: 1, dataRoot }),
  );
  // dataRoot config:关维护/提案/viewer,effectiveness 保持默认开(对照组需要)
  mkdirSync(join(dataRoot, ".co-engram"), { recursive: true });
  writeFileSync(
    join(dataRoot, ".co-engram", "config.json"),
    JSON.stringify({
      version: 1,
      language: "zh",
      maintenance: { enabled: false },
      proposal: { enabled: false },
      viewer: { enabled: false },
    }),
  );
  // 预置记忆(SQLite write-through;用完即关,让 MCP server 独占)
  mkdirSync(join(dataRoot, ".co-engram"), { recursive: true });
  const indexDb = new IndexDb({ dbPath: join(dataRoot, ".co-engram", "index.db") });
  indexDb.open();
  const repository = new EngramRepository(
    { rootPath: dataRoot, language: "zh" },
    indexDb,
  );
  const engram = repository.createEngram({
    title: "部署端口契约",
    content: "viewer 固定 18899,不漂移。",
    summary: "viewer 端口契约",
    kind: "fact",
    domainTags: ["co-engram"],
    createdBy: "attribution-e2e",
  });
  repository.stopWatching();
  indexDb.close();
  new AuditLog(dataRoot); // noop 构造(目录已存在)
  return { home, dataRoot, engramId: engram.id };
}

/** 启动真实 MCP server(stdio)并调 engram_search;返回调用是否成功 */
async function searchViaRealServer(
  env: ReturnType<typeof makeEnv>,
  contemplation: boolean,
): Promise<{ total: number }> {
  const client = new Client(
    { name: "attribution-e2e", version: "0.0.0" },
    { capabilities: {} },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_SERVER_JS],
    env: {
      ...process.env,
      HOME: env.home,
      ...(contemplation ? { [CONTEMPLATION_SESSION_ENV]: "1" } : {}),
    },
  });
  await client.connect(transport);
  try {
    const result = (await client.callTool({
      name: "engram_search",
      arguments: { query: "端口契约", limit: 5 },
    })) as { content?: Array<{ text?: string }>; isError?: boolean };
    const text = result.content?.[0]?.text ?? "";
    if (result.isError) throw new Error(`engram_search error: ${text}`);
    const parsed = JSON.parse(text) as { total: number };
    return { total: parsed.total };
  } finally {
    await client.close();
  }
}

/** 读记忆当前 retrievalCount(经 repository 读 frontmatter) */
function readRetrievalCount(env: ReturnType<typeof makeEnv>): number {
  const indexDb = new IndexDb({
    dbPath: join(env.dataRoot, ".co-engram", "index.db"),
  });
  indexDb.open();
  try {
    const repository = new EngramRepository(
      { rootPath: env.dataRoot, language: "zh" },
      indexDb,
    );
    return repository.readEngram(env.engramId).retrievalCount ?? 0;
  } finally {
    indexDb.close();
  }
}

/** 观察窗文件行数(effectiveness 副作用) */
function windowCount(env: ReturnType<typeof makeEnv>): number {
  const p = join(env.dataRoot, ".co-engram", "observation-windows.jsonl");
  if (!existsSync(p)) return 0;
  return readFileSync(p, "utf-8").split("\n").filter((l) => l.trim()).length;
}

describe("沉思取用归因 端到端", () => {
  it("场景 1:真实 defaultSpawn 给 headless 子进程注入 CO_ENGRAM_CONTEMPLATION_SESSION=1", async () => {
    const out = join(tmpdir(), `attr-env-${process.pid}.json`);
    const fakeClaude = join(tmpdir(), `attr-claude-${process.pid}.cjs`);
    writeFileSync(
      fakeClaude,
      `#!/usr/bin/env node\n` +
        `require("fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.env));\n` +
        `process.stdout.write("done");\n`,
    );
    // spawn(bin, args) 直接执行脚本本身:加 shebang + 可执行位,当 claudeBin 用
    spawnSync("chmod", ["+x", fakeClaude]);
    const task = {
      question: "q",
      seedDigests: [],
      resourceHints: [],
      dreamHistory: "",
      protocol: "",
    } as unknown as NightThinkingTask;
    const executor = createHeadlessExecutor({
      claudeBin: fakeClaude,
      spawnFn: undefined, // 关键:不注入,走真实 defaultSpawn
    });
    // fake 脚本输出非 report JSON,executor 会抛解析错 —— 本场景只验 env,catch 掉
    await executor.execute(task).catch(() => undefined);
    const childEnv = JSON.parse(readFileSync(out, "utf-8")) as Record<
      string,
      string
    >;
    expect(childEnv[CONTEMPLATION_SESSION_ENV]).toBe("1");
  }, 30_000);

  it("场景 2 对照组:无 env 的真实 MCP server,检索计入取用(bump + 观察窗)", async () => {
    const env = makeEnv();
    try {
      const r = await searchViaRealServer(env, false);
      expect(r.total).toBeGreaterThan(0); // 确实命中了预置记忆
      // bump 是 server 内 setImmediate 异步写盘,轮询等它落盘
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(readRetrievalCount(env)).toBe(1);
      expect(windowCount(env)).toBeGreaterThan(0);
    } finally {
      rmSync(env.home, { recursive: true, force: true });
      rmSync(env.dataRoot, { recursive: true, force: true });
    }
  }, 60_000);

  it("场景 2 归因组:env 标记的真实 MCP server,同检索零取用副作用", async () => {
    const env = makeEnv();
    try {
      const r = await searchViaRealServer(env, true);
      expect(r.total).toBeGreaterThan(0); // 检索结果完整(引用闭合闸不受影响)
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(readRetrievalCount(env)).toBe(0); // 冷却榜/hotness 输入不被污染
      expect(windowCount(env)).toBe(0); // effectiveness 分母不被 inconclusive 窗稀释
    } finally {
      rmSync(env.home, { recursive: true, force: true });
      rmSync(env.dataRoot, { recursive: true, force: true });
    }
  }, 60_000);
});
