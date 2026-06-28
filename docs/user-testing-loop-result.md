# Co-Engram 用户测试循环结果（25 轮）

> 2026-06-28 完成的 25 轮"挑剔用户视角"全链路模拟测试。
> 模拟画像：不懂插件/MCP 技术细节，任何问题都会弃用的挑剔用户。
> 测试方法：真实编译 dist/ + 真实启动 mcp-server / openclaw adapter + 真实调用工具。

## 总览

| 维度 | 数值 |
|---|---|
| 总轮数 | 25（含 24a/b/c/d/e 5 个挑剔用户场景） |
| 发现总数 | 102 |
| P0（阻塞性） | 29 |
| P1（严重） | 60+ |
| P2（改进） | 50+ |
| 分析行数 | 3024 |
| 待办条目 | 200+ |

## P0 阻塞性问题清单（按修复优先级）

### 1. 用户首次安装即失败（Loop 24a）

- **发现 218** — README 写 `co-engram config data-root`，实际命令是 `co-engram init`，配置文件位置不一致（~/.co-engram/ vs dataRoot/.co-engram/）
- **发现 219** — mcp-server 找 `~/.co-engram/config.json`，但 init 写在 `<dataRoot>/.co-engram/config.json`
- **发现 220** — mcp-server 静默修改 `~/.claude/settings.json`，用户无感知
- **发现 221** — viewer 端口冲突时 proposal engine 静默失效（18799 vs 18804 不一致）
- **发现 222** — git pull 失败但程序继续，用户看到 "Command failed" 慌乱
- **发现 223** — engram_create kind 枚举不含 `decision`，README 示例暗含 decision

### 2. 多人协作丢工作（Loop 24b）

- **发现 231** — 并发 update 无乐观锁，后写覆盖前写
- **发现 232** — updatedBy 必填但 createdBy 有 fallback，不一致
- **发现 233** — engram_update 用 `kinds`（复数），engram_create 用 `kind`（单数）
- **发现 234** — merge driver 对 content 冲突直接选 ours，无 LLM 仲裁，feature 工作丢失
- **发现 235** — engram-index.json 无专用 merge driver，留下冲突标记
- **发现 236** — merge driver 配置必须手工，首次安装未自动完成

### 3. 跨宿主工具集不对称（Loop 24c）

- **发现 242** — README 未明示双宿主可共享 dataRoot
- **发现 243** — Claude Code 16 工具 vs OpenClaw 22+ 工具，差异未文档化
- **发现 244** — OpenClawToolDescriptor.execute 签名与 core Tool 不一致，第三方扩展无文档

### 4. 长期使用脏数据（Loop 24d）

- **发现 251** — listEngrams() 不返回 status，archive/forget 看似无效
- **发现 252** — engram-index.json 未存 status/importance/freshness，过滤需 N 次 IO
- **发现 253** — engram_list tool 无 statusFilter 参数
- **发现 254** — runDoctor 不可用（export 缺失）
- **发现 255** — .trash/ 目录从未创建，forgotten engram 文件散落

### 5. 离线+恢复（Loop 24e）

- **发现 264** — LlmNecessityEvaluator LLM 不可达时抛 JS 内部错误
- **发现 265** — LLM 失败无 fallback 到 rule-based evaluator
- **发现 266** — 语言切换静默迁移 500+ 文件，git diff 一片红

### 6. 核心引擎层（Loop 16-20）

- **发现 141** — zh.ts 7 处未转义双引号，dist/i18n/zh.js 语法错误，整个 @co-engram/core ESM 加载失败
- **发现 124** — applyRpeUpdate 未传递 importanceDelta，重要性永不增长
- **发现 125** — DreamingScheduler.trigger("rem") 同步返回占位符，真实结果丢失
- **发现 126** — LocalHeuristicPatternAbstraction 生成低质量 "Pattern: deploy / nodejs / how" engram
- **发现 156** — deriveDefaultPath 路径遍历漏洞（domainTags='../../../etc' 可逃逸 dataRoot）
- **发现 158/159** — zh 模式文件结构正文在前 + 中文键，破坏标准 markdown 工具兼容性
- **发现 172** — slugify 无长度上限，长标题触发 ENAMETOOLONG

### 7. CI / 供应链（Loop 21-22）

- **发现 181** — i18n 测试无 zh/en parity 检查，zh.ts 语法错误绕过 CI
- **发现 182** — format:check continue-on-error: true，格式错误不阻断
- **发现 183** — release.yml 无 version bump 流程，无 changesets，包版本不一致
- **发现 194** — openclaw-plugin 缺 @openclaw/plugin-sdk peerDependency

### 8. 插件 SDK（Loop 23）

- **发现 206** — createCoEngramContext vs createCoEngramMcpServer 90% 重复，维护双写

## P1 严重问题（节选）

完整列表见 `/tmp/co-engram-loop/todos.md`。重点：

- 维护引擎 audit 未写入（发现 127）
- SearchOrchestrator FTS 不索引 content（发现 142）
- 三因子打分 importance 权重过低（发现 144，20% vs 时效性 30%）
- estimateViewSize 中文严重低估（发现 174，contentSize/2）
- adaptiveDisclosure 阶段 4 无自动触发（发现 175）
- collectIncoming 全量扫描（发现 177）
- CI 无 Windows、无 coverage、无 SBOM（发现 185-189）
- 无 dependabot、无 engine-strict（发现 197-198）
- installer.ts 无备份、HOOK_MARKER 过宽（发现 210-211）
- observe.py 用 Python 但无依赖声明（发现 209）
- 双宿主默认语言不一致（发现 250，CC=en / OC=zh）
- audit.jsonl / signals.jsonl 无 rotation（发现 259-260）

## 修复策略

### Phase 1：阻塞用户首次使用（P0 前 7 项）
1. 修复 zh.ts 7 处未转义双引号（发现 141）
2. 修复 README + CLI 一致性（发现 218-223）
3. 修复 config.json 位置统一（发现 219）
4. 修复 viewer 端口冲突 fallback（发现 221）
5. 修复 git pull 静默失败（发现 222）
6. 修复 engram_create kind 枚举（发现 223）
7. 修复 slugify 长度上限（发现 172）+ 路径遍历（发现 156）

### Phase 2：核心引擎正确性
1. 修复 applyRpeUpdate importanceDelta（发现 124）
2. 修复 DreamingScheduler.trigger 占位符（发现 125）
3. 修复 REM 低质量 pattern（发现 126）
4. 修复 zh 模式文件结构（发现 158/159）
5. 修复 listEngrams status 字段（发现 251-253）
6. 修复 engram_index.json 字段缺失（发现 252）
7. 修复 runDoctor export（发现 254）

### Phase 3：多人协作
1. 引入乐观锁（发现 231）
2. 统一 kind 字段命名（发现 233）
3. 修复 updatedBy fallback（发现 232）
4. merge driver 增加 engram-index.json 合并（发现 235）
5. merge driver content 冲突调用 LLM arbiter（发现 234）
6. auto-onboard 自动配置 merge driver（发现 236）

### Phase 4：CI / 供应链
1. i18n parity 测试（发现 181）
2. format:check blocking（发现 182）
3. changesets + version bump（发现 183）
4. openclaw-plugin peerDependency（发现 194）
5. engine-strict + .npmrc（发现 197-198）
6. 抽出 createCoEngramContext 共享（发现 206）

### Phase 5：用户体验
1. 双宿主工具集对齐（发现 243）
2. 双宿主默认语言统一（发现 250）
3. 跨宿主迁移文档（发现 248）
4. 离线场景 git pull 静默跳过（发现 268）
5. LLM 失败降级（发现 265）
6. 语言切换迁移确认（发现 266）

## 详细数据

- 完整分析：`/tmp/co-engram-loop/analysis.md`（3024 行）
- 完整待办：`/tmp/co-engram-loop/todos.md`（417 行）
- 测试脚本：`/tmp/co-engram-loop/{path,search,maint,rem,disclosure}-bench.mjs`

