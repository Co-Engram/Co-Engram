# 迁移指南

介绍如何跨版本升级 Co-Engram,以及升级时会破坏哪些行为。

## 版本策略

Co-Engram 遵循 [语义化版本](https://semver.org/):

- **MAJOR**(1.x → 2.x):对工具 API、数据格式或配置 schema 的破坏性变更
- **MINOR**(0.1.x → 0.2.x):新功能、新工具、向后兼容的变更
- **PATCH**(0.1.0 → 0.1.1):仅修复 bug

在 `0.x` 阶段,**minor 版本升级可能包含破坏性变更**。生产环境请锁定到精确版本:

```bash
npm install @co-engram/core@0.1.0  # 精确版本
# 而不是
npm install @co-engram/core@^0.1.0  # 可能拉取带破坏性变更的 0.2.0
```

## 数据格式兼容性

engram 文件格式(单个 `.md`,含 YAML frontmatter + Markdown 正文,加上每条边的 synapse YAML)被设计为向前兼容:

- **新增的 YAML 字段** 是附加性的 —— 旧代码会忽略未知字段
- **移除的 YAML 字段** 会留下孤儿数据 —— 新代码会忽略它们
- **重命名的 YAML 字段** 需要迁移脚本(我们会提供)

若未来版本以不兼容方式更改 YAML schema,release notes 会附带一条迁移命令。

## 升级

### 升级 MCP server(Claude Code)

```bash
npm update -g @co-engram/claude-code
# 或
npm install -g @co-engram/claude-code@latest

# 重启 Claude Code 以加载新 server
```

你的数据仓库不受影响,现有 engram 继续可用。

### 升级 OpenClaw 插件

```bash
cd ~/.openclaw/extensions/co-engram
npm update @co-engram/openclaw
# 重启 OpenClaw gateway
```

### 升级 `@co-engram/core`(内嵌使用)

```bash
npm install @co-engram/core@latest
# 查看 CHANGELOG 中的破坏性变更
pnpm test  # 运行你的测试套件
```

## 自愈

Co-Engram 内置一个自愈工具,可自动处理大多数漂移:

```bash
# 通过 MCP / OpenClaw 工具调用
engram_doctor({ incremental: false })
```

`engram_doctor` 检测并自动修复:

- **被移动的文件** —— 路径变更;重新指向索引
- **被重命名的标题** —— 通过重新 slug 化重命名文件
- **缺失的文件** —— 索引项指向已删除的文件;清除该条目

以下问题仅报告、不自动修复:

- `slug_conflict` —— 新 slug 会与另一文件冲突
- `orphan_markdown` —— 不带 frontmatter 的 Markdown 文件
- `dangling_synapse` —— synapse 引用了缺失的 engram

任何手动文件操作(移动、重命名、删除)后请运行 `engram_doctor`,以保持缓存同步。

## 破坏性变更策略

当破坏性变更不可避免时:

1. 至少提前一个 minor 版本在 **CHANGELOG.md 中公告**
2. **提供迁移脚本**(尽可能自动化,否则文档化)
3. **保留旧行为可用**,并附带 deprecation 告警,至少持续 3 个月
4. 在移除旧行为时 **升级 MAJOR 版本**

## 版本兼容性矩阵

| Core 版本 | MCP 适配器 | OpenClaw 适配器 | 数据格式 |
| --------- | ---------- | --------------- | -------- |
| 0.1.x     | 0.1.x      | 0.1.x           | 稳定     |

旧适配器或许能配合新 core 运行(向前兼容),但我们不做测试。新适配器不一定能配合旧 core 运行。

## 回滚

若升级导致故障:

```bash
# 锁定到先前版本
npm install -g @co-engram/claude-code@0.1.0

# 数据仓库不受影响 —— 无需回滚
# 重启 Claude Code
```

若升级写入了旧版本无法读取的新格式数据,请提交 issue。我们会提供降级迁移。

## 反馈问题

若升级破坏了你的工作流:

1. 查阅 [CHANGELOG.md](../CHANGELOG.md) 中已记录的变更
2. 查看 [既有 issue](https://github.com/co-engram/co-engram/issues)
3. 提交新 issue,包含:旧版本、新版本、错误消息、数据仓库规模(`find ~/team-memory -type f | wc -l`)
