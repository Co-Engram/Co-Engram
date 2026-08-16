# @co-engram/dsh

[English](README.md) | 中文

[Co-Engram](https://github.com/Co-Engram/Co-Engram) 团队记忆的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 原生 Cordis 插件。

- **38 个记忆工具注册到 `ctx.tools`**,裸名形态（`engram_search`、`engram_create`……）——与 Claude Code 宿主同一套工具。
- **动态 `memory:co-engram` system prompt 段**（order 120）：topTags、技能清单、目录概览、待审候选数在**每次** prompt 组装时重新求值——写入一条记忆,下一条消息即生效。
- **进程锁共存**：与 Claude Code（MCP）/OpenClaw 宿主共享同一 dataRoot;后台维护与网页 viewer 由唯一的 holder 进程运行。

## 安装

```bash
dsh plugin --profile <name> add @co-engram/dsh
```

仅此一步——包内声明了 `dsh.bundle` patch,插件自动激活为 profile 层,无需手改 `cordis.patch.yml`。首次使用需把 co-engram 指向数据仓（与其他宿主共享）：

```bash
npm install -g @co-engram/claude-code   # 提供 `co-engram` CLI
co-engram config data-root $HOME/team-memory
```

## 配置（全部可选）

```yaml
- id: co-engram
  name: '@co-engram/dsh'
  config:
    language: zh            # 或 en —— 工具描述与 prompt 语言
    startMaintenance: true  # 后台维护(强化/遗忘/巩固)
    proposalEnabled: true   # 隐式捕获提案引擎
    startViewer: true       # 网页 viewer(默认跟随 proposalEnabled;holder 门控,端口 18899)
    defaultCreatedBy: ''    # 默认创建者兜底(默认取 git author)
```

完整参考见 [docs/host-dsh.zh-CN.md](../../docs/host-dsh.zh-CN.md)。

## 与 MCP 桥接路径的对比

| | MCP 桥接（`dsh-mcp-client`） | 本插件 |
|---|---|---|
| 工具名 | `mcp__co-engram__*` | 裸名 `engram_*` |
| prompt 引导 | server instructions **不被桥接**——signals 丢失 | 原生动态段,每次组装求值 |
| Claude Code hooks 副作用 | 有（会 auto-install 到 `~/.claude/settings.json`） | 无 |

## 许可证

MIT
