/**
 * @co-engram/claude-code - Claude Code MCP Server Adapter
 *
 * 把 @co-engram/core 工具暴露为 MCP server，供 Claude Code CLI / Desktop 使用。
 *
 * @module @co-engram/claude-code
 */

export * from "./register.js";
export * from "./tool-profile.js";
export * from "./maintenance-runtime.js";
export {
  ensureDaemon,
  isDaemonDisabledByEnv,
  shutdownDaemon,
  runThinLauncher,
  defaultDaemonLockPath,
  defaultSocketPath,
  hashDataRoot,
  readDaemonLockfile,
  writeDaemonLockfile,
  removeDaemonLockfile,
  isPidAlive,
  DAEMON_PROTOCOL_VERSION,
  type DaemonLockfile,
  type LauncherDecision,
  type ThinLauncherOptions,
} from "./daemon/index.js";
export { buildServerInstructions } from "./instructions.js";
export type { InstructionSessionState } from "./instructions.js";
export * from "@co-engram/viewer";
