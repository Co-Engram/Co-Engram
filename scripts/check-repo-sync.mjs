#!/usr/bin/env node
/**
 * 双仓基线分叉检测(2026-08-20,第三轮深思洞察 ③ 落地)
 *
 * 背景:co-engram-public(GitHub)与 co-engram-private(co-engram,走 gerrit)
 * 目录结构一致、靠人工 patch 同步。2026-08-19 实证 tabs.ts 基线分叉
 * (private 含梦境 tab 重排而 public 没有)—— 「同步必须 patch、禁用 cp
 * 整文件覆盖」只是文档纪律,分叉真实发生且无机制拦截。本脚本把纪律变
 * 成检测:对比两仓 packages/ 子树,分叉即非零退出(可挂 cron / CI)。
 *
 * 只比 packages/ 子树:根级(README/CI/package.json)存在公开/私有的
 * 预期差异,不在同步契约内。
 *
 * 用法:
 *   node scripts/check-repo-sync.mjs [--private <path>]
 *   私仓路径也可经 env CO_ENGRAM_PRIVATE_REPO 指定。
 * 退出码:0 = 基线一致;1 = 存在分叉;2 = 参数/路径错误。
 */
import { execSync } from "node:child_process";
import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";

const args = process.argv.slice(2);
let privateRepo = process.env.CO_ENGRAM_PRIVATE_REPO;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--private" && args[i + 1]) privateRepo = args[++i];
}
if (!privateRepo) {
  console.error("[sync-check] 缺少私仓路径:--private <path> 或 env CO_ENGRAM_PRIVATE_REPO");
  process.exit(2);
}

const publicRoot = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
const privatePkgs = join(privateRepo, "packages");
const publicPkgs = join(publicRoot, "packages");
for (const [label, p] of [["public", publicPkgs], ["private", privatePkgs]]) {
  if (!existsSync(p)) {
    console.error(`[sync-check] ${label} packages/ 不存在: ${p}`);
    process.exit(2);
  }
}

/** 构建噪音与本工具自身不在同步契约内的产物 */
const EXCLUDE = new Set(["node_modules", "dist", "pack", "coverage", ".co-engram", "--help"]);
const EXCLUDE_SUFFIX = [".tsbuildinfo", ".log"];

function walk(dir, base, out) {
  for (const name of readdirSync(dir)) {
    if (EXCLUDE.has(name)) continue;
    if (EXCLUDE_SUFFIX.some((s) => name.endsWith(s))) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full, base, out);
    } else {
      out.set(relative(base, full), createHash("sha256").update(readFileSync(full)).digest("hex"));
    }
  }
}

const pub = new Map();
walk(publicPkgs, publicPkgs, pub);
const priv = new Map();
walk(privatePkgs, privatePkgs, priv);

const onlyPublic = [...pub.keys()].filter((k) => !priv.has(k)).sort();
const onlyPrivate = [...priv.keys()].filter((k) => !pub.has(k)).sort();
const contentDiff = [...pub.keys()]
  .filter((k) => priv.has(k) && pub.get(k) !== priv.get(k))
  .sort();

const head = (repo) => {
  try {
    return execSync("git log --oneline -1", { cwd: repo, encoding: "utf8" }).trim();
  } catch {
    return "(git log 不可用)";
  }
};

console.log(`[sync-check] public  HEAD: ${head(publicRoot)}`);
console.log(`[sync-check] private HEAD: ${head(privateRepo)}`);
console.log(`[sync-check] 对比文件:public ${pub.size} / private ${priv.size}`);

const diverged = onlyPublic.length + onlyPrivate.length + contentDiff.length;
if (diverged === 0) {
  console.log("[sync-check] ✓ 两仓 packages/ 基线一致");
  process.exit(0);
}

console.log(`\n[sync-check] ✗ 基线分叉 ${diverged} 处:`);
for (const f of contentDiff) console.log(`  ≠ 内容不同   ${f}`);
for (const f of onlyPublic) console.log(`  + 仅 public  ${f}`);
for (const f of onlyPrivate) console.log(`  - 仅 private ${f}`);
console.log(
  `\n[sync-check] 同步指引:领先侧 git format-patch → 落后侧(worktree)git am + amend(Change-Id)→ push refs/for/master;禁用 cp 整文件覆盖。`,
);
process.exit(1);
