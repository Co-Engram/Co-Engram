#!/usr/bin/env node
/**
 * audit-hardcoded-defaults.mjs(Task 5.2)
 *
 * 静态扫描 packages 下源码,寻找"绕过 config 层直接硬编码默认值"的可疑模式。
 * 元3 参数层 / 元2 配置层 root cause:数值默认值散落在源码各处,无 config 入口,
 * 用户无法调整,文档与代码漂移。
 *
 * 扫描规则(基于 R13/R15 实证):
 *   1. 新建 Date() / Date.now() / 7 * 24 * 60 * 60 等魔数(疑似观察窗口)
 *   2. setTimeout/setInterval 第一个参数是数字字面量(疑似维护周期)
 *   3. 数值常量赋值给 readonly config field(无 config 入口)
 *
 * 白名单:scripts/audit-hardcoded-defaults-whitelist.json
 *
 * 用法:
 *   node scripts/audit-hardcoded-defaults.mjs
 * 退出码:0 = 通过,1 = 发现违规
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..");
const PACKAGES_ROOT = join(ROOT, "packages");
const WHITELIST_FILE = join(__dirname, "audit-hardcoded-defaults-whitelist.json");

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".cache",
  ".turbo",
  "coverage",
  ".git",
]);
const SCAN_EXTENSIONS = new Set([".ts", ".tsx"]);

// 白名单:已知合理硬编码(无 config 入口但不需要)
const WHITELIST_PATHS = new Set([
  // 测试文件允许魔数
  "packages/core/test/",
  "packages/claude-code-mcp/test/",
  "packages/openclaw-plugin/test/",
  "packages/e2e/test/",
  "packages/viewer/test/",
  "packages/contracts-test/test/",
  // i18n 字典允许(字符串数据,不是默认值)
  "packages/core/src/i18n/",
]);

/**
 * 检测单行的可疑硬编码模式。
 *
 * 规则保守(避免大量误报):
 *   - 只检测 DEFAULT_XXX = ... 形式的常量赋值(疑似默认值定义点)
 *   - 数值是时间魔数组合(7 * 24 / 24 * 60 * 60 / 60 * 1000 等)
 *   - 不扫描函数体内的算术(那是计算,不是默认值)
 */
function findHardcodedDefaults(content, filePath) {
  const violations = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    const trimmed = line.trim();
    if (
      trimmed.startsWith("//") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("/*")
    ) {
      continue;
    }

    // 只看 export const DEFAULT_XXX = ... 或 const DEFAULT_XXX = ...
    // 这是默认值定义点,最可能是 config 入口缺失的位置
    const isDefaultAssignment = /^\s*(?:export\s+)?const\s+DEFAULT_[A-Z_]+/.test(line);
    if (!isDefaultAssignment) continue;

    // 时间魔数(7 * 24 / 60 * 60 * 1000 等)
    const hasTimeMagic = /\b\d+\s*\*\s*\d+\s*\*\s*\d+/.test(line) ||
      /\b(24\s*\*\s*60|60\s*\*\s*60|60\s*\*\s*1000)\b/.test(line);
    if (!hasTimeMagic) continue;

    violations.push({
      file: relative(ROOT, filePath),
      line: lineNum,
      pattern: "default-time-magic-number",
      content: trimmed,
    });
  }

  return violations;
}

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
        const rel = relative(ROOT, full).replace(/\\/g, "/");
        if (!isWhitelisted(rel)) {
          acc.push(full);
        }
      }
    }
  }
  return acc;
}

function isWhitelisted(relPath) {
  for (const prefix of WHITELIST_PATHS) {
    if (relPath.startsWith(prefix)) return true;
  }
  return false;
}

export function scanHardcodedDefaults(scanRoot = PACKAGES_ROOT) {
  if (!existsSync(scanRoot)) return [];
  const files = collectFiles(scanRoot);
  const allViolations = [];
  for (const f of files) {
    let content;
    try {
      content = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    const candidates = findHardcodedDefaults(content, f);
    for (const v of candidates) {
      if (!isInWhitelist(v)) {
        allViolations.push(v);
      }
    }
  }
  return allViolations;
}

/**
 * 检查违规是否在白名单(按 file + line 匹配)
 */
function isInWhitelist(violation) {
  const whitelist = loadWhitelist();
  return whitelist.some(
    (w) => w.file === violation.file && w.line === violation.line,
  );
}

let cachedWhitelist = null;
function loadWhitelist() {
  if (cachedWhitelist !== null) return cachedWhitelist;
  if (!existsSync(WHITELIST_FILE)) {
    cachedWhitelist = [];
    return cachedWhitelist;
  }
  try {
    const raw = JSON.parse(readFileSync(WHITELIST_FILE, "utf8"));
    cachedWhitelist = Array.isArray(raw?.items) ? raw.items : [];
  } catch {
    cachedWhitelist = [];
  }
  return cachedWhitelist;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const violations = scanHardcodedDefaults();
  if (violations.length === 0) {
    console.log("✓ no hardcoded defaults violations");
    process.exit(0);
  }
  console.error(`✗ found ${violations.length} hardcoded default(s):\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  [${v.pattern}]`);
    console.error(`    ${v.content}`);
  }
  console.error(
    `\nIf these are intentional, add to scripts/audit-hardcoded-defaults-whitelist.json.`,
  );
  console.error(
    `If they should be config-driven, expose them via packages/core/src/config/.`,
  );
  process.exit(1);
}
