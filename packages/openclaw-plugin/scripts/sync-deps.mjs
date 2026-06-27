#!/usr/bin/env node
/**
 * 把 openclaw-plugin 的 workspace 依赖从 pnpm symlink 替换为实际拷贝。
 *
 * 背景:openclaw 安装插件时会扫描 node_modules,拒绝包含指向 install root 外的
 * symlink(`manifest dependency scan found node_modules symlink target outside
 * install root`)。pnpm workspace 默认用 symlink,所以需要这一步把
 * @co-engram/core / @co-engram/viewer / yaml / zod / ulid 等运行时依赖"实拷贝"。
 *
 * 行为(idempotent,可重复跑):
 *   1. 对每个目标包:resolve 真实位置(createRequire + require.resolve)
 *   2. 删除 openclaw-plugin/node_modules/<pkg> 当前内容(可能是 symlink)
 *   3. fs.cpSync 真实位置 → node_modules/<pkg>(排除嵌套 node_modules / .git / 测试文件)
 *   4. 删除拷贝结果中的嵌套 node_modules(避免 openclaw 扫描器递归解析)
 *
 * 用法:
 *   pnpm --filter @co-engram/openclaw sync-deps        # 标准用法
 *   node ./scripts/sync-deps.mjs --check               # 只检查,不修改
 *   node ./scripts/sync-deps.mjs --force               # 强制重做(即使已是实拷贝)
 *
 * @module @co-engram/openclaw/scripts/sync-deps
 */
import { createRequire } from "node:module";
import {
  cpSync,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PKG_ROOT = resolve(__dirname, "..");
const NM = resolve(PKG_ROOT, "node_modules");

/** 需要实拷贝的运行时依赖(直接 + 传递) */
const TARGETS = ["@co-engram/core", "@co-engram/viewer", "yaml", "zod", "ulid"];

/** 拷贝时跳过的目录名 */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".cache",
  "test",
  "tests",
  "__tests__",
  ".tshy",
  ".tshy-build",
]);

/** 拷贝时跳过的文件后缀 */
const SKIP_SUFFIXES = [
  ".test.ts",
  ".test.js",
  ".test.d.ts",
  ".spec.ts",
  ".spec.js",
  ".tsbuildinfo",
  ".map",
];

function parseArgs(argv) {
  const flags = { check: false, force: false };
  for (const arg of argv.slice(2)) {
    if (arg === "--check") flags.check = true;
    else if (arg === "--force") flags.force = true;
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write(`co-engram openclaw sync-deps

Usage:
  sync-deps [options]

Options:
  --check   Only print current state, do not modify anything
  --force   Re-copy even if target is already a real directory
  --help    Show this help

Targets (copied from pnpm symlink → real files):
${TARGETS.map((t) => `  - ${t}`).join("\n")}
`);
      process.exit(0);
    }
  }
  return flags;
}

/** 通过读 node_modules/<pkg>/package.json 找到包根目录(穿透 pnpm symlink) */
function resolvePackageRoot(pkgName) {
  const directPath = join(NM, pkgName);
  if (!existsSync(directPath)) return null;

  // 处理 symlink 情况:readlinksync 取 target
  const stat = lstatSync(directPath);
  let realPath;
  if (stat.isSymbolicLink()) {
    realPath = readlinkSync(directPath);
    // 相对 symlink:相对于 symlink 父目录解析
    if (!realPath.startsWith("/")) {
      realPath = resolve(dirname(directPath), realPath);
    }
  } else {
    // 已经是实拷贝,直接用
    realPath = directPath;
  }

  // 验证 realPath 下有 package.json 且 name 匹配
  const pkgJsonPath = join(realPath, "package.json");
  if (!existsSync(pkgJsonPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
    if (pkg.name === pkgName) return realPath;
  } catch {}
  return null;
}

/** 判断 node_modules/<pkg> 当前是否已经是实拷贝(非 symlink 且非空) */
function isRealCopy(pkgName) {
  const target = join(NM, pkgName);
  if (!existsSync(target)) return false;
  const stat = lstatSync(target);
  return stat.isDirectory() && !stat.isSymbolicLink();
}

/** 过滤掉测试文件和构建缓存 */
function filterCopy(src, dest) {
  const base = src.split("/").pop();
  if (SKIP_DIRS.has(base)) return false;
  for (const suf of SKIP_SUFFIXES) {
    if (src.endsWith(suf)) return false;
  }
  return true;
}

/** 拷贝后清理嵌套 node_modules(.pnpm 有时通过 dependencies 嵌入) */
function cleanNestedNodeModules(rootPath) {
  if (!existsSync(rootPath)) return;
  const stack = [rootPath];
  while (stack.length > 0) {
    const cur = stack.pop();
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (ent.name === "node_modules" && ent.isDirectory()) {
        const nested = join(cur, ent.name);
        rmSync(nested, { recursive: true, force: true });
        process.stdout.write(
          `    cleaned nested: ${relative(PKG_ROOT, nested)}\n`,
        );
        continue;
      }
      if (ent.isDirectory()) {
        stack.push(join(cur, ent.name));
      }
    }
  }
}

function syncOne(pkgName, { check, force }) {
  const target = join(NM, pkgName);
  const status = { pkg: pkgName, action: "noop", reason: "" };

  const realPath = resolvePackageRoot(pkgName);
  if (!realPath) {
    status.action = "skip";
    status.reason = "cannot resolve (not installed?)";
    return status;
  }

  if (check) {
    status.action = isRealCopy(pkgName) ? "real-copy" : "symlink-or-missing";
    status.reason = `real=${realPath}`;
    return status;
  }

  if (isRealCopy(pkgName)) {
    // 已经是实拷贝:无需重做。
    // --force 对实拷贝无效,因为 resolvePackageRoot 返回的 realPath 就是 target 自身,
    // rm 后 cp 会 ENOENT。若需重做,先 `pnpm install` 恢复 symlink 再 sync。
    status.action = "noop";
    status.reason = force
      ? "already real-copy (force-noop; run `pnpm install` first to redo)"
      : "already real-copy";
    return status;
  }

  // 删除现有(symlink 或目录)
  if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true });
  }

  // 实拷贝
  cpSync(realPath, target, {
    recursive: true,
    filter: filterCopy,
    dereference: true,
  });
  // 清理嵌套 node_modules
  cleanNestedNodeModules(target);

  status.action = "copied";
  status.reason = `from ${relative(PKG_ROOT, realPath)}`;
  return status;
}

function main() {
  const flags = parseArgs(process.argv);
  process.stdout.write(
    `[sync-deps] mode=${flags.check ? "check" : flags.force ? "force" : "sync"} pkg=${PKG_ROOT}\n`,
  );
  let copied = 0;
  let skipped = 0;
  let failed = 0;
  for (const pkg of TARGETS) {
    const r = syncOne(pkg, flags);
    const tag =
      r.action === "copied"
        ? "✓"
        : r.action === "real-copy"
          ? "="
          : r.action === "symlink-or-missing"
            ? "!"
            : r.action === "skip"
              ? "x"
              : "-";
    process.stdout.write(
      `  ${tag} ${pkg.padEnd(20)} ${r.action}  ${r.reason}\n`,
    );
    if (r.action === "copied") copied++;
    else if (r.action === "skip") failed++;
    else if (r.action === "symlink-or-missing") skipped++;
  }
  process.stdout.write(
    `[sync-deps] done: ${copied} copied, ${skipped} symlink-or-missing, ${failed} skip\n`,
  );
}

main();
