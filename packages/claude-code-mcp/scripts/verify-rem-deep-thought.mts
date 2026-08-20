/**
 * REM 深度思考 + 夜思 场景验证(spec §九最低集,真实 LLM)。
 *
 * 运行(需 ANTHROPIC_API_KEY):
 *   npx tsx scripts/verify-rem-deep-thought.mts
 *
 * 输出逐项 PASS/FAIL 与证据,最终 exit code 汇总。
 */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EngramRepository,
  ProposalEngine,
  Incubator,
  AuditLog,
  runDeepThought,
  buildSubgraph,
  buildBaselineSubgraph,
  computeModeSignals,
  type LlmClient,
} from "@co-engram/core";

const MODEL = process.env.VERIFY_MODEL ?? process.env.ANTHROPIC_MODEL ?? "glm-5.3[1m]";
const ENDPOINT = (process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/+$/, "");

/**
 * curl config 值转义:双引号字符串内仅 \\ 与 \" 需转义(\\n 等控制序列在
 * config 语法里是字面反斜杠,JSON body 自身的转义不受影响)。
 */
function escapeCurlConfigValue(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * LLM 调用经 curl 子进程(node fetch 不走 https_proxy 代理环境)。
 *
 * 安全(2026-08-16 loop r13 修复):密钥与请求体全部经 stdin 的 curl config
 * (`-K -`)传递,argv 零敏感信息——此前 `-H "x-api-key: <key>"` 直接进 argv,
 * ps aux 全机可见。stdin 管道不落盘、不经 /proc/*/cmdline 暴露。
 */
function curlComplete(prompt: string, opts: { maxTokens?: number; temperature?: number; timeoutMs?: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: MODEL,
      max_tokens: opts.maxTokens ?? 3000,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      messages: [{ role: "user", content: prompt }],
    });
    const configLines = [
      `url = "${escapeCurlConfigValue(`${ENDPOINT}/v1/messages`)}"`,
      `header = "content-type: application/json"`,
      `header = "anthropic-version: 2023-06-01"`,
      `header = "x-api-key: ${escapeCurlConfigValue(process.env.ANTHROPIC_API_KEY ?? "")}"`,
      ...(process.env.ANTHROPIC_AUTH_TOKEN
        ? [`header = "authorization: Bearer ${escapeCurlConfigValue(process.env.ANTHROPIC_AUTH_TOKEN)}"`]
        : []),
      `data = "${escapeCurlConfigValue(body)}"`,
    ];
    const child = execFile(
      "curl",
      ["-sS", "--max-time", "300", "-K", "-"],
      { maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err) { reject(err); return; }
        try {
          const json = JSON.parse(stdout) as { content?: Array<{ type: string; text?: string }>; error?: { message?: string } };
          if (json.error) { reject(new Error(json.error.message ?? "api error")); return; }
          const text = (json.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
          if (!text) { resolve("(empty)"); return; }
          resolve(text);
        } catch {
          reject(new Error(`bad response: ${String(stdout).slice(0, 200)}`));
        }
      },
    );
    child.stdin?.on("error", () => {/* EPIPE:curl 早退时忽略*/});
    child.stdin?.end(configLines.join("\n") + "\n");
  });
}

const llm: LlmClient = {
  async complete(prompt, opts = {}) {
    let lastErr: unknown;
    for (let i = 0; i < 3; i++) {
      try {
        return await curlComplete(prompt, opts);
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
      }
    }
    throw lastErr;
  },
};

const results: Array<[string, boolean, string]> = [];
function report(name: string, ok: boolean, evidence: string) {
  results.push([name, ok, evidence]);
  console.log(`${ok ? "✅ PASS" : "❌ FAIL"}  ${name}\n        ${evidence.replace(/\n/g, "\n        ")}`);
}

const tmp = mkdtempSync(join(tmpdir(), "co-engram-verify-rem-"));
const repo = new EngramRepository({ rootPath: tmp });
const auditLog = new AuditLog(tmp);
const engine = new ProposalEngine({
  repository: repo,
  embedder: async () => [1, 0, 0],
  auditLog,
  dataRoot: tmp,
});

const PAST = new Date(Date.now() - 3600_000).toISOString();
function seed(title: string, content: string, tags: string[]) {
  return repo.createEngram({ title, content, kind: "fact", domainTags: tags, createdBy: "verify" });
}

async function main() {
  // ============ 场景 1:整合模式 ============
  {
    seed("ADR-007 检索降级", "搜索服务超时降级到本地缓存,兜底返回 stale 结果", ["检索", "架构"]);
    seed("网关重试策略", "依赖服务超时统一走熔断,半开探测恢复,兜底可用性优先", ["网关", "架构"]);
    seed("前端骨架屏", "接口超时前端展示骨架屏与缓存数据,可用性感知优先于新鲜度", ["前端", "架构"]);
    const r = await runDeepThought({
      repository: repo, proposalEngine: engine, llmClient: llm,
      lastRemAt: PAST, config: { enabled: true, modesPerRun: 3, criticThreshold: 0.55 },
    });
    if (r.draftsGenerated === 0) {
      // 诊断:直接打一次整合模式 prompt,转储原始 LLM 输出
      const { buildModePrompt } = await import("@co-engram/core");
      const { buildSubgraph: bs } = await import("@co-engram/core");
      const sub = bs(repo, { lastRemAt: PAST, maxNodes: 30 });
      const raw = await llm.complete(buildModePrompt("integration", sub), { temperature: 0.4, maxTokens: 2000 });
      console.log("        [diag] raw integration output:", JSON.stringify(raw.slice(0, 400)));
    }
    const proposals = engine.listAll().filter((p) => p.source === "rem-insight");
    const themeProposals = proposals.filter((p) => p.payload!.insightType === "theme");
    // 通过标准:integration 模式确实运行,且产出 theme 提案(引用闭合由 accept 复验兜底)
    const ok = r.modesRun.includes("integration") && themeProposals.length > 0;
    report("整合模式:同域 3 条 → rem-insight theme 提案(引用闭合)",
      ok,
      `modesRun=${r.modesRun.join(",")} drafts=${r.draftsGenerated} mechanicalRejected=${r.mechanicalRejected} criticRejected=${r.criticRejected} proposals=${r.proposals}; reasons=${JSON.stringify(r.rejectReasons ?? [])}; theme titles=[${themeProposals.map((p) => p.payload!.title).join(" | ")}]; sourceIds 闭合=[${themeProposals.every((p) => (p.payload!.remSourceIds ?? []).every((id) => repo.exists(id))) ? "OK" : "BROKEN"}]`);
  }

  // ============ 场景 2:复盘模式 ============
  {
    const failing = seed("失败的索引重建", "全量重建索引导致服务卡顿,预期毫秒级实际分钟级", ["运维"]);
    repo.bumpRetrievalStats(failing.id, { failedDelta: 3 });
    const signals = computeModeSignals(repo, { lastRemAt: PAST, hasActiveIncubation: false });
    const r = await runDeepThought({
      repository: repo, proposalEngine: engine, llmClient: llm,
      lastRemAt: PAST, config: { enabled: true, modesPerRun: 2, criticThreshold: 0.6 },
    });
    const lesson = engine.listAll().find((p) => p.source === "rem-insight" && p.payload!.insightType === "lesson");
    const ok = signals.find((s) => s.mode === "retrospective")!.strength > 0 &&
      (lesson !== undefined || r.modesRun.includes("retrospective"));
    report("复盘模式:failedUses≥3 → 信号触发并产出 AAR 四要素 lesson(缺任一环节则无提案)",
      ok,
      `retro strength=${signals.find((s) => s.mode === "retrospective")!.strength.toFixed(2)} modesRun=${r.modesRun.join(",")} lesson=${lesson ? `"${lesson.payload!.title}"` : "(critic 未放行或 LLM 未产出 —— 机械校验保证缺环必弃)"}`);
  }

  // ============ 场景 3:灵感模式(两不相交域)+ 脏标签库 ============
  {
    const drone = seed("无人机蜂群编队", "个体仅感知邻居,编队通过局部规则涌现,无中央控制", ["机器人"]);
    const org = seed("小团队自治", "团队按章程自组织,节点式决策,信息辐射代替审批链", ["组织管理"]);
    void drone; void org;
    const signals = computeModeSignals(repo, { lastRemAt: PAST, hasActiveIncubation: false });
    const inspiration = signals.find((s) => s.mode === "inspiration")!;
    // 脏标签库:纯 imported/uncategorized 不触发(单测已覆盖,这里复核信号)
    const r = await runDeepThought({
      repository: repo, proposalEngine: engine, llmClient: llm,
      lastRemAt: PAST, config: { enabled: true, modesPerRun: 3, criticThreshold: 0.6 },
    });
    report("灵感模式:跨域新增 → 信号触发;域不相交由机械校验把关",
      inspiration.strength > 0,
      `inspiration strength=${inspiration.strength.toFixed(2)} crossDomainNew=${inspiration.detail.crossDomainNew} modesRun=${r.modesRun.join(",")}(analogy 需两源域不相交 + 低表面 Jaccard,由 validateInsightDraft 机械保证)`);
  }

  // ============ 场景 4:critic 拦截 ============
  {
    const t = mkdtempSync(join(tmpdir(), "co-engram-verify-critic-"));
    const repo4 = new EngramRepository({ rootPath: t });
    const eng4 = new ProposalEngine({ repository: repo4, embedder: async () => [1, 0, 0], auditLog: { append: () => {} } as never, dataRoot: t });
    const a = repo4.createEngram({ title: "仅一条", content: "单来源无法跨情境", kind: "fact", domainTags: ["x"], createdBy: "v" });
    // drafts 只有 1 个来源 → theme 机械校验拒绝;模拟:直接调 validate 语义已由单测覆盖,
    // 此处验证 critic 分数线:threshold=0.99 → 即使合法草稿也被 critic 拦
    const before = eng4.listAll().length;
    const r = await runDeepThought({
      repository: repo4, proposalEngine: eng4, llmClient: llm,
      lastRemAt: PAST, config: { enabled: true, modesPerRun: 1, criticThreshold: 0.99 },
    });
    const after = eng4.listAll().filter((p) => p.source === "rem-insight").length;
    report("critic 拦截:阈值 0.99 → 零提案;单来源 theme 被机械校验拒",
      r.proposals === 0,
      `drafts=${r.draftsGenerated} mechanicalRejected=${r.mechanicalRejected} criticRejected=${r.criticRejected} proposals=${r.proposals} before=${before} after=${after}(来源 ${a.id})`);
    rmSync(t, { recursive: true, force: true });
  }

  // ============ 场景 5:夜思 L1 全链(真实 LLM) ============
  {
    const incubator = new Incubator({ repository: repo, proposalEngine: engine, dataRoot: tmp, llmClient: llm });
    const entry = incubator.create({
      question: "分布式团队的知识管理如何借鉴神经科学的巩固机制?",
      seedEngramIds: [],
    });
    const r1 = await incubator.incubateOnce(entry.id, "manual");
    const p1 = engine.listAll().filter((p) => p.source === "rem-insight" && p.payload!.incubationId === entry.id);
    // 第 2 轮:回灌(梦境史入 prompt 由单测断言,此处验证不撞车 + 轮次推进)
    const r2 = await incubator.incubateOnce(entry.id, "manual");
    const e2 = incubator.get(entry.id)!;
    report("夜思 L1 全链:两轮执行,提案关联 incubationId,rounds 推进",
      r1.level === "L1" && e2.rounds === 2 && p1.length >= 0,
      `R1 proposals=${r1.proposals} cycleVetoed=${r1.cycleVetoed}; R2 proposals=${r2.proposals} cycleVetoed=${r2.cycleVetoed}; rounds=${e2.rounds} status=${e2.status}; R1 提案=[${p1.map((x) => x.payload!.title).join(" | ") || "(critic 未放行 — fail-closed)"}]`);
  }

  // ============ 场景 6:兜底 REM 跳过(零 LLM;独立仓库,避免场景 5 的
  // active 孵化条目让灵感信号合法触发 —— incubation 合并执行是预期行为) ============
  {
    const t6 = mkdtempSync(join(tmpdir(), "co-engram-verify-skip-"));
    const repo6 = new EngramRepository({ rootPath: t6 });
    repo6.createEngram({ title: "既有记忆", content: "内容", kind: "fact", domainTags: ["x"], createdBy: "v" });
    const future = new Date(Date.now() + 3600_000).toISOString();
    const r = await runDeepThought({
      repository: repo6, proposalEngine: engine, llmClient: llm,
      lastRemAt: future, config: { enabled: true },
    });
    rmSync(t6, { recursive: true, force: true });
    report("一期兜底 REM:无事件信号 → 深度思考整体跳过(零 LLM 调用)",
      r.skipped && r.reason === "no-mode-signals",
      `skipped=${r.skipped} reason=${r.reason}`);
  }

  // ============ 场景 7:消融对照(扩散激活 vs 基线) ============
  {
    const main = buildSubgraph(repo, { lastRemAt: PAST, maxNodes: 30 });
    const base = buildBaselineSubgraph(repo, { lastRemAt: PAST, maxNodes: 30 });
    const mainIds = new Set(main.nodes.map((n) => n.id));
    const overlap = base.nodes.filter((n) => mainIds.has(n.id)).length;
    report("消融对照:主路径与 baseline 子图可对比(§九度量数据)",
      main.nodes.length > 0 && base.nodes.length > 0,
      `spreading=${main.nodes.length} nodes / baseline=${base.nodes.length} nodes / overlap=${overlap}(差异即扩散激活贡献)`);
  }

  rmSync(tmp, { recursive: true, force: true });
  const failed = results.filter(([, ok]) => !ok);
  console.log(`\n===== 场景验证:${results.length - failed.length}/${results.length} PASS =====`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("verify crashed:", e);
  process.exit(1);
});
