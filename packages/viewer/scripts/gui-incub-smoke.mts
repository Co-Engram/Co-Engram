import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngramRepository, ProposalEngine, Incubator, AuditLog } from "@co-engram/core";
import { startViewerServer } from "../src/index.js";

const tmp = mkdtempSync(join(tmpdir(), "co-engram-viewer-smoke-"));
const repository = new EngramRepository({ rootPath: tmp });
const auditLog = new AuditLog(tmp);
const proposalEngine = new ProposalEngine({ repository, embedder: async () => [1, 0, 0], auditLog, dataRoot: tmp });
const incubator = new Incubator({ repository, proposalEngine, dataRoot: tmp, auditLog });
const rt = await startViewerServer({ repository, incubator } as never, { language: "zh", port: 58777 });
const base = `http://127.0.0.1:${rt.port}`;

// 1. SPA HTML 含夜思 tab 与 section
const html = await (await fetch(base + "/")).text();
console.log("zh tab:", html.includes("夜思实验室") ? "OK" : "MISSING");
console.log("zh section:", html.includes('data-tab="incubations"') ? "OK" : "MISSING");

// 2. 创建条目 + 异步 run + 轮询
const c = await (await fetch(base + "/api/incubations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: "GUI 冒烟:如何让洞察可信任?" }) })).json();
console.log("create:", c.entry?.id ? "OK" : "FAIL");
const run = await (await fetch(`${base}/api/incubations/${c.entry.id}/run`, { method: "POST" })).json();
console.log("run job:", run.jobId ? "OK(202 异步)" : "FAIL");
let job: any = {};
for (let i = 0; i < 60; i++) {
  job = await (await fetch(`${base}/api/incubation-jobs/${run.jobId}`)).json();
  if (job.status !== "running") break;
  await new Promise((r) => setTimeout(r, 100));
}
console.log("job final:", job.status, job.error ? `(${String(job.error).slice(0, 60)})` : "");
console.log("entry rounds after run:", (await (await fetch(base + "/api/incubations")).json()).items[0].rounds);

// 3. 英文 HTML tab
const rtEn = await startViewerServer({ repository, incubator } as never, { language: "en", port: 58778 });
const htmlEn = await (await fetch(`http://127.0.0.1:${rtEn.port}/`)).text();
console.log("en tab:", htmlEn.includes("Night Lab") ? "OK" : "MISSING");
await rtEn.stop();
await rt.stop();
rmSync(tmp, { recursive: true, force: true });
