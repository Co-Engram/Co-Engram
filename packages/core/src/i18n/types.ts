/**
 * i18n 类型定义
 *
 * @module @co-engram/core/i18n
 */

/**
 * 支持的语言
 *
 * - `en` English(默认,适合国际开源受众)
 * - `zh` 简体中文(适合中文团队)
 *
 * `auto` 仅在配置层接受(运行时会被解析为具体 `en`/`zh`),
 * 不直接进入翻译函数。
 */
export type Language = "en" | "zh";

/**
 * 字符串 key(命名空间.名字)
 *
 * 工具描述: `tool.<tool_name>`
 * 查看器 UI: `viewer.<key>`
 * 系统提示: `prompt.<key>`
 * CLI 输出: `cli.<key>`
 * 枚举显示: `enum.<kind|freshness|status|...>.<value>`
 * 字段标签: `field.label.<name>`
 * 区段标题: `section.<name>`
 * 动作按钮: `action.<name>`
 * 通用文案: `common.<name>`
 * 衰退可视化: `decay.<name>`
 *
 * StringKey 从 zh.ts 字面量推导,新增 key 时若忘记补 zh/en 翻译会在编译期失败。
 */
export type StringKey = keyof typeof import("./zh.js").zh;

/**
 * 翻译字典形状
 */
export type TranslationDict = Readonly<Record<StringKey, string>>;

/**
 * team-memory 持久化配置形状
 *
 * 由 `co-engram init` 写入,启动时读取以恢复用户首次选择。
 * env / host config 可覆盖。
 */
export interface TeamMemoryConfig {
  /** schema 版本 */
  readonly version: 1;
  /** 工具描述、查看器 UI、提示词所用语言 */
  readonly language?: Language;
  /** 默认作者标识(env CO_ENGRAM_DEFAULT_CREATED_BY 优先,此字段为持久默认值) */
  readonly defaultCreatedBy?: string;
  /** 创建时间 ISO */
  readonly createdAt?: string;
  /** 初始化工具版本 */
  readonly initializedBy?: string;
  /**
   * 已迁移到的磁盘字段语言格式
   *
   * 启动时若与 `language` 不一致,host adapter 会触发 `migrateFormat`
   * 把所有 engram/synapse 文件重写为目标语言格式(中文字段名 + 底部 frontmatter),
   * 然后把此字段更新为 `language`,避免重复迁移。
   *
   * 缺失表示从未迁移过(legacy 仓库或首次启用本特性)。
   */
  readonly migratedToLanguage?: Language;
  /**
   * Claude Code MCP 工具暴露 profile
   *
   * 控制 LLM 可见的工具数量('minimal' | 'standard' | 'full')。
   * 由 `co-engram init` 交互写入。其他 adapter(OpenClaw)忽略此字段。
   */
  readonly toolsProfile?: string;

  /**
   * 下次启动期望的运行时状态(viewer-only 持久化)
   *
   * 这些字段由 web viewer 写入,MCP 启动时若对应 env 未设置则作为 fallback。
   * 当前运行时状态由 env + 子系统初始化决定,无法热切换;此处仅表达"下次启动"的意图。
   * viewer 不暴露 viewerEnabled 的编辑(避免 UI 自杀)。
   */
  readonly desiredAuditEnabled?: boolean;
  readonly desiredProposalsEnabled?: boolean;
  readonly desiredMaintenanceEnabled?: boolean;

  /**
   * 下次启动期望的数据根目录(viewer-only 持久化)
   *
   * 启动时 fallback 优先级:env CO_ENGRAM_DATA_ROOT > 此字段 > 默认 $(HOME)/team-memory。
   * 写入此字段不会影响当前运行实例——已加载的 repository/maintainer/viewer 仍指向旧路径,
   * 直到 MCP server 重启。
   *
   * 用途:让用户在 web viewer 里切换数据目录而无需手动改 env / systemd unit / 启动脚本。
   */
  readonly desiredDataRoot?: string;
}
