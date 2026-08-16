/**
 * 人工盲评材料生成(spec §九质量度量:真实记忆库 20+ 条洞察,人工判
 * 「真洞察 vs 记忆复述」,据此校准 critic 阈值与 prompt)。
 *
 * 在**克隆**的真实 dataRoot 上运行(不污染真实提案页),产出打乱顺序的
 * 盲评清单到 ~/superpowers/night-thinking-blind-eval-2026-08-15.md。
 *
 * 运行(需 ANTHROPIC_API_KEY):
 *   npx tsx scripts/blind-eval-night-thinking.mts <realDataRoot>
 */
import { execFile } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";

import {
  EngramRepository,
  ProposalEngine,
  AuditLog,
  runDeepThought,
  buildSubgraph,
  buildModePrompt,
  buildAliasMap,
  retrospectiveSeedFilter,
  inspirationSeedFilter,
  critique,
  parseDrafts,
  validateInsightDraft,
  type LlmClient,
  type InsightDraft,
  type DeepThoughtMode,
} from "@co-engram/core";

const realRoot = process.argv[2];
if (!realRoot) {
  console.error("usage: tsx scripts/blind-eval-night-thinking.mts <realDataRoot>");
  process.exit(1);
}

const MODEL = process.env.VERIFY_MODEL ?? process.env.ANTHROPIC_MODEL ?? "glm-5.3[1m]";
const llm: LlmClient = {
  async complete(prompt, opts = {}) {
    const body = JSON.stringify({
      model: MODEL,
      max_tokens: opts.maxTokens ?? 4000,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      messages: [{ role: "user", content: prompt }],
    });
    const endpoint = (process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/+$/, "");
    const args = [
      "-sS", "--max-time", "300",
      "-X", "POST", endpoint + "/v1/messages",
      "-H", "content-type: application/json",
      "-H", "anthropic-version: 2023-06-01",
      "-H", "x-api-key: " + (process.env.ANTHROPIC_API_KEY ?? ""),
      ...(process.env.ANTHROPIC_AUTH_TOKEN ? ["-H", "authorization: Bearer " + process.env.ANTHROPIC_AUTH_TOKEN] : []),
      "-d", body,
    ];
    return new Promise((resolve, reject) => {
      const attempt = (left: number) => {
      execFile("curl", args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        if (err) {
          if (left > 0) { setTimeout(() => attempt(left - 1), 3000); return; }
          reject(err); return;
        }
        try {
          const json = JSON.parse(stdout) as { content?: Array<{ type: string; text?: string }>; error?: { message?: string } };
          if (json.error) { reject(new Error(json.error.message ?? "api error")); return; }
          const text = (json.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
          resolve(text);
        } catch { reject(new Error("bad response: " + String(stdout).slice(0, 200))); }
      });
      };
      attempt(2);
    });
  },
};

const tmp = mkdtempSync(join(tmpdir(), "co-engram-blind-eval-"));
console.log(`[blind-eval] cloning ${realRoot} → ${tmp}`);
cpSync(realRoot, tmp, { recursive: true, dereference: true });
// 克隆里清掉已有提案(只统计本次产出),保留 engrams/synapses
try { rmSync(join(tmp, ".co-engram", "proposals.jsonl")); } catch {}

const repo = new EngramRepository({ rootPath: tmp });
const engine = new ProposalEngine({
  repository: repo,
  embedder: async () => [1, 0, 0],
  auditLog: new AuditLog(tmp),
  dataRoot: tmp,
});

const runs: Array<{ label: string; lastRemAt: string | null }> = [
  { label: "全库视角(首次 REM 语义)", lastRemAt: null },
  { label: "近 30 天窗口", lastRemAt: new Date(Date.now() - 30 * 86400_000).toISOString() },
  { label: "近 7 天窗口", lastRemAt: new Date(Date.now() - 7 * 86400_000).toISOString() },
];

async function main() {
  const totalEngrams = repo.listEngramIndex().length;
  // 直连探针:任何 llm 错误第一时间暴露(不被 runDeepThought 的 per-mode catch 吞掉)
  try {
    const probe = await llm.complete('Return ONLY this JSON array: [{"type":"theme","title":"t","content":"c","summary":"s","sourceIds":["x"],"domainTags":["d"],"reason":"r"}]', { maxTokens: 3000 });
    console.log("[blind-eval] probe reply head:", JSON.stringify(probe.slice(0, 120)));
  } catch (e) {
    console.log("[blind-eval] probe FAILED:", e instanceof Error ? e.message : e);
  }

  console.log(`[blind-eval] cloned repo: ${totalEngrams} engrams`);
  for (const r of runs) {
    const out = await runDeepThought({
      repository: repo,
      proposalEngine: engine,
      llmClient: llm,
      lastRemAt: r.lastRemAt,
      config: { enabled: true, modesPerRun: 3, criticThreshold: 0.5, maxSubgraphNodes: 30 },
    });
    console.log(
      `[blind-eval] ${r.label}: modes=[${out.modesRun.join(",")}] drafts=${out.draftsGenerated} mechanicalRejected=${out.mechanicalRejected} criticRejected=${out.criticRejected} proposals=${out.proposals} ablation=${JSON.stringify(out.ablation ?? {})}`,
    );
  }

  // 第二轮:草稿级采集 —— 盲评的正确语义是评「原始草稿 + critic 分」,
  // 而非仅评存活提案(critic 偏严恰是待校准对象)。每窗口 × 模式直接
  // 生成,critic 限流前 40 条(每条附分),机械校验结果一并标注。
  const MODES: DeepThoughtMode[] = ["integration", "retrospective", "inspiration"];
  interface SheetItem { draft: InsightDraft; critic: number | null; mechanical: string | null; window: string; }
  const sheet: SheetItem[] = [];
  let criticCalls = 0;
  for (const r of runs) {
    for (const mode of MODES) {
      try {
        const seedFilter = mode === "retrospective" ? retrospectiveSeedFilter(repo) : mode === "inspiration" ? inspirationSeedFilter(repo) : undefined;
        const sub = buildSubgraph(repo, { lastRemAt: r.lastRemAt, maxNodes: 30, ...(seedFilter ? { seedFilter } : {}) });
        if (sub.nodes.length === 0) continue;
        const prompt = buildModePrompt(mode, sub);
        const raw = await llm.complete(prompt, { temperature: 0.4, maxTokens: 32768 });
        const aliasMap = buildAliasMap(sub);
        const drafts = parseDrafts(raw, mode).map((d) => ({ ...d, sourceIds: d.sourceIds.map((x) => aliasMap.get(x) ?? x) }));
        for (const d of drafts) {
          const v = validateInsightDraft(d, sub, repo, engine.listAll());
          const mechanical = v.ok ? null : (v as { reason: string }).reason;
          let criticScore: number | null = null;
          if (v.ok && criticCalls < 40) {
            criticCalls += 1;
            const sc = await critique(llm, d, sub, mode).catch((e: unknown) => {
              console.log(`[blind-eval][critic-error] ${d.title.slice(0, 24)}: ${(e instanceof Error ? e.message : String(e)).slice(0, 100)}`);
              return null;
            });
            criticScore = sc ? sc.overall : null;
          }
          sheet.push({ draft: d, critic: criticScore, mechanical, window: r.label });
        }
        console.log(`[blind-eval][drafts] ${r.label}/${mode}: ${drafts.length} drafts (cum ${sheet.length})`);
      } catch (e) {
        console.log(`[blind-eval][drafts] ${r.label}/${mode} FAILED: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
  console.log(`[blind-eval] sheet items: ${sheet.length}`);

  // 结构化(2026-08-16 用户定稿):按 REM 思维模式分章 —— 按模式聚合正是
  // 校准目标(哪模式产真洞察/复述);章内乱序防相邻同批干扰。窗口/批次
  // 仍不标(避免跨批次锚定)。原始数据落 sidecar json,重组清单不再重跑 LLM。
  const MODE_TITLES: Record<string, { name: string; what: string; criteria: string }> = {
    integration: { name: "整合模式", what: "跨记忆的共性结构与主题", criteria: "是否 ≥2 来源的共享**结构**(非共同词汇);你事先没意识到" },
    retrospective: { name: "复盘模式", what: "失败/反驳记忆的 AAR 因果链", criteria: "预期→实际→原因→改进 四环是否完整且**可行动**" },
    inspiration: { name: "灵感模式", what: "跨域远距结构映射", criteria: "映射站得住(关系结构对应)还是牵强类比" },
  };
  const byMode = new Map<string, SheetItem[]>();
  for (const it of sheet) {
    const list = byMode.get(it.draft.mode) ?? [];
    list.push(it);
    byMode.set(it.draft.mode, list);
  }
  for (const list of Array.from(byMode.values())) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j]!, list[i]!];
    }
  }

  const lines: string[] = [];
  let seq = 0;
  lines.push("# 夜思/深度思考 洞察盲评清单(2026-08-16 结构化版)");
  lines.push("");
  lines.push(`- 来源:真实记忆库克隆(${repo.listEngramIndex().length} engrams),3 时间窗口 × 3 模式,草稿级采集;按模式分章,章内乱序`);
  lines.push(`- 总数:${sheet.length}(带 critic 分 ${sheet.filter((x) => x.critic !== null).length} / 机械拒 ${sheet.filter((x) => x.mechanical).length})`);
  lines.push("- 每条三选一:**真洞察** / **复述**(单条记忆换说法) / **牵强**(形式像洞察但站不住);critic=null=独立评审解析失败(本身是校准数据)");
  lines.push("");
  for (const mode of ["integration", "retrospective", "inspiration"] as const) {
    const list = byMode.get(mode) ?? [];
    if (!list.length) continue;
    const meta = MODE_TITLES[mode]!;
    lines.push(`---`);
    lines.push(`## ${meta.name}(${list.length} 条)`);
    lines.push("");
    lines.push(`> **该模式想什么**:${meta.what}`);
    lines.push(`> **评分要点**:${meta.criteria}`);
    lines.push("");
    for (const it of list) {
      seq += 1;
      const d = it.draft;
      const sources = d.sourceIds.map((id) => {
        try {
          const e = repo.readEngram(id);
          return `${e.title}(摘要:${(e.summary ?? "").slice(0, 50)}…)`;
        } catch {
          return `${id}(不在库)`;
        }
      });
      lines.push(`### #${seq}  [critic ${it.critic === null ? "null" : it.critic.toFixed(2)}]${it.mechanical ? ` [机械拒:${it.mechanical.slice(0, 40)}]` : ""} [${d.type}]`);
      lines.push("");
      lines.push(`**${d.title}**`);
      lines.push("");
      lines.push((d.content ?? "").slice(0, 600));
      lines.push("");
      lines.push(`> 来源:${sources.join(" / ")}`);
      lines.push("");
      lines.push("- [ ] 真洞察  - [ ] 复述  - [ ] 牵强  评语:________");
      lines.push("");
    }
  }
  lines.push(`---`);
  lines.push(`## 机械拒条目复核(${sheet.filter((x) => x.mechanical).length} 条)`);
  lines.push("");
  lines.push("> 这些被机械校验拦下未进 critic。请判断拦截是否正确(误拒=应放行):");
  lines.push("");
  for (const it of sheet.filter((x) => x.mechanical)) {
    seq += 1;
    lines.push(`### #${seq} [拒因:${it.mechanical}]`);
    lines.push("");
    lines.push(`**${it.draft.title}**`);
    lines.push("");
    lines.push((it.draft.content ?? "").slice(0, 400));
    lines.push("");
    lines.push("- [ ] 拒得对  - [ ] 误拒应放行  评语:________");
    lines.push("");
  }
  lines.push(`---`);
  lines.push("## 汇总(评完填写)");
  lines.push("");
  for (const mode of ["integration", "retrospective", "inspiration"] as const) {
    const n = (byMode.get(mode) ?? []).length;
    lines.push(`- ${MODE_TITLES[mode]!.name}:真洞察 ___/${n} · 复述 ___/${n} · 牵强 ___/${n} · critic 同向率 ___`);
  }
  lines.push(`- 机械拒误判率:___/${sheet.filter((x) => x.mechanical).length}`);
  lines.push("- 校准建议(critic 阈值 / prompt / 机械规则):________");
  lines.push("");
  const out = join(homedir(), "superpowers", "night-thinking-blind-eval-2026-08-16.md");
  writeFileSync(out, lines.join("\n"), "utf8");
  const sidecar = join(homedir(), "superpowers", "night-thinking-blind-eval-2026-08-16.data.json");
  writeFileSync(sidecar, JSON.stringify(sheet.map((it) => ({ mode: it.draft.mode, type: it.draft.type, title: it.draft.title, content: (it.draft.content ?? "").slice(0, 800), sourceIds: it.draft.sourceIds, critic: it.critic, mechanical: it.mechanical, window: it.window })), null, 2), "utf8");
  console.log(`[blind-eval] structured sheet written: ${out} (${seq} items)`);
  console.log(`[blind-eval] sidecar data: ${sidecar}`);

  // 消融数据留档(写入同目录)
  try {
    const state = readFileSync(join(tmp, ".co-engram", "insight-review.json"), "utf8");
    console.log("[blind-eval] insight-review.json(证据链衰减摘要):", state.slice(0, 200));
  } catch {
    console.log("[blind-eval] no insight-review.json (无衰减项)");
  }
  rmSync(tmp, { recursive: true, force: true });
}

main().catch((e) => {
  console.error("[blind-eval] crashed:", e);
  process.exit(1);
});
