#!/usr/bin/env node
/**
 * 独立 viewer 实例(开发/验收用):
 *   - 用本地构建的 @co-engram/claude-code + @co-engram/viewer
 *   - startMaintenance: false —— 不与正在运行的 MCP holder 重复跑维护期
 *   - 默认端口 18898(生产 holder 占 18899),可通过 --port 覆盖
 * 用法:node scripts/standalone-viewer.mjs [--port 18898] [--lang zh]
 */
import { createCoEngramMcpServer } from "../dist/index.js";
import { startViewerServer } from "@co-engram/viewer";

const args = process.argv.slice(2);
const portFlag = args.indexOf("--port");
const langFlag = args.indexOf("--lang");
const port = portFlag >= 0 ? Number(args[portFlag + 1]) : 18898;
const language = langFlag >= 0 ? args[langFlag + 1] : "zh";

const { server, ctx, stopMaintenance, stopAuditRotation, releaseProcessLock } =
  await createCoEngramMcpServer({
    dataRoot: "/home/10192021@zte.intra/AIOS/team-memory/team-memory",
    serverName: "co-engram-standalone-viewer",
    serverVersion: "0.0.0",
    language,
    startMaintenance: false, // 关键:避免与 18899 holder 双跑维护
  });
// 静默 MCP server(本进程只做 viewer,不接 stdio)
await server.close?.().catch(() => {});

const runtime = await startViewerServer(ctx, { port, language });
process.stderr.write(
  `[standalone-viewer] http://127.0.0.1:${runtime.port}  (dataRoot: ${ctx.repository.dataRoot})\n`,
);

const shutdown = async () => {
  await runtime.stop().catch(() => {});
  await stopMaintenance?.().catch(() => {});
  await stopAuditRotation?.().catch(() => {});
  await releaseProcessLock?.().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
setInterval(() => {}, 1 << 30); // keep alive
