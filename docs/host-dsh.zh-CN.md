# Co-Engram × DeepSeek Harness（dsh）

Co-Engram 为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供原生 Cordis 插件：42 个记忆工具全部注册为 dsh 原生工具（裸名形态,如 `engram_search`）,并注入 `memory:co-engram` system prompt 段——其 signals（topTags／技能清单／目录概览／待审候选数）在每次 prompt 组装时重新求值。

## 安装

```bash
# 一次性:把 co-engram 指向数据仓(各宿主共享)
npm install -g @co-engram/claude-code
mkdir -p $HOME/team-memory && cd $HOME/team-memory && git init
co-engram config data-root $HOME/team-memory

# 把插件装进 dsh profile
dsh plugin --profile <name> add @co-engram/dsh
```

包内声明了 `dsh.bundle` patch,安装即自动激活为 profile 层——无需手改 `cordis.patch.yml`。重启 profile（或重载插件）后,启动日志可见：

```
[co-engram] dsh plugin active: 12 engrams, 42 tools registered (host=dsh-plugin)
```

## 配置

全部字段可选;默认值遵循低摩擦哲学（维护与提案引擎默认开启,viewer 跟随提案引擎）。

| 字段 | 默认 | 说明 |
|---|---|---|
| `language` | `en` | 工具描述与 prompt 语言（中文用 `zh`） |
| `startMaintenance` | `true` | 后台维护运行时（light／deep／REM 三阶段） |
| `maintenanceConfig` | 各阶段默认 | 维护调优（间隔、学习率、回收站） |
| `auditEnabled` | `true` | 审计日志（跨宿主条目携带 `host=dsh-plugin`） |
| `auditRotationConfig` | 内置默认 | 审计日志轮转 |
| `effectivenessEnabled` | `true` | 有效性追踪 |
| `proposalEnabled` | `true` | 隐式捕获提案引擎 |
| `proposalConfig` | 内置默认 | 提案阈值 |
| `autoOnboardMergeDriver` | `true` | 自动向数据仓安装 git merge driver（幂等） |
| `startViewer` | 跟随 `proposalEnabled` | 网页 viewer（holder 门控,默认端口 18899） |
| `viewerToken` | — | viewer 鉴权 token |
| `defaultCreatedBy` | git author | 写操作默认创建者兜底 |

`dataRoot` **不是**插件字段：所有宿主共享 `~/.co-engram/config.json`,由 `co-engram config data-root <path>` 统一管理。

## 与其他宿主共存

本插件与 Claude Code（MCP）／OpenClaw 宿主使用同一把进程锁。holder 进程运行后台维护、审计轮转、文件监听与 viewer;其余进程只服务工具调用。dsh 与 Claude Code 同时挂同一数据仓是设计内用法。

## 原生插件 vs MCP 桥接

dsh 官方 `@deepseek-ai/dsh-mcp-client` 也能桥接 co-engram MCP server（工具名 `mcp__co-engram__*`）。优先使用原生插件：

| | MCP 桥接 | 原生插件 |
|---|---|---|
| 工具名 | `mcp__co-engram__*` | 裸名 `engram_*` |
| prompt 引导 | dsh 不桥接 MCP server instructions——topTags／技能／目录概览丢失 | 原生动态段,每次组装重新求值 |
| Claude Code hooks | MCP 入口会向本机 auto-install Claude Code hooks | 无宿主特有副作用 |
| MCP prompts／resources 能力 | dsh 不消费 | 不适用（原生集成） |

## v0.1 有意不包含

- `necessityLlm`／LLM 版 `engram_synthesize` 客户端——提案引擎回退到规则版必要性评估;后续版本再接 LLM 客户端。
- 启动期 `git pull` 与语言格式迁移（MCP 路径的宿主入口仪式）——仓库 watcher 会感知外部变更;跨机同步时在数据仓里手动 `git pull` 即可。

## 故障排查

- **`Viewer failed to start: EADDRINUSE ... 18899`**——已有 holder（如某个 Claude Code 会话）在跑 viewer。无害：工具服务不受影响;直接打开现有 viewer 即可。
- **插件加载了但没有工具**——用 `dsh --profile <name> --dump-config` 检查 `co-engram` 条目,并看启动日志有无 `[co-engram] dsh plugin active` banner。
