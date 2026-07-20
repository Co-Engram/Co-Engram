# 维护引擎

维护引擎让 Co-Engram 具备**自我纠错**能力。引擎无需依赖 agent 手动为记忆打分或加标签,而是观察记忆的使用情况并自动调整其强度。

灵感来源于大脑的睡眠周期 —— `light`(持续进行)、`deep`(巩固)、`rem`(抽象 + 验证)。

## 四个阶段

```mermaid
flowchart TB
  subgraph Light["light stage (every 5 min)"]
    L1["drain signal sink"] --> L2["extract behavioral signals"]
    L2 --> L3["compute RPE"]
    L3 --> L4["bump effectiveRetrievals /<br/>failedUses / reinforcementScore"]
  end

  subgraph Deep["deep stage (every 1 hour)"]
    D1["find similar engrams"] --> D2["create consolidates synapse"]
    D2 --> D3["archive stale engrams"]
    D3 --> D4["trash sweep (opt-in)"]
  end
    }
  }
}
```

**OpenClaw plugin**(`plugins.entries.co-engram.config`):

```json
{
  "proposalEnabled": true,
  "proposalConfig": {
    "threshold": 3,
    "similarityThreshold": 0.75,
    "maxSamples": 3,
    "defaultDismissDays": 0,
    "minMessageLength": 20
  }
}
```

### 存储

候选项位于 `$DATA_ROOT/.co-engram/`:

- `topic-clusters.jsonl` —— 增量聚类状态(id、质心、出现次数、样本)
- `proposals.jsonl` —— pending/accepted/dismissed 的候选
- `audit.jsonl` —— 每次 propose/accept/dismiss 事件也都会记录到这里

这两个文件都被 gitignore(它们是派生状态,不是事实源)。删除它们是安全的 —— 引擎会从头开始重新观察。

### 调优建议

| 工作负载              | threshold | similarity | minMessageLength |
| --------------------- | --------- | ---------- | ---------------- |
| 个人开发者,简短笔记   | 2         | 0.70       | 15               |
| 团队,详细讨论(默认)   | 3         | 0.75       | 20               |
| 高噪声频道(Slack/IRC) | 5         | 0.80       | 40               |

`threshold` 越高 = 误报越少,但信号捕获更慢。`similarity` 越高 = 聚类越严格(聚类更多,更小)。`minMessageLength` 越高 = 过滤闲聊。

### 为什么用基于哈希的 embedder(而不是 LLM)

proposal 引擎内置了一个确定性的基于哈希的 embedder(128 维,L2 归一化)。它是零成本的,对于"精确词重叠比语义改写更重要"的简短技术片段来说已经足够好。

如果在生产环境中处理多语言或改写内容,请在 `createCoEngramContext` / `createCoEngramMcpServer` 中替换 embedder。其接口为 `(text: string) => Promise<readonly number[]>` —— 任何返回归一化向量的实现都可以(OpenAI、本地 sentence-transformers 等)。
