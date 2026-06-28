/**
 * Claude Code auto-memory → co-engram 同步模块
 *
 * 监听 Claude Code 在 `~/.claude/projects/<encoded-cwd>/memory/*.md` 下写入的
 * 自动记忆,实时同步为 co-engram engram。这让 co-engram 不必等用户手动调用
 * `engram_create` 就能感知 Claude Code 已捕获的偏好、决策、教训。
 *
 * 仅 @co-engram/claude-code 使用 —— OpenClaw 没有"自动记忆写入器"的等价物,
 * 不需要本模块(详见 mcp-server.ts 集成点的注释)。
 *
 * @module @co-engram/claude-code/memory-sync
 */

export {
  parseAutoMemoryContent,
  parseAutoMemoryFile,
  isAutoMemoryFileName,
} from "./memory-parser.js";
export type {
  AutoMemoryType,
  ParsedAutoMemory,
} from "./memory-parser.js";

export {
  AutoMemorySyncEngine,
  AUTO_MEMORY_DOMAIN_TAG,
  AUTO_MEMORY_ENCODING_PREFIX,
  encodingContextFor,
  mapAutoMemoryType,
  renderAutoMemoryContent,
} from "./sync-engine.js";
export type {
  SyncAction,
  SyncResult,
  SyncBatchStats,
} from "./sync-engine.js";

export { AutoMemoryWatcher } from "./memory-watcher.js";
export type { WatcherStartResult } from "./memory-watcher.js";
