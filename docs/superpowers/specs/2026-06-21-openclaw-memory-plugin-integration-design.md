# OpenClaw Memory Plugin Integration Design

**Date**: 2026-06-21
**Status**: Approved (v1 + v1.1)
**Author**: Yang Yang

## Context

co-engram 已完成核心功能(25 工具 + 维护引擎 + 双语 i18n)。当前 OpenClaw 集成只暴露 25 个原生工具,**没有声明** `kind: "memory"`,因此:

1. 与 memory-core 并存而非互斥,LLM 看不到统一的 memory section 引导
2. 没有提供 `memory_search` / `memory_get` 兼容工具,无法被 OpenClaw 核心的 memory 调度机制识别
3. co-engram 的 proposal / RPE / metacognition 主动信号没有官方注入路径

本设计让 co-engram 成为 OpenClaw 的**主要记忆插件**(primary memory plugin),与 memory-core 互斥,同时保留全部 25 个原生工具作为高级功能。

## 实证依据

基于对 OpenClaw 仓库的代码调研:

| 事实                                                                                        | 证据                                                                    |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `kind: "memory"` 通过 `applyExclusiveSlotSelection` 互斥                                    | `src/plugins/slots.ts:65-148` — 只看 kind 字段                          |
| memory section 触发条件是 `availableTools.has("memory_search")`                             | `extensions/memory-core/src/prompt-section.ts:3-45`                     |
| flexmem-local 用 `kind: "memory"` + 自己注册 memory_search 工具生效,**完全绕过** capability | `extensions/flexmem-local/plugin-impl.ts:126-198`                       |
| flexmem-local 的提示词通过 `appendSystemContext` 返回值注入                                 | `extensions/flexmem-local/index.ts:1659-1661`                           |
| memory-core 的 promptBuilder 注入 "Mandatory recall step" 文字(约 650 字符)                 | `extensions/memory-core/src/prompt-section.ts`                          |
| memory-core 的工具描述长达 1200+ 字符,大量 AIK/fetchType 领域偏向                           | `extensions/memory-core/src/tools.ts:300-303`                           |
| flexmem-local 有 4 层召回过滤(幂等/长度/相关性/结果数)+ FTS+向量+RRF 两阶段检索             | `extensions/flexmem-local/index.ts:1440-1679`, `recall/engine.ts:50-88` |
| flexmem-local 存了 `last_hit_at`/`merge_count` 但**未用于排序** — 强化闭环没闭合            | `recall/engine.ts`                                                      |
| flexmem-local **无 dreaming/巩固机制** — 即时摄取即时检索                                   | 无定时任务代码                                                          |

## 设计决策

### D1. 采用 flexmem-local 的生效路径(kind + 工具注册),补上 capability(promptBuilder)

- `kind: "memory"` 占互斥槽位
- 注册 `memory_search` / `memory_get` 工具触发系统提示
- **额外**注册 `registerMemoryCapability.promptBuilder` 注入引导文字

理由:flexmem-local 证明了 kind+工具就足够生效,但 co-engram 的 proposal/RPE/metacognition 需要**主动**注入提示,不能像 flexmem 那样完全被动。

### D2. memory_search 工具 schema(简化,隐藏 co-engram 内部术语)

输入:

```typescript
{
  query: string,                    // 自然语言查询
  maxResults?: number = 5,          // 返回上限
  minScore?: number = 0,            // 相关性阈值
}
```

输出:

```typescript
{
  results: Array<{
    id: string; // engram id
    content: string; // 前 500 字摘要
    score: number; // 综合相关性
    metadata: {
      createdAt: string;
      importance: number; // 0-1
      truthScore?: number; // 0-1, co-engram 独有
      tags?: string[];
    };
  }>;
}
```

### D3. memory_get 工具 schema(富结构)

输入:`{ id: string }`

输出:完整 engram 内容 + 元数据 + 相关 id 列表(不展开 synapse 图)。

### D4. promptBuilder 内容设计(改进版,优于 memory-core 和 flexmem-local)

**条件性注入**(避免固定 token 成本):

1. **基础引导**(常驻,约 200 字符)
   - 何时调用 memory_search
   - 何时**不**调用(负向引导,memory-core 和 flexmem 都缺失)
2. **结果解读**(常驻)
   - truthScore 含义
   - 低分记忆如何处理(call close_learning_loop 验证)
3. **Proposal 提醒**(条件性,count > 0 才注入)
4. **高频领域提示**(条件性,基于 topTags 统计)
5. **最近遗漏话题**(条件性,基于 RPE false negative 信号)

### D5. 自动召回(before_agent_start hook)— **不实施**

撤销原 D6。理由:

- RPE 强化语义是"有用的记忆被强化",自动召回污染信号
- memory-core 的 promptBuilder 引导对现代 LLM 遵从度足够
- 节省每轮 50-200ms 延迟和固定 token
- YAGNI,v1.1 可选

### D6. 自动摄取(agent_end hook)— **不实施**

co-engram 已有 proposal 机制,功能重叠。YAGNI。

### D7. 提示词自进化(核心创新)

分两阶段实施:

**v1: 模板插值(topTags)**

- light stage 扫描所有 engram 的 domainTags
- 统计 top 5 高频 tag
- 写入 `.co-engram/prompt-signals.json`
- promptBuilder 读取并填充 "Frequent topics: ..." 提示

**v1.1: RPE 反馈注入**

- 检测 false negative(同一话题后来被检索到,但之前轮次没调 memory_search)
- 检测 false positive(memory_search 返回低分结果被 LLM 忽略)
- 检测低 truthScore 频繁检索
- 把这些信号写入 prompt-signals.json
- promptBuilder 条件性注入 "Recently missed topics: ..." / "Consider verifying: ..." 提示

## 解耦保证

所有改进仅在 co-engram 包内,**零外部依赖**:

- 不修改 OpenClaw 核心(`src/`)
- 不修改 memory-core(`extensions/memory-core/`)
- 不修改 flexmem-local(`extensions/flexmem-local/`)
- 统计数据来自已有 engram meta
- 缓存写在 team-memory/.co-engram/
- promptBuilder 由 co-engram 自己注册

## 文件改动清单

### 新建

| 文件                                                   | 用途                              |
| ------------------------------------------------------ | --------------------------------- |
| `packages/openclaw-plugin/src/memory-tools.ts`         | memory_search/memory_get 工具定义 |
| `packages/openclaw-plugin/src/prompt-builder.ts`       | 改进版 promptBuilder(含自进化)    |
| `packages/openclaw-plugin/src/prompt-signals.ts`       | 读取/解析 prompt-signals.json     |
| `packages/core/src/prompt-signals/`                    | 统计逻辑 + 缓存读写(新建目录)     |
| `packages/openclaw-plugin/test/memory-tools.test.ts`   | 工具测试                          |
| `packages/openclaw-plugin/test/prompt-builder.test.ts` | promptBuilder 测试                |
| `packages/core/test/prompt-signals.test.ts`            | 统计逻辑测试                      |

### 修改

| 文件                                            | 改动                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------- |
| `packages/openclaw-plugin/src/types.ts`         | 加 `MemoryCapability` 类型 + `registerMemoryCapability` 到 host api |
| `packages/openclaw-plugin/src/plugin-entry.ts`  | 注册 memory_search/memory_get + capability                          |
| `packages/openclaw-plugin/src/entry.ts`         | 透传 autoRecall 配置(预留)                                          |
| `packages/openclaw-plugin/openclaw.plugin.json` | 加 `kind: "memory"` + contracts.tools + 配置 schema                 |
| `packages/core/src/i18n/en.ts`                  | 加 memory_search/memory_get + prompt.\* 键                          |
| `packages/core/src/i18n/zh.ts`                  | 加 memory_search/memory_get + prompt.\* 键                          |
| `packages/core/src/maintenance/engine.ts`       | light stage 调用 prompt-signals 统计                                |
| `packages/core/src/index.ts`                    | 导出新模块                                                          |
| `docs/host-openclaw.md`                         | 文档更新                                                            |
| `README.md` / `README.zh-CN.md`                 | 配置表更新                                                          |
| `CHANGELOG.md`                                  | 记录变更                                                            |

## 验证方法

### 单元测试

- memory_search/memory_get 工具的 schema 和行为
- promptBuilder 各种条件组合(空 signals / 仅 topTags / 仅 missed / 全部)
- prompt-signals 统计准确性
- i18n 中英文切换

### 集成测试

- 模拟 OpenClaw plugin loader
- 验证 capability 注册成功
- 验证 memory_search 触发系统提示

### 端到端

- 在真实 OpenClaw 实例加载 co-engram
- 确认 memory-core 被禁用
- 调用 memory_search 能返回真实 engram
- light stage 运行后 prompt-signals.json 正确生成

## 风险与缓解

| 风险                          | 缓解                                           |
| ----------------------------- | ---------------------------------------------- |
| capability 单槽位冲突         | OpenClaw 已用 applyExclusiveSlotSelection 保证 |
| 提示词膨胀                    | 硬上限:topTags 最多 5,missed 最多 3            |
| 统计不准导致误导              | 仅当频次 ≥ 3 才注入                            |
| 用户从 memory-core 切换丢数据 | 文档告知;v2 提供迁移工具                       |
| i18n 键遗漏                   | 字典完整性测试已覆盖模式                       |

## 不在 v1 范围

- 自动召回(before_agent_start)
- 自动摄取(agent_end)
- flushPlan 适配
- memory-core 迁移工具
- 路径 B(纯补充模式)
- LLM 驱动的元反思(v2 远期)
