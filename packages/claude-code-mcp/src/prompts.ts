/**
 * MCP prompts(/prompts/list 端点)
 *
 * 3 个用户可调用的 slash commands:
 *   - co-engram-recall          主动召回,支持 query + maxResults
 *   - co-engram-stats           仓库概览
 *   - co-engram-review-proposals 审核待处理的候选
 *
 * 设计原则:
 *   - prompt 返回 markdown 文本(LLM 友好)
 *   - 不做 side-effect(只读)
 *   - 数据源:repository + searchOrchestrator + proposalEngine
 *
 * @module @co-engram/claude-code
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Language, ToolContext } from "@co-engram/core";

/**
 * 注册 3 个 MCP prompts
 */
export function registerMcpPrompts(
  server: McpServer,
  ctx: ToolContext,
  language: Language,
): void {
  registerRecall(server, ctx, language);
  registerStats(server, ctx, language);
  registerReviewProposals(server, ctx, language);
}

function registerRecall(
  server: McpServer,
  ctx: ToolContext,
  language: Language,
): void {
  server.registerPrompt(
    "co-engram-recall",
    {
      description:
        language === "zh"
          ? "按关键词召回相关记忆(Top N)"
          : "Retrieve relevant team memories by keyword (Top N).",
      argsSchema: {
        query: z
          .string()
          .min(1)
          .describe(
            language === "zh" ? "搜索关键词或主题" : "Search keyword or topic",
          ),
        maxResults: z
          .number()
          .int()
          .positive()
          .max(20)
          .optional()
          .describe(
            language === "zh"
              ? "返回数量上限(默认 5)"
              : "Max results (default 5)",
          ),
      },
    },
    async (args) => {
      const query = String(args.query ?? "");
      const maxResults =
        typeof args.maxResults === "number" ? args.maxResults : 5;

      if (!ctx.searchOrchestrator) {
        return errorResult(
          language,
          language === "zh"
            ? "搜索器未初始化"
            : "SearchOrchestrator not available",
        );
      }

      let results: readonly {
        id: string;
        score: number;
        title: string;
        kind: string;
        domainTags: readonly string[];
      }[] = [];
      try {
        results = ctx.searchOrchestrator
          .search(query, undefined, maxResults)
          .map((r) => ({
            id: r.entry.id,
            score: r.score,
            title: r.entry.title,
            kind: r.entry.kind,
            domainTags: r.entry.domainTags,
          }));
      } catch {
        return errorResult(
          language,
          language === "zh"
            ? "搜索索引未构建,请稍后再试"
            : "Search index not built yet, try again later",
        );
      }

      const markdown =
        results.length === 0
          ? language === "zh"
            ? `# 召回结果\n\n查询 "${query}" 无匹配记忆。\n\n建议:\n- 换用更通用的关键词\n- 用 \`engram_list\` 浏览所有记忆\n- 若是新主题,可考虑 \`engram_create\` 捕获`
            : `# Recall results\n\nNo memories matched "${query}".\n\nSuggestions:\n- Try a broader keyword\n- Use \`engram_list\` to browse all memories\n- If this is a new topic, consider \`engram_create\``
          : formatRecallResults(query, results, language);

      return {
        messages: [
          {
            role: "user",
            content: { type: "text", text: markdown },
          },
        ],
      };
    },
  );
}

function registerStats(
  server: McpServer,
  ctx: ToolContext,
  language: Language,
): void {
  server.registerPrompt(
    "co-engram-stats",
    {
      description:
        language === "zh"
          ? "团队记忆仓库统计概览"
          : "Team memory repository statistics overview.",
    },
    async () => {
      const entries = ctx.repository.listEngrams();
      const pendingProposals = ctx.proposalEngine
        ? ctx.proposalEngine.listPending().length
        : 0;

      const tagFrequency = new Map<string, number>();
      for (const e of entries) {
        for (const tag of e.domainTags) {
          tagFrequency.set(tag, (tagFrequency.get(tag) ?? 0) + 1);
        }
      }
      const topTags = Array.from(tagFrequency.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);

      const kindFrequency = new Map<string, number>();
      for (const e of entries) {
        kindFrequency.set(e.kind, (kindFrequency.get(e.kind) ?? 0) + 1);
      }
      const kindBreakdown = Array.from(kindFrequency.entries()).sort(
        (a, b) => b[1] - a[1],
      );

      const lines: string[] = [];
      lines.push(
        language === "zh" ? "# 团队记忆概览" : "# Team memory overview",
      );
      lines.push("");
      lines.push(
        language === "zh"
          ? `- 记忆总数: **${entries.length}**`
          : `- Total engrams: **${entries.length}**`,
      );
      lines.push(
        language === "zh"
          ? `- 待处理候选: **${pendingProposals}**`
          : `- Pending proposals: **${pendingProposals}**`,
      );

      if (topTags.length > 0) {
        lines.push("");
        lines.push(language === "zh" ? "## 高频 tags" : "## Top tags");
        for (const [tag, count] of topTags) {
          lines.push(`- \`${tag}\` × ${count}`);
        }
      }

      if (kindBreakdown.length > 0) {
        lines.push("");
        lines.push(language === "zh" ? "## 类型分布" : "## Kind breakdown");
        for (const [kind, count] of kindBreakdown) {
          lines.push(`- \`${kind}\` × ${count}`);
        }
      }

      if (pendingProposals > 0) {
        lines.push("");
        lines.push(
          language === "zh"
            ? `> 有 ${pendingProposals} 条候选待审核,调用 \`/co-engram-review-proposals\` 处理。`
            : `> ${pendingProposals} proposals pending — call \`/co-engram-review-proposals\` to triage.`,
        );
      }

      return {
        messages: [
          {
            role: "user",
            content: { type: "text", text: lines.join("\n") },
          },
        ],
      };
    },
  );
}

function registerReviewProposals(
  server: McpServer,
  ctx: ToolContext,
  language: Language,
): void {
  server.registerPrompt(
    "co-engram-review-proposals",
    {
      description:
        language === "zh"
          ? "审核待处理的候选记忆(proposal engine 输出)"
          : "Review pending memory proposals captured by the proposal engine.",
    },
    async () => {
      if (!ctx.proposalEngine) {
        return errorResult(
          language,
          language === "zh"
            ? "Proposal 引擎未启用。在 MCP 配置里设置 `proposalEnabled: true` 启用。"
            : "Proposal engine not enabled. Set `proposalEnabled: true` in MCP config.",
        );
      }

      const pending = ctx.proposalEngine.listPending();
      if (pending.length === 0) {
        const empty =
          language === "zh"
            ? "# 候选审核\n\n当前没有待处理的候选记忆。\n\n候选由 proposal 引擎在对话中隐式捕获,达到阈值后会出现。"
            : "# Proposal review\n\nNo pending proposals.\n\nProposals are captured implicitly by the proposal engine during conversations and surface here once they cross threshold.";
        return {
          messages: [{ role: "user", content: { type: "text", text: empty } }],
        };
      }

      const lines: string[] = [];
      lines.push(language === "zh" ? "# 候选审核" : "# Proposal review");
      lines.push("");
      lines.push(
        language === "zh"
          ? `共 ${pending.length} 条待审核。对每条:\n- 接受 → \`engram_accept_proposal\`\n- 驳回 → \`engram_dismiss_proposal\``
          : `${pending.length} pending. For each:\n- Accept → \`engram_accept_proposal\`\n- Dismiss → \`engram_dismiss_proposal\``,
      );
      lines.push("");

      for (let i = 0; i < pending.length; i++) {
        const p = pending[i]!;
        const proposalId =
          (p as { proposalId?: string; id?: string }).proposalId ??
          (p as { proposalId?: string; id?: string }).id ??
          `#${i + 1}`;
        const title =
          (p as { title?: string }).title ??
          (language === "zh" ? "(无标题)" : "(untitled)");
        const sampleMessage =
          (p as { sampleMessage?: string }).sampleMessage ??
          (p as { excerpt?: string }).excerpt ??
          "";
        const similarity =
          typeof (p as unknown as { similarity?: number }).similarity ===
          "number"
            ? (
                (p as unknown as { similarity: number }).similarity * 100
              ).toFixed(0)
            : "?";
        const topicSeenCount =
          (p as { topicSeenCount?: number }).topicSeenCount ??
          (p as { seenCount?: number }).seenCount ??
          "?";

        lines.push(
          language === "zh" ? `## ${i + 1}. ${title}` : `## ${i + 1}. ${title}`,
        );
        lines.push(
          language === "zh"
            ? `- **proposalId**: \`${proposalId}\``
            : `- **proposalId**: \`${proposalId}\``,
        );
        lines.push(
          language === "zh"
            ? `- 相似度: ${similarity}% | 见过 ${topicSeenCount} 次`
            : `- Similarity: ${similarity}% | seen ${topicSeenCount} times`,
        );
        if (sampleMessage) {
          lines.push(
            language === "zh"
              ? `- 样本消息: \`${sampleMessage.slice(0, 120)}${sampleMessage.length > 120 ? "..." : ""}\``
              : `- Sample: \`${sampleMessage.slice(0, 120)}${sampleMessage.length > 120 ? "..." : ""}\``,
          );
        }
        lines.push("");
      }

      return {
        messages: [
          {
            role: "user",
            content: { type: "text", text: lines.join("\n") },
          },
        ],
      };
    },
  );
}

function formatRecallResults(
  query: string,
  results: readonly {
    id: string;
    score: number;
    title: string;
    kind: string;
    domainTags: readonly string[];
  }[],
  language: Language,
): string {
  const lines: string[] = [];
  lines.push(language === "zh" ? `# 召回结果` : `# Recall results`);
  lines.push("");
  lines.push(
    language === "zh"
      ? `查询: \`${query}\` | 命中: ${results.length}`
      : `Query: \`${query}\` | hits: ${results.length}`,
  );
  lines.push("");

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    lines.push(
      language === "zh" ? `## ${i + 1}. ${r.title}` : `## ${i + 1}. ${r.title}`,
    );
    lines.push(`- **id**: \`${r.id}\``);
    lines.push(
      language === "zh"
        ? `- 分数: ${r.score.toFixed(3)} | 类型: \`${r.kind}\``
        : `- Score: ${r.score.toFixed(3)} | kind: \`${r.kind}\``,
    );
    if (r.domainTags.length > 0) {
      lines.push(
        language === "zh"
          ? `- tags: ${r.domainTags.map((t) => `\`${t}\``).join(" ")}`
          : `- tags: ${r.domainTags.map((t) => `\`${t}\``).join(" ")}`,
      );
    }
    lines.push("");
  }

  lines.push(
    language === "zh"
      ? "> 需要完整内容,调用 \`engram_get\` 并传入 id。若召回有效,调用 \`engram_reinforce\` 强化;若不准确,调用 \`engram_report_failure\`。"
      : "> Use \`engram_get\` with the id for full content. If helpful, call \`engram_reinforce\`; if wrong, call \`engram_report_failure\`.",
  );

  return lines.join("\n");
}

function errorResult(language: Language, message: string) {
  const text =
    language === "zh" ? `# 错误\n\n${message}` : `# Error\n\n${message}`;
  return {
    messages: [
      { role: "user" as const, content: { type: "text" as const, text } },
    ],
  };
}
