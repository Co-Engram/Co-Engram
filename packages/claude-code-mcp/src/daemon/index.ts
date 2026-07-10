/**
 * Daemon 模块入口 — 统一 export。
 *
 * @module @co-engram/claude-code/daemon
 */

export {
  defaultDaemonLockPath,
  defaultSocketPath,
  hashDataRoot,
  readDaemonLockfile,
  writeDaemonLockfile,
  removeDaemonLockfile,
  isPidAlive,
  DAEMON_PROTOCOL_VERSION,
  type DaemonLockfile,
} from "./protocol.js";

export {
  ensureDaemon,
  isDaemonDisabledByEnv,
  shutdownDaemon,
  type LauncherDecision,
} from "./launcher.js";

export { runThinLauncher, type ThinLauncherOptions } from "./thin-launcher.js";
