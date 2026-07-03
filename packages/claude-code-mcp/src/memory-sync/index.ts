/**
 * Claude Code auto-memory → co-engram proposal 同步模块
 *
 * 监听 Claude Code 在 `~/.claude/projects/<encoded-cwd>/memory/*.md` 下写入的
 * 自动记忆,实时同步为 co-engram **proposal**(候选提案) —— 用户/LLM 通过
 * `engram_accept_proposal` 主动审批后才成为 engram。
 *
 * 这统一了候选入口:auto-memory 不再绕开 ProposalEngine 的「候选 → 审批 → engram」
 * 语义,避免未审核内容直接污染检索池。
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

