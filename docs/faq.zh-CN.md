# 常见问题与故障排查

## 常见问题

### 问:`claude mcp list` 中 co-engram 显示 `✗ Failed to connect`

MCP server 在启动时崩溃。直接运行它以查看错误信息:

```bash
CO_ENGRAM_DATA_ROOT=$HOME/team-memory co-engram-mcp
```

常见原因:

- **Node 版本 < 22.17** —— 用 `node --version` 检查。co-engram 默认的 `sqlite` 搜索引擎需要 Node 22.17+(`node:sqlite` 在 22.17 才稳定);更旧版本会让搜索引擎静默回退到 `memory`。
- **`CO_ENGRAM_DATA_ROOT` 是相对路径** —— 必须是绝对路径(例如 `/home/you/team-memory`,在某些 shell 中不能写 `~/team-memory`)
- **数据目录不是 Git 仓库** —— `cd ~/team-memory && git init`
- **缺少依赖**(源码构建)—— 在仓库根目录运行 `pnpm install`

### 问:`/mcp` 显示已连接成功,但工具数为 0

OpenClaw manifest 的 `contracts.tools` 数组缺少工具名。如果你是从源码构建,请确认 `packages/openclaw-plugin/openclaw.plugin.json` 列出了全部 31 个条目(29 个原生工具 + 2 个 `memory_*` 包装器)。加载器会静默丢弃未声明的工具。`packages/openclaw-plugin/test/adapter.test.ts` 中有一个 manifest 同步测试,用于防止出现不一致。

### 问:调用某工具时报 `MCP error -32602: Tool <name> not found`

**先检查当前 profile 是否暴露了该工具。** 三档 profile 的工具集见 [`packages/core/src/tools/tool-profile.ts`](../packages/core/src/tools/tool-profile.ts) 中的 `PROFILE_TOOL_SETS`(双宿主单一源)。计数通过 `PROFILE_TOOL_COUNTS` 用 `.size` 自动算出,不会静默漂移。

| Profile           | 工具数 | 包含                                                                                                                                                                                                                                                                              |
| ----------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `minimal`         | 12     | engram_search / engram_get / engram_create / engram_update / engram_list / synapse_create / engram_reinforce / engram_report_failure / **engram_list_proposals / engram_accept_proposal / engram_dismiss_proposal**(proposal 处理三件套,保证维护引擎产生的待审核候选始终能闭环)/ `engram_sync` |
| `standard` (默认) | 19     | minimal 全部 + `engram_delete` / `close_learning_loop` / `contradiction_resolve` / `engram_doctor` / `engram_list_paths` / `engram_synthesize` / `engram_audit_query`                                                                                                              |
| `full`            | 29     | 全部原生工具(实验性的 `skill_invoke` 除外,P0 占位实现)                                                                                                                                                                                                                          |

`engram_list_paths` / `engram_doctor` / `engram_synthesize` / `engram_audit_query` 只在 standard 及以上暴露;`close_learning_loop` / `contradiction_resolve` 也是。**proposal 处理三件套(`engram_list_proposals` / `engram_accept_proposal` / `engram_dismiss_proposal`)自 2026-06 起在所有 profile 下都暴露** —— 设计目的是让维护引擎自动产生的待审核候选在任何 profile 下都能闭环处理,不再出现"看得到但处理不了"的矛盾。

如果你在 `minimal` profile 下被指令引导调用了 `engram_doctor` / `engram_list_paths` / `close_learning_loop` 等不暴露的工具,server 会正确返回 "Tool not found" —— 这是预期行为,不是 bug。

**修复路径**:

```bash
# 查看当前 profile
cat ~/team-memory/.co-engram/config.json | grep toolsProfile

# 切换到 standard(编辑配置或通过 viewer 配置面板)
# 然后重启 MCP server
```

或在 viewer 配置面板里把"工具 profile"改为 standard / full,点击"立即重启生效"按钮。

### 问:创建了 engram,但 `engram_search` 找不到

1.x 版本起,`engram_create` 在每次写入后会自动调用 `invalidateSearchIndex`,新 engram 会立即出现在搜索结果里 —— 无需手动重建。

如果跑的是旧版本,或者搜索索引看起来被损坏了,可以强制重建:

```bash
# Delete the derived cache — co-engram rebuilds it on next access
rm -rf ~/team-memory/.co-engram/

# Restart the MCP server (or run /mcp reload in Claude Code) so the
# in-memory FTS index is rebuilt from the refreshed digest.jsonl
```

如果重建后仍然漏掉明显的关键词,请确认查询词确实出现在 engram 的 **content** 里(不只是附件或注释)。FTS 索引覆盖 `title + summary + domainTags + contextTags`;`summary` 在用户未显式提供时默认取 content 的前 200 字符,所以关键信息藏在 200 字之后的超长 engram 可能搜不到 —— 此时请在 `engram_create` 时显式传 `summary` 参数。

### 问:看不到维护引擎的日志

检查维护功能是否确实已启用:

```bash
claude mcp get co-engram
# Verify CO_ENGRAM_MAINTENANCE=1 is in the env list
```

如果缺失,带上该环境变量重新添加 server:

```bash
claude mcp remove co-engram -s user
claude mcp add co-engram -e CO_ENGRAM_MAINTENANCE=1 ... -- co-engram-mcp
```

维护日志会输出到 stderr,带有 `[maintenance]` 前缀。

### 问:在 viewer 配置面板修改了"数据根目录/审计/提案/维护",重启后没生效

**修复(本版本起):** PUT `/api/config` 现在会把整份 config **同时**写入 runtime dataRoot 和 bootstrap 路径(`env CO_ENGRAM_DATA_ROOT` 或 `$HOME/team-memory`)。重启时从 bootstrap 读取,无论 runtime 是否已经切换过路径,都能拿到最新值。

**仍需手动重启:** 这些 `desired*` 字段定义就是"下次启动生效",运行中的实例无法热切换。两种重启方式:

1. **viewer 内的"立即重启生效"按钮**(配置面板保存后出现):触发 `POST /api/restart`,服务优雅退出(退出码 0),由父进程(通常是 Claude Code)自动重启。悬停 tooltip 详细说明了影响范围(MCP 工具短暂断开、浏览器自动刷新、数据不丢)。
2. **手动重启 Claude Code / MCP server**:效果相同。

如果按了按钮后页面长时间不恢复(>30s),说明父进程没有 supervision 机制——检查 Claude Code 是否在管理该 MCP server,或手动 `claude mcp restart co-engram`。

### 问:`engram_create` 返回 `status: "DUPLICATE"`,但我期望的是 `"NEW"`

去重逻辑找到了内容非常相似的现有 engram(余弦相似度 > 阈值)。当 `dedupe: true`(默认)时,重复项会强化原条目,而不是创建新条目。

强制创建:

```
engram_create({ ..., dedupe: false })
```

或者修改内容,使其相似度低于阈值。

### 问:强化分数一直停在 0

检查信号汇中是否有事件:

```bash
wc -l ~/team-memory/.co-engram/signals.jsonl
```

如果为 0,说明 agent 没有产生 `ToolCallEvent`。常见原因:

- adapter 没有将 `signalSink` 注入到 `ToolContext`(MCP 和 OpenClaw 的 adapter 会自动注入)
- agent 实际上没有调用 co-engram 工具(通过 `/mcp` 查看工具调用情况来确认)

如果文件中有事件但分数没有更新,可能是浅层阶段没有在运行。参见 [maintenance-engine.md](./maintenance-engine.zh-CN.md#troubleshooting)。

### 问:我的数据仓库变得很大

检查是什么占用了空间:

```bash
du -sh ~/team-memory/*
du -sh ~/team-memory/.co-engram/
du -sh ~/team-memory/.trash/ 2>/dev/null
```

如果 `.co-engram/` 很大,直接删除 —— 它是可以重建的缓存。

如果 engram 树很大,请启用回收站清理,让被遗忘的 engram 进入隔离区:

```bash
# In your MCP env:
CO_ENGRAM_TRASH_ENABLED=1
CO_ENGRAM_TRASH_AFTER_DAYS=30         # move to .trash/ after 30 days forgotten
CO_ENGRAM_TRASH_PURGE_AFTER_DAYS=365  # physically delete after 1 year in trash
```

被遗忘的 engram 将在下一个深度维护周期迁移到 `.trash/YYYY-MM/`,保持活动树的精简。通过 `engram_restore` 始终可以恢复 —— 它会自动在 `.trash/` 中找到对应 engram。

对于极端规模(>100k engram),可考虑使用 Git LFS,或按领域拆分为多个数据仓库。

### 问:我想立即永久删除一条记忆

你有三种选项,按谨慎程度递减排列:

1. **遗忘(默认):** 调用 `engram_forget` —— engram 仍保留在磁盘上(Git 追踪),但从检索中排除。
2. **回收站(恢复窗口):** 启用 `CO_ENGRAM_TRASH_ENABLED=1` —— 被遗忘的 engram 在 `CO_ENGRAM_TRASH_AFTER_DAYS` 后移入 `.trash/YYYY-MM/`,并在 `CO_ENGRAM_TRASH_PURGE_AFTER_DAYS` 后被清除。
3. **立即删除:** 调用 `engram_delete` —— 移除 engram 文件并清理悬空的 synapse。除非通过 Git 历史,否则不可恢复。

### 问:可以使用多个数据仓库吗?

可以。每个 MCP server 实例指向一个 `CO_ENGRAM_DATA_ROOT`。以不同的名称运行多个 server:

```bash
claude mcp add co-engram-work \
  -e CO_ENGRAM_DATA_ROOT=$HOME/team-memory-work \
  -- co-engram-mcp

claude mcp add co-engram-personal \
  -e CO_ENGRAM_DATA_ROOT=$HOME/team-memory-personal \
  -- co-engram-mcp
```

工具会以 `mcp__co-engram-work__*` 和 `mcp__co-engram-personal__*` 的命名空间出现。

### 问:能在多台机器之间同步 team-memory 仓库吗?

可以 —— 它是一个标准的 Git 仓库。推送到私有 remote,然后在其他地方克隆:

```bash
# On machine A
cd ~/team-memory
git remote add origin git@github.com:you/team-memory.git
git push -u origin main

# On machine B
git clone git@github.com:you/team-memory.git ~/team-memory
```

`.co-engram/` 缓存会在首次搜索时自动重建。

### 问:Co-Engram 能离线工作吗?

可以。所有操作都是本地的:

- FTS 索引是基于 `digest.jsonl` 在内存中构建的倒排索引,每次搜索都会重建
- LLM 必要性评估是**可选**的 —— 不配置 provider 时,proposal engine 走规则版评估器,零 LLM 调用
- REM 抽象在配置了 LLM 客户端时使用 `LlmPatternAbstraction`(与 `engram_synthesize` 工具共享 prompt);未配置时回退到 `LocalHeuristicPatternAbstraction`(基于 token 频率的启发式,零 LLM 调用)

### 问:为什么我的对话没有生成 proposal?

proposal engine 使用**双层过滤**挡机械噪音,你的对话可能被某一层拦掉了:

1. **Layer 1 预过滤**(零成本纯规则)挡掉:
   - system 角色消息(设计上不观察)
   - 空消息 / 仅标点
   - user 短消息(< 30 chars,assistant < 15 chars)
   - trivial 主导(中英文 trivial 词占比 > 60%,如 `ok ok ok` / `好的 好的`)
   - 低信息密度(去停用词后有效 token < 4,如全停用词长字符串)

2. **Layer 2 必要性评估**(cluster 晋升前)挡掉:
   - 完全雷同(5 次都是同一条原文,如自动重试)
   - 高重复率(uniqueRatio < 0.5)
   - 平均长度 < 30 chars
   - 信息密度 < 5 tokens
   - 70%+ samples 是 trivial

3. **归簇失败**:hash embedder 把不同措辞的样本分到多个 cluster,任一 cluster 都没达到 `threshold=3`。需要让样本措辞更相似(共享关键词结构)。

**调试方法**:在 `~/team-memory/.co-engram/audit.jsonl` 查 `necessity_rejected` 事件:

```bash
grep '"necessity_rejected"' ~/team-memory/.co-engram/audit.jsonl | tail -10
```

每条事件含 `rule` + `reason`,标明是哪条规则拒的、为什么。Layer 1 预过滤(`noise_filtered`)是静默丢弃的 —— 它每条消息都可能触发,不进 audit。详见 [observability 双层过滤](./observability.zh-CN.md#proposal-引擎)。

### 问:proposal 的 `necessityReason` 显示 `[llm-unavailable, rule-fallback]` 怎么办?

这说明 LLM 评估器调用了但失败,自动 fallback 到规则版。常见原因:

- `~/.openclaw/openclaw.json` 配置的 model 是 reasoning 模型(Qwen3 / DeepSeek-R1 / DeepSeek-V4 / GLM-5.2 等),reasoning 阶段用光了 `max_tokens`,content 字段为空 → 检查并升级到最新版(适配器会 fallback 读 `reasoning_content`)
- API key 失效 / 端点不通 → 用 curl 直接测端点确认
- LLM 返回的不是合法 JSON → 升级到能稳定输出 JSON 的模型

规则版兜底保证了 proposal engine 始终可用,但你失去了 LLM 的语义判断能力和 `suggestedTitle` 草稿。

### 问:启动时警告 `viewer.port=... from persisted config is deprecated`

持久化的 `~/team-memory/.co-engram/config.json` 在两个宿主间共享 —— 如果你让 Claude Code 和 OpenClaw 同时指向同一个 data repo,且都读到一个硬编码的 `viewer.port`,就会冲突。这个废弃提示引导你改用环境变量覆盖:

- **自 2026-07 起两宿主共用统一默认 `18899`**(原 host-specific 默认 Claude Code=18799 / OpenClaw=18899 已弃用)。
- **想同时跑两个独立 dataRoot?** 在其中一端设 env `CO_ENGRAM_VIEWER_PORT=19000 co-engram-mcp`(或任意空闲端口)避免冲突。

持久化值本次发布仍作 fallback 生效;这行警告只是提示,不是故障。

### 问:启动时警告 `engram <id>: aliases field stripped`

`aliases` frontmatter 字段是历史遗留 —— Co-Engram 现在用文件名(slug)作为 wikilink 目标,`aliases` 不再生效。store 在读取时遇到非空 `aliases` 数组会先打印一行警告再剥离(以前静默剥离,让手动加过 `aliases` 的用户很困惑)。

要消除警告:把 engram frontmatter 里的 `aliases:` 字段删掉。跑一次 `engram_doctor` 会批量重写所有 engram,清理整个仓库的该字段。

### 问:看不到 Claude Code auto-memory 的 pending proposal

watcher 启动时会打印这一行日志:

```
[co-engram] auto-memory sync: watching /home/you/.claude/projects (initial: 12 files, 5 proposed, 0 updated)
```

如果看不到,按顺序排查:

- **被 env 关闭**:`CO_ENGRAM_AUTO_MEMORY_SYNC=0` 优先级最高。从 MCP 的 env 块里删掉它。
- **被 config 关闭**:`.co-engram/config.json` 里 `autoMemorySync.enabled: false`。删掉这行或改回 `true`。
- **`HOME` 未设置 / projects 根目录非默认**:watcher 默认走 `$HOME/.claude/projects`。如果 `$HOME` 为空,显式设 `CO_ENGRAM_CLAUDE_PROJECTS_ROOT=/home/you/.claude/projects`。
- **宿主不对**:OpenClaw 不启动这个 watcher。必须用 `@co-engram/claude-code`(MCP server)才能享受同步。
- **watcher 启动了但单条文件没同步**:watcher 去抖 500ms。如果你刚写完文件立刻 `engram_list_proposals`,稍等一下再看。同时 `MEMORY.md`(索引文件)按设计就被忽略 —— 只同步单独的 `.md` 文件。

每条 pending proposal 都带 `source: "auto-memory"` 和预填 payload(`proposedTitle`、`proposedContent`、`proposedDomainTags`)。列出并分诊:

```
engram_list_proposals({ includeAll: true })
```

随后 accept(创建 engram,无需重复填字段)或 dismiss:

```
engram_accept_proposal({ entityId: "am:<slug>" })
engram_dismiss_proposal({ entityId: "am:<slug>" })
```

accept 之后,engram 会带 `domainTag` `claude-code-auto-memory`,可在 `engram_search` 里过滤。每条镜像 proposal 还带 `encodingContext` `claude-code-auto-memory:<slug>`。在 Claude Code 里编辑源 memory → 对应 **pending proposal** 的 payload 被更新;**已 accept 过的 proposal 不会被重开**。删除源文件目前不会删除 proposal/engram(想清掉,显式调 `engram_dismiss_proposal` / `engram_forget`)。

### 问:如何完全重置?

```bash
# Stop the MCP server (restart Claude Code after)
claude mcp remove co-engram -s user

# Delete data
rm -rf ~/team-memory/

# Uninstall
npm uninstall -g @co-engram/claude-code
```

## 性能

### `engram_search` 慢

对于超过 1 万个 engram 的数据仓库:

- 允许内存索引预热 —— 启动后的首次搜索会从 `digest.jsonl` 重建(约每 1k engram 100ms)
- 使用 `filter.domainTags` 缩小搜索范围
- 减小 `limit`(默认 20 通常足够)

### 维护运行慢

REM 阶段在大型仓库上可能较慢(它会对每个 engram 打分)。如果耗时超过 30s:

- 减小 `CO_ENGRAM_MAINTENANCE_REM_INTERVAL_MS`(频率降低但单次成本不变)
- 或禁用 REM:`CO_ENGRAM_MAINTENANCE_ENABLED_STAGES=light,deep`

## 获取帮助

- [GitHub Issues](https://github.com/co-engram/co-engram/issues) —— Bug 报告、功能请求
- [GitHub Discussions](https://github.com/co-engram/co-engram/discussions) —— 提问、使用帮助
- [SECURITY.md](../SECURITY.md) —— 用于安全敏感的报告

提交 issue 时,请包含:

- Co-Engram 版本(`npm list -g @co-engram/claude-code`)
- Node 版本(`node --version`)
- 宿主(Claude Code / OpenClaw / 自定义)
- 数据仓库大小(`find ~/team-memory -name "*.md" -not -path "*/.co-engram/*" -not -path "*/.trash/*" | wc -l`)
- 相关日志(在前台运行 `co-engram-mcp` 以捕获 stderr)
