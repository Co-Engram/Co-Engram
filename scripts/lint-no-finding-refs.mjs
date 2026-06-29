#!/usr/bin/env node
/**
 * lint-no-finding-refs.mjs(Task 4.3)
 *
 * 扫描 packages 下所有 .ts 文件,检测 "Finding N/M" 引用,违规即报错。
 *
 * 反应式修复文化(元1 组织层)的投影:源码注释引用内部审计编号
 * (Finding 264/265、Finding 107/111、Finding 156/157 等)说明该问题
 * 是靠挑剔用户测试发现后再修——而非设计阶段预防。把编号留在源码里
 * 会持续提醒"我们仍在反应式模式",并污染代码可读性(读者不知道
 * "Finding 156/157" 指什么)。
 *
 * 用法:
 *   node scripts/lint-no-finding-refs.mjs            # 扫描 packages/
 *   node scripts/lint-no-finding-refs.mjs <path>      # 扫描指定目录
 *
 * 退出码:
 *   0 = 无违规
 *   1 = 发现违规(打印 file:line + 内容)
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SCAN_ROOT = process.argv[2]
  ? join(ROOT, process.argv[2])
  : join(ROOT, "packages");

const FINDING_REF = /\bFinding\s+\d+\/\d+\b/g;

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".cache",
  ".turbo",
  "coverage",
  ".git",
]);

const SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);

/**
 * 递归收集所有源码文件
 */
function collectFiles(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, acc);
    } else if (entry.isFile()) {
      const ext = entry.name.slice(entry.name.lastIndexOf("."));
      if (SCAN_EXTENSIONS.has(ext)) {
        acc.push(full);
      }
    }
  }
  return acc;
}

/**
 * 扫描单个文件,返回违规列表
 */
function scanFile(filePath) {
  const violations = [];
  let content;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return violations;
  }
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const matches = line.match(FINDING_REF);
    if (matches) {
      for (const m of matches) {
        violations.push({
          file: relative(ROOT, filePath),
          line: i + 1,
          ref: m,
          content: line.trim(),
        });
      }
    }
  }
  return violations;
}

/**
 * 主入口:扫描 + 报告
 *
 * 导出 scanFindingRefs 便于测试;main 是 CLI 入口。
 */
export function scanFindingRefs(scanPath) {
  const root = scanPath
    ? join(ROOT, scanPath)
    : SCAN_ROOT;
  if (!existsSyncSafe(root)) {
    return [];
  }
  const files = collectFiles(root);
  const allViolations = [];
  for (const f of files) {
    allViolations.push(...scanFile(f));
  }
  return allViolations;
}

function existsSyncSafe(p) {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const violations = scanFindingRefs(process.argv[2]);
  if (violations.length === 0) {
    console.log("✓ no 'Finding N/M' refs found");
    process.exit(0);
  }
  console.error(`✗ found ${violations.length} 'Finding N/M' ref(s):\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  [${v.ref}]`);
    console.error(`    ${v.content}`);
  }
  console.error(
    `\nRewrite these as descriptive comments. See Task 4.3 rationale.`,
  );
  process.exit(1);
}
