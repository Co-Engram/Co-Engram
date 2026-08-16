/**
 * system prompt 段:prompt-signals 每次组装动态求值
 *
 * dsh 的 PromptSection.text 支持 provider 函数(每次 assembly 求值),
 * 比 openclaw 的启动快照更强 —— topTags / skills / pathOverview /
 * proposalCount 全动态,写入记忆后下一条消息即生效。
 *
 * @module @co-engram/dsh
 */
import {
  buildCoEngramMemoryPrompt,
  collectSkillCatalog,
  pathOverviewFromTree,
  type Language,
  type PromptSignals,
} from "@co-engram/core";
import type { DshRuntime } from "./bootstrap.js";

/** topTags 实时计算(register.ts:375-388 同源规则) */
function computeTopTags(repository: DshRuntime["ctx"]["repository"]): string[] {
  const counts: Record<string, number> = {};
  for (const e of repository.listEngrams()) {
    for (const tag of e.domainTags ?? []) {
      const t = tag.trim();
      if (t) counts[t] = (counts[t] ?? 0) + 1;
    }
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([t]) => t);
}

/**
 * 构造 dsh system prompt 段(order 120,工具指引起 100-199 区间)
 *
 * 返回对象直接喂给 ctx.systemPrompt.section(...)。
 */
export function createCoEngramPromptSection(runtime: DshRuntime): {
  name: string;
  order: number;
  text: (asmCtx: unknown) => string;
} {
  const { ctx, language, tools } = runtime;
  const availableTools = new Set(tools.map((t) => t.name));
  return {
    name: "memory:co-engram",
    order: 120,
    text: () =>
      buildCoEngramMemoryPrompt({
        availableTools,
        citationsMode: "compact",
        language: language as Language,
        // signals 每次组装实时构造(openclaw 为启动快照;dsh 侧全部动态)
        signals: {
          version: 1,
          topTags: computeTopTags(ctx.repository),
          missedTopics: [],
          lowConfidenceTopics: [],
          updatedAt: new Date().toISOString(),
          generatedBy: "dsh-plugin@runtime",
        } satisfies PromptSignals,
        proposalCount: ctx.proposalEngine?.listPending().length ?? 0,
        pathOverview: pathOverviewFromTree(ctx.repository.listPathTree(), 2),
        ...(ctx.skillRepository
          ? {
              skills: collectSkillCatalog(
                ctx.skillRepository,
                ctx.repository.rootPath,
              ),
            }
          : {}),
      }).join("\n\n"),
  };
}
