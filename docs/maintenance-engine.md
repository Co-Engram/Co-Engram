# Maintenance Engine

The maintenance engine is what makes Co-Engram **self-correcting**. Instead of relying on agents to manually tag or score memories, the engine observes how memories are used and adjusts their strength automatically.

Inspired by the brain's sleep cycles — `light` (ongoing), `deep` (consolidation), `rem` (abstraction + verification).

## The Four Stages

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

**OpenClaw plugin** (`plugins.entries.co-engram.config`):

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

### Storage

Proposals live in `$DATA_ROOT/.co-engram/`:

- `topic-clusters.jsonl` — incremental cluster state (id, centroid, occurrences, samples)
- `proposals.jsonl` — pending/accepted/dismissed proposals
- `audit.jsonl` — every propose/accept/dismiss event is logged here too

Both files are gitignored (they're derived state, not source-of-truth). Deleting them is safe — the engine will simply re-observe from scratch.

### Tuning recommendations

| Workload                            | threshold | similarity | minMessageLength |
| ----------------------------------- | --------- | ---------- | ---------------- |
| Solo developer, terse notes         | 2         | 0.70       | 15               |
| Team, verbose discussions (default) | 3         | 0.75       | 20               |
| High-noise channel (Slack/IRC)      | 5         | 0.80       | 40               |

Higher `threshold` = fewer false positives but slower signal capture. Higher `similarity` = stricter clustering (more clusters, smaller). Higher `minMessageLength` filters chitchat.

### Why hash-based embedder (not LLM)

The proposal engine ships with a deterministic hash-based embedder (128-dim, L2-normalized). It's zero-cost and good enough for short technical snippets where exact word overlap matters more than semantic paraphrase.

For production use with multilingual or paraphrased content, swap the embedder in `createCoEngramContext` / `createCoEngramMcpServer`. The interface is `(text: string) => Promise<readonly number[]>` — anything returning a normalized vector works (OpenAI, local sentence-transformers, etc.).
