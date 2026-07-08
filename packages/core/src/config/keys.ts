/**
 * Config key catalog（runtime metadata describing writable keys in TeamMemoryConfig）
 *
 * 给 `co-engram config set <key> <value>` 提供：
 *   1. 校验 dotted key path 在 schema 中存在
 *   2. 把 raw string 值按声明类型 coerce（boolean / number / object / string）
 *   3. 列出所有可写 key 给 help 模式
 *
 * 手工维护，镜像 {@link TeamMemoryConfig} interface。drift 由
 * `packages/core/test/config-keys.test.ts` 守护（它直接读 types.ts 比对）。
 *
 * 设计权衡：TS interface 无运行时反射，无法「真正自动生成」。两个候选方案：
 *   - 把 TeamMemoryConfig 重写为 Zod schema → 自动派生 type + catalog（侵入大，
 *     需要改 100+ 处 import；ROI 不在本次 AI-3c 范围）
 *   - 维护显式 catalog（本文件） → 简单、可测、可文档化
 *
 * 选后者。catalog drift 用单测兜底。
 *
 * @module @co-engram/core/config
 */

export type ConfigKeyType = "string" | "number" | "boolean" | "object";

export interface ConfigKeyMeta {
  readonly type: ConfigKeyType;
  readonly description: string;
  /** 若为 true，`config set` 拒绝写入，提示用户用替代方案 */
  readonly deprecated?: boolean;
  readonly deprecatedReason?: string;
}

/**
 * 全量可写 key 字典。
 *
 * **新增 subsystem 时同步扩展本字典**——`config-keys.test.ts` 会在 catalog
 * 与 schema 不一致时报错。
 */
export const CONFIG_KEY_CATALOG: Readonly<Record<string, ConfigKeyMeta>> = {
  // === 顶级 scalar ===
  language: {
    type: "string",
    description: "UI / 工具描述语言：'en' | 'zh'",
  },
  defaultCreatedBy: {
    type: "string",
    description: "新建 engram 的默认作者标识",
  },
  toolsProfile: {
    type: "string",
    description: "MCP 工具暴露 profile：'minimal' | 'standard' | 'full'",
  },
  migratedToLanguage: {
    type: "string",
    description: "已迁移到的磁盘字段语言格式（避免重复 migrate）",
  },

  // === necessityLlm ===
  "necessityLlm.apiKey": {
    type: "string",
    description: "必要性评估 LLM 的 API key（env ANTHROPIC_API_KEY 优先）",
  },
  "necessityLlm.model": {
    type: "string",
    description: "必要性评估 LLM 模型名",
  },
  "necessityLlm.endpoint": {
    type: "string",
    description: "自定义 endpoint URL",
  },
  "necessityLlm.headers": {
    type: "object",
    description: '额外 headers（JSON 对象，如 {"X-Custom":"v"}）',
  },

  // === maintenance ===
  "maintenance.enabled": {
    type: "boolean",
    description: "三阶段维护总开关（默认 true）",
  },
  "maintenance.lightIntervalMs": {
    type: "number",
    description: "Light 阶段间隔（毫秒）",
  },
  "maintenance.deepIntervalMs": {
    type: "number",
    description: "Deep 阶段间隔（毫秒）",
  },
  "maintenance.remIntervalMs": {
    type: "number",
    description: "REM 阶段间隔（毫秒）",
  },
  "maintenance.learningRate": {
    type: "number",
    description: "importance 学习率",
  },
  "maintenance.enabledStages": {
    type: "object",
    description: '启用的阶段（JSON 数组，如 ["light","deep","rem"]）',
  },
  "maintenance.trash.enabled": {
    type: "boolean",
    description: "启用 trash 清扫（自动 forget 老化 trashed engram）",
  },
  "maintenance.trash.afterDays": {
    type: "number",
    description: "engram 进入 trash 前的等待天数",
  },
  "maintenance.trash.purgeAfterDays": {
    type: "number",
    description: "trashed engram 永久 purge 前的等待天数",
  },

  // === proposals ===
  "proposals.enabled": {
    type: "boolean",
    description: "启用候选记忆捕获",
  },
  "proposals.threshold": {
    type: "number",
    description: "归簇晋升阈值（出现次数）",
  },
  "proposals.similarityThreshold": {
    type: "number",
    description: "余弦相似度阈值 ∈ (0,1]",
  },
  "proposals.maxSamples": {
    type: "number",
    description: "单个 cluster 保留的最大样本数",
  },
  "proposals.minMessageLength": {
    type: "number",
    description: "触发 observe 的最小消息长度",
  },
  "proposals.defaultDismissDays": {
    type: "number",
    description: "dismiss 后多少天内不再提示",
  },

  // === audit ===
  "audit.enabled": {
    type: "boolean",
    description: "启用审计日志写入",
  },
  "audit.rotation.enabled": {
    type: "boolean",
    description: "启用自动轮转清理",
  },
  "audit.rotation.retentionDays": {
    type: "number",
    description: "一般事件保留天数",
  },
  "audit.rotation.highValueRetentionDays": {
    type: "number",
    description: "高价值事件保留天数",
  },
  "audit.rotation.maxSizeMb": {
    type: "number",
    description: "文件大小硬上限（MB）",
  },
  "audit.rotation.intervalMs": {
    type: "number",
    description: "轮转检查间隔（毫秒）",
  },

  // === effectiveness ===
  "effectiveness.enabled": {
    type: "boolean",
    description: "启用有效性追踪",
  },

  // === viewer ===
  "viewer.enabled": {
    type: "boolean",
    description: "启用 web viewer",
  },
  "viewer.url": {
    type: "string",
    description: "viewer 对外可达 URL",
  },
  "viewer.port": {
    type: "number",
    description:
      "（已废弃）—— 两宿主共享 persisted config 时会抢同一端口；改用 env CO_ENGRAM_VIEWER_PORT",
    deprecated: true,
    deprecatedReason:
      "Two hosts (Claude Code + OpenClaw) sharing persisted config would fight over the same port. Use env CO_ENGRAM_VIEWER_PORT for per-host override.",
  },

  // === server ===
  "server.name": {
    type: "string",
    description: "MCP server name（协议身份）",
  },
  "server.version": {
    type: "string",
    description: "MCP server version",
  },

  // === autoMemorySync ===
  "autoMemorySync.enabled": {
    type: "boolean",
    description: "启用 Claude Code auto-memory 同步 watcher",
  },
  "autoMemorySync.projectsRoot": {
    type: "string",
    description: "Claude Code projects 根目录（默认 ~/.claude/projects）",
  },
  "autoMemorySync.debounceMs": {
    type: "number",
    description: "文件变化去抖间隔（毫秒）",
  },

  // === reinforcement ===
  "reinforcement.hebbianRatio": {
    type: "number",
    description: "Hebbian 邻居强化系数 ∈ [0,1]",
  },
  "reinforcement.archiveThreshold": {
    type: "number",
    description: "触发 archive 建议的 failedUses 阈值",
  },
  "reinforcement.forgetThreshold": {
    type: "number",
    description: "触发 forget 建议的 failedUses 阈值",
  },

  // === search ===
  "search.relevance": {
    type: "number",
    description: "relevance 权重（语义/关键词匹配，默认 0.5）",
  },
  "search.recency": {
    type: "number",
    description: "recency 权重（艾宾浩斯衰退，默认 0.2）",
  },
  "search.importance": {
    type: "number",
    description: "importance 权重（价值，默认 0.2）",
  },
  "search.strength": {
    type: "number",
    description: "strength 权重（用户反馈累积，默认 0.1）",
  },

  // === observation ===
  "observation.observation": {
    type: "number",
    description: "observation kind 窗口（毫秒）",
  },
  "observation.fact": {
    type: "number",
    description: "fact kind 窗口（毫秒）",
  },
  "observation.pattern": {
    type: "number",
    description: "pattern kind 窗口（毫秒）",
  },
  "observation.procedure": {
    type: "number",
    description: "procedure kind 窗口（毫秒）",
  },
  "observation.hypothesis": {
    type: "number",
    description: "hypothesis kind 窗口（毫秒）",
  },
};

export function isValidConfigKey(key: string): boolean {
  return key in CONFIG_KEY_CATALOG;
}

export function getConfigKeyMeta(key: string): ConfigKeyMeta | undefined {
  return CONFIG_KEY_CATALOG[key];
}

/**
 * 列出所有可写 key（help 模式用）。deprecated key 也列出，但带标记。
 */
export function listWritableKeys(): ReadonlyArray<{
  readonly key: string;
  readonly type: ConfigKeyType;
  readonly description: string;
  readonly deprecated: boolean;
}> {
  return Object.entries(CONFIG_KEY_CATALOG).map(([key, meta]) => ({
    key,
    type: meta.type,
    description: meta.description,
    deprecated: meta.deprecated ?? false,
  }));
}
