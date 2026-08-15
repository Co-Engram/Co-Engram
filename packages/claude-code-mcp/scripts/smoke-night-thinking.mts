/**
 * L2 headless 执行器真实冒烟(spec §九):真 spawn `claude -p`,验证
 * 工具授权/技能加载/输出契约。不写任何用户数据 —— 仅解析回写并打印。
 *
 * 运行:pnpm --filter @co-engram/claude-code exec tsx scripts/smoke-night-thinking.mts
 */
import { createHeadlessExecutor, parseHeadlessReport } from "../src/night-thinking/headless-executor.js";
import type { NightThinkingTask } from "@co-engram/core";

const task: NightThinkingTask = {
  incubationId: "inc-smoke",
  question: "分布式团队的记忆系统如何避免知识孤岛?结合下面的种子记忆给出一个结构性洞察。",
  seedDigests: [
    { id: "01SMOKE1", title: "检索孤岛问题", summary: "各子系统独立建索引,跨系统检索失败率高", domainTags: ["分布式检索"] },
    { id: "01SMOKE2", title: "生物神经系统的整合", summary: "海马体在睡眠期把分散记忆痕迹重新联结成整体", domainTags: ["神经科学"] },
  ],
  dreamHistory: "",
  webResearchOptIn: false,
  protocol: `NIGHT-THINKING PROTOCOL:
1. CAPABILITY INVENTORY — enumerate available read-only capabilities.
2. PLAN — 3-6 steps.
3. EXECUTE — read-only; web research is DISABLED.
4. REPORT — final answer is ONLY the JSON object {"insights":[...],"plan":[...],"trace":[...],"externalCalls":[...]}`,
};

console.log("[smoke] spawning claude -p (L2 headless)…");
const started = Date.now();
const exec = createHeadlessExecutor({ maxTurns: 20, timeoutMs: 8 * 60_000 });
try {
  const report = await exec.execute(task);
  console.log(`[smoke] OK in ${((Date.now() - started) / 1000).toFixed(0)}s`);
  console.log("[smoke] plan steps:", report.plan.length, "| trace:", report.trace.length, "| externalCalls:", report.externalCalls.length);
  console.log("[smoke] insights:", report.insights.length);
  for (const d of report.insights) {
    console.log(`  - [${d.type}] ${d.title} (sources: ${d.sourceIds.join(",")})`);
  }
  if (report.insights.length === 0) {
    console.error("[smoke] FAIL: no insights produced");
    process.exit(1);
  }
  process.exit(0);
} catch (err) {
  console.error("[smoke] FAIL:", err instanceof Error ? err.message : err);
  process.exit(1);
}
void parseHeadlessReport;
