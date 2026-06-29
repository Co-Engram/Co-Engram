/**
 * Loader 入口(Task 1.5)
 *
 * 用户友好的 config 加载 API。背后复用 `normalizeConfig` / `fillDefaults`,
 * 但接口形状更友好:接受 `Partial<TeamMemoryConfig>`(可省略 version / 任意子系统字段)。
 *
 * @module @co-engram/core/config/loader
 */

export {
  loadConfig,
  normalizeConfig,
  createDefaultConfig,
  readTeamMemoryConfig,
  writeTeamMemoryConfig,
  loadAndSelfHealConfig,
  resolveConfigPath,
  TEAM_MEMORY_CONFIG_FILENAME,
  type LoadResult,
} from "./index.js";
