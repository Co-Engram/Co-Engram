#!/usr/bin/env node
/**
 * lint-no-readengram-in-loops.mjs
 *
 * 检测 `repo.readEngram(...)` 在循环 / 高阶回调内的 N+1 反模式。
 *
 * 历史背景(2026-07):多轮 viewer 卡死的根因是 readEngram 在循环里调用,
 * 在 1000+ engrams 规模下同步阻塞 event loop 30s+。批量重构
 * (readDigestBatch / readContentBatch / listEngramIndex + exists)已修复,
 * 本脚本防止同类反模式通过 code review 漏网后再次回潮。
 *
 * 检测策略:对每个 readEngram( 调用点,沿调用点向上回溯(默认 8 行),
 * 跟踪大括号深度。若在 readEngram 同一大括号上下文内出现未闭合的循环
 * 或高阶回调开头,则视为 N+1。
 *
 * 已知限制:模板字符串 / 多行字符串里的 { } 会被误算深度。建议用
 * `// noplus1: <reason>` 标记假阳性行。
 *
 * 用法:
 *   node scripts/lint-no-readengram-in-loops.mjs           # 扫描 packages/
 *   node scripts/lint-no-readengram-in-loops.mjs <path>     # 扫描指定目录
 *
 * 退出码:
 *   0 = 无违规
 *   1 = 发现违规(打印 file:line + 上下文)
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SCAN_ROOT = process.argv[2]
  ? join(ROOT, process.argv[2])
  : join(ROOT, "packages");

const LOOKBACK = 8;

const LOOP_OPENERS = [
  /\bfor\s*\(/,
  /\bwhile\s*\(/,
  /\bdo\s+\{/,
  /\.map\s*\(/,
  /\.forEach\s*\(/,
  /\.flatMap\s*\(/,
  /\.reduce\s*\(/,
  /\.some\s*\(/,
  /\.every\s*\(/,
  /\.filter\s*\(/,
];

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".cache",
  ".turbo",
  "coverage",
  ".git",
]);

const SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);

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
 * 从 readEngram 所在行 startLine 向上回溯,
 * 计算到达循环开头所需的未闭合 `{` 深度。
 *
 * 策略:从 startLine-1 开始向上,逐字符扫描 { },depth 起始为 1
 * (代表 readEngram 自己所在的最内层块)。遇到 } depth++,遇到 { depth--。
 * 当 depth > 当前所在层时,说明进入了外层块。记录每行的循环开头匹配,
 * 若扫描结束时仍在某个未闭合的循环块内,报违规。
 *
 * 简化版:回溯过程中记录"循环头位置"和它对应的深度。
 * 若某行匹配循环头,且该行的 `{` 在回溯过程中没有被 `}` 闭合到
 * readEngram 所在深度以下,则报违规。
 */
function findLoopViolation(lines, readEngramLineIdx) {
  // 从 readEngram 所在行向上扫,跟踪 brace 深度
  // depthFromReadEngram = 0 表示与 readEngram 同一层
  // 我们想知道:readEngram 所在层是否在某个循环体内
  let depth = 0;
  let sawLoopAtDepthGteZero = false;

  for (let i = readEngramLineIdx; i >= Math.max(0, readEngramLineIdx - LOOKBACK); i--) {
    const line = lines[i];
    // 统计本行的 { 和 }
    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;

    // 在 readEngram 行之上,本行的 { 比 } 多 → 说明 readEngram 在更深层
    // 等效于:本行打开的 { 没全部在本行闭合
    if (i < readEngramLineIdx) {
      // 检查本行是否是循环头
      const isLoop = LOOP_OPENERS.some((p) => p.test(line));
      if (isLoop) {
        // 若本行是循环头,且本行的 { 数 > } 数 → 循环体跨越多行
        // (常见的 `for (...) {` 这一行 opens=1, closes=0)
        if (opens > closes) {
          // 循环体未闭合,readEngram 在内部 → 违规
          // (前提:我们已经走到了循环头这一层)
          if (depth === 0) {
            sawLoopAtDepthGteZero = true;
            return { line: i, opener: line.trim() };
          }
        }
      }
      // 跨行深度变化(本行 net 是开 { 还是关 })
      depth += closes - opens;
      // depth < 0 表示我们已跳出 readEngram 所在的外层块,扫描终止
      if (depth < 0) break;
    }
  }
  return null;
}

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
    if (!line.includes("readEngram(")) continue;
    // opt-out 标记:readEngram 行或前 5 行包含 noplus1: 即视为合法例外
    // (5 行覆盖标准 // noplus1: 单行注释 + 多行 TODO 解释的常见模式)
    const contextWindow = lines.slice(Math.max(0, i - 5), i + 1).join("\n");
    if (contextWindow.includes("noplus1:")) continue;
    // 文档警告注释里出现 "readEngram" 字面量也跳过
    if (line.trim().startsWith("*") || line.trim().startsWith("//")) continue;

    const loop = findLoopViolation(lines, i);
    if (loop) {
      violations.push({
        file: relative(ROOT, filePath),
        line: i + 1,
        content: line.trim(),
        openerLine: loop.line + 1,
        opener: loop.opener,
      });
    }
  }
  return violations;
}

export function scanReadEngramInLoops(scanPath) {
  const root = scanPath ? join(ROOT, scanPath) : SCAN_ROOT;
  if (!existsSyncSafe(root)) return [];
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
  const violations = scanReadEngramInLoops(process.argv[2]);
  if (violations.length === 0) {
    console.log("✓ no readEngram-in-loop violations");
    process.exit(0);
  }
  console.error(`✗ found ${violations.length} readEngram-in-loop violation(s):\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    readEngram: ${v.content}`);
    console.error(`    opener    : ${v.opener}  (line ${v.openerLine})`);
  }
  console.error(
    `\nUse readDigestBatch / readContentBatch / listEngramIndex + exists instead.`,
  );
  console.error(
    `If this is a false positive, add // noplus1: <reason> to the readEngram line.`,
  );
  process.exit(1);
}
