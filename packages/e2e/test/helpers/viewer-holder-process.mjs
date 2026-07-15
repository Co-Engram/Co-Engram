#!/usr/bin/env node
/**
 * 多进程 viewer holder gating 测试的子进程(helper)
 *
 * 注册 openclaw plugin + 启 viewer(指定端口),保持运行直到父进程关闭 stdin。
 * 用于验证:同一 dataRoot 上,只有 holder 进程启 viewer;non-holder 不抢端口
 * (否则会 EADDRINUSE 重试到别的端口)。
 *
 * 这是 viewer holder gating 契约唯一能被真正测到的形态 —— 同进程 in-memory
 * 测不出(模块级 viewerRuntime 幂等让第二个 registerCoEngramTools 永远跳过),
 * 端口冲突只在不同 Node 进程间发生。
 *
 * 用法: node viewer-holder-process.mjs <dataRoot> <port>
 */
import { registerCoEngramTools } from "@co-engram/openclaw";

const dataRoot = process.argv[2];
const port = Number(process.argv[3]);
if (!dataRoot || !Number.isFinite(port) || port <= 0) {
  process.stderr.write("usage: viewer-holder-process.mjs <dataRoot> <port>\n");
  process.exit(1);
}

// 最小 host api mock(与 e2e/createMemoryOpenClawHost 同款:只 registerTool)
const tools = new Map();
/** @type {any} */
const api = {
  tools,
  registerTool(tool, opts) {
    tools.set(opts?.name ?? tool.name, tool);
  },
};

try {
  registerCoEngramTools(api, {
    dataRoot,
    startViewer: true,
    viewerConfig: { port },
  });
  process.stderr.write(
    `[viewer-holder-process] registered dataRoot=${dataRoot} port=${port}\n`,
  );
} catch (e) {
  process.stderr.write(
    `[viewer-holder-process] register error: ${e instanceof Error ? e.message : String(e)}\n`,
  );
  process.exit(1);
}

// 保持运行,直到父进程关闭 stdin(测试结束时 kill)
process.stdin.resume();
