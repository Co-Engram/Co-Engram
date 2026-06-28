# 快速开始(深入版)

这是扩展版快速开始。3 条命令的精简版本请参阅主 [README](../README.zh-CN.md)。

## 前置条件

- **Node.js 22+** — 使用 `node --version` 检查
- **Git** — 用于数据仓库
- **pnpm** — 仅源码构建需要;npm 用户可跳过
- 支持 MCP 的宿主(Claude Code、Cursor、Continue.dev ……)或 OpenClaw

## 第 1 步:安装 MCP Server

两种方式,任选其一:

### 方式 A:全局安装(推荐)

```bash
npm install -g @co-engram/claude-code
```

这会把 `co-engram-mcp` 可执行文件放到 PATH 中。由于包已经在磁盘上,启动很快。

### 方式 B:通过 npx 免安装

无需安装。`npx -y @co-engram/claude-code` 每次冷启动时拉取包(首次约 2 秒开销)。

## 第 2 步:初始化数据仓库

Co-Engram 把所有记忆存放在一个**独立**的 Git 仓库里。这是一项硬性设计决策 —— 原因见 [design-rationale.md](./design-rationale.zh-CN.md)。

**推荐:使用 `co-engram init`(交互式,带语言选择)**

```bash
co-engram init
# → 提示输入路径(默认:~/team-memory)
# → 提示选择语言(English / 简体中文)—— 控制工具描述、viewer UI 与系统提示
# → 写入 .co-engram/config.json(持久化语言选择)
```

或非交互式:

```bash
co-engram init --path ~/team-memory --language zh --created-by alice
```

**手动替代方案**(跳过 `co-engram init`):

```bash
mkdir -p ~/team-memory
cd ~/team-memory
git init
echo "# Team Memory" > README.md
git add README.md
git -c user.email="$(git config user.email || echo memory@local)" \
    -c user.name="$(git config user.name || echo Local)" \
    commit -m "init team-memory"
```

目录会在首次 `engram_create` 时自动填充。

### 语言选择 —— 为什么重要

你在 `co-engram init` 中选择的语言控制:

- **工具描述** —— LLM 在列出可用工具时看到的内容(Claude Code 中的 `/mcp`)
- **Viewer UI 文案** —— 按钮、标签页、加载提示
- **系统提示注入** —— "3 memory candidates pending" 之类的提示

选择会持久化到 `~/team-memory/.co-engram/config.json`。两种宿主(Claude Code 与 OpenClaw)都会遵循它。

**运行时覆盖**(通过环境变量或 manifest):

```bash
# MCP:环境变量优先级高于持久化配置
claude mcp add co-engram -e CO_ENGRAM_LANGUAGE=zh ...

# OpenClaw:manifest 字段优先级高于持久化配置
# plugins.entries.co-engram.config.language: zh
```

## 第 3 步:接入 Claude Code

```bash
claude mcp add co-engram \
  -e CO_ENGRAM_DATA_ROOT=$HOME/team-memory \
  -e CO_ENGRAM_DEFAULT_CREATED_BY=$USER \
  -e CO_ENGRAM_MAINTENANCE=1 \
  --scope user \
  -- co-engram-mcp
```

验证:

```bash
claude mcp list
# co-engram: ... ✓ Connected

claude mcp get co-engram
# 显示环境变量、命令、作用域
```

## 第 4 步:在新的 Claude Code 会话中冒烟测试

打开一个新的 Claude Code 会话(当前会话不会感知新添加的 MCP server):

```
/mcp
```

你应该看到:

```
co-engram: ✓ Connected
  Tools: 16    # 默认 standard profile;若设置了 CO_ENGRAM_TOOLS_PROFILE,可能是 11(minimal)或 27(full)
```

MCP server 还会向 stderr 写入一行启动信息(可在 `claude mcp logs co-engram` 中查看):

```
[co-engram] Loaded 0 engrams, profile=standard (17/28 tools visible to LLM)
[co-engram] No memories yet — the LLM will start capturing once you discuss decisions, preferences, or lessons learned.
```

如果你跳过了 `co-engram init` 且数据根目录还不存在,第一行将是:

```
[co-engram] Initialized new data repo at /home/$USER/team-memory (no engrams yet — run "co-engram init" to pick a language and configure maintenance)
```

然后尝试创建一条记忆:

> Use co-engram to create an engram with title "First memory", content "Co-Engram is now wired up", kind observation, domainTags ["test"].

Agent 应当调用 `mcp__co-engram__engram_create` 并返回一个 engram ID。验证它已落盘:

```bash
# 文件存储在数据根目录下的 <domainTags>/<slug>.md
find ~/team-memory -name "*.md" -not -path "*/.co-engram/*" -not -path "*/.trash/*"
```

你应该看到每个 engram 对应一个 Markdown 文件,内含 YAML frontmatter(id、title、kind 等)与 Markdown 正文。

## 第 5 步:回检索它

在同一会话中:

> Use co-engram to search for memories about "Co-Engram".

Agent 应当调用 `engram_search` 并找到你刚才创建的 engram。

## 故障排查

### `claude mcp list` 显示 `✗ Failed to connect`

MCP server 启动崩溃。调试:

```bash
CO_ENGRAM_DATA_ROOT=$HOME/team-memory co-engram-mcp
```

直接运行可执行文件 —— 你会看到 stderr。常见原因:

- **Node 版本过旧** —— 需要 Node 22+
- **`CO_ENGRAM_DATA_ROOT` 未设置或不是绝对路径** —— 必须是绝对路径
- **数据目录不是 Git 仓库** —— 在其中运行 `git init`

### `/mcp` 显示 0 个工具,但状态是 `✓ Connected`

manifest 缺少 `contracts.tools` 条目。如果你是从 npm 安装的不应出现此问题 —— 若是从源码构建,请确认 `packages/openclaw-plugin/openclaw.plugin.json` 列出了全部 30 个工具(28 个原生 + 2 个 `memory_*` 包装)。OpenClaw loader 会静默丢弃未声明的工具。

### 工具已注册但调用返回错误

检查数据仓库权限:

```bash
ls -la ~/team-memory
# 应当对运行 Claude Code 的用户可写
```

### 维护引擎未运行

设置 `CO_ENGRAM_MAINTENANCE=1` 并查看日志:

```bash
# 在前台运行 server,启用详细日志
CO_ENGRAM_DATA_ROOT=$HOME/team-memory CO_ENGRAM_MAINTENANCE=1 co-engram-mcp
```

每 5 分钟应出现一次 `[maintenance]` 日志行(light stage 默认)。

## 下一步

- 阅读 [concepts.md](./concepts.zh-CN.md) 了解 engram、synapse 与 skill 是什么
- 阅读 [tool-reference.md](./tool-reference.zh-CN.md) 查看完整工具目录
- 阅读 [maintenance-engine.md](./maintenance-engine.zh-CN.md) 理解自维护闭环
