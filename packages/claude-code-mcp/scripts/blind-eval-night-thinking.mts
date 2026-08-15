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
import { cpSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";

import {
  EngramRepository,
  ProposalEngine,
  AuditLog,
  runDeepThought,
  type LlmClient,
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

  const insights = engine
    .listAll()
    .filter((p) => p.source === "rem-insight" && p.status === "pending");
  console.log(`[blind-eval] total pending rem-insight proposals: ${insights.length}`);

  // 打乱顺序(盲评:不暴露模式/批次)
  const shuffled = [...insights];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }

  const lines: string[] = [];
  lines.push("# 夜思/深度思考 洞察盲评清单(2026-08-15)");
  lines.push("");
  lines.push(`- 来源:真实记忆库克隆(${totalEngrams} engrams),3 个时间窗口 × 3 模式,critic 阈值 0.5`);
  lines.push(`- 洞察数:${insights.length}(已打乱顺序,不标注模式与批次)`);
  lines.push("- 评分口径(每条三选一):");
  lines.push("  - **真洞察**:跨记忆的共性结构 / 可行动因果链 / 有依据的远域映射 —— 你事先没意识到");
  lines.push("  - **复述**:单条记忆的内容换个说法,没有新信息");
  lines.push("  - **牵强**:形式像洞察但映射/因果站不住");
  lines.push("- 附加(可选):critic 分是否与你的判断同向(critic 分见每条标注)");
  lines.push("");
  shuffled.forEach((p, i) => {
    const payload = p.payload!;
    const sources = (payload.remSourceIds ?? []).map((id) => {
      try {
        const e = repo.readEngram(id);
        return `${e.title}(摘要:${(e.summary ?? "").slice(0, 50)}…)`;
      } catch {
        return `${id}(已不存在)`;
      }
    });
    lines.push(`## #${i + 1}  [critic ${((payload.criticScore ?? 0) as number).toFixed(2)}]`);
    lines.push("");
    lines.push(`**${payload.title}**`);
    lines.push("");
    lines.push((payload.content ?? "").slice(0, 600));
    lines.push("");
    lines.push(`> 来源:${sources.join(" / ")}`);
    lines.push("");
    lines.push("- [ ] 真洞察  - [ ] 复述  - [ ] 牵强  评语:________");
    lines.push("");
  });
  lines.push("## 汇总");
  lines.push("");
  lines.push(`- 真洞察:___ / ${shuffled.length}`);
  lines.push(`- 复述:___ / ${shuffled.length}`);
  lines.push(`- 牵强:___ / ${shuffled.length}`);
  lines.push("- critic 一致性(高分=真洞察、低分=复述/牵强):___");
  lines.push("- 校准建议(critic 阈值 / prompt 调整):________");
  lines.push("");
  const out = join(homedir(), "superpowers", "night-thinking-blind-eval-2026-08-15.md");
  writeFileSync(out, lines.join("\n"), "utf8");
  console.log(`[blind-eval] sheet written: ${out}`);

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
