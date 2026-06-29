/**
 * i18n contract: zh ≡ en key parity + 无 hard-coded language ternary
 *
 * 验证两个不变量:
 *
 *   1. zh / en 字典 key 完全对齐(key parity)。
 *      缺一边会在编译期 `satisfies Readonly<Record<StringKey, string>>` 报错,
 *      但 contract test 作为运行时 regression guard,提供更易读的 diff。
 *
 *   2. 源码中无残留 `language === "zh" ? ... : ...` ternary(应使用 i18n key)。
 *      已 audit 的合法 selector 走 WHITELIST(buildZh/buildEn 函数分派、LLM 字典
 *      selector、批量 prompts 文案迁移 pending Task 5.5)。
 *
 * @module @co-engram/contracts-test
 */

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { zh, en } from "@co-engram/core";
import type { ContractResult, ContractDiff } from "./index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * 白名单:允许残留 `language === "zh" ?` 的文件
 *
 * 每条注明豁免理由,后续清理时 review。批量文案(prompts.ts / resources.ts 非
 * 错误段)统一在 Task 5.5 完成 i18n 化。
 */
const WHITELIST: readonly string[] = [
  // buildZh/buildEn 函数分派,本身是 language selector 不是 i18n key 候选
  "packages/claude-code-mcp/src/instructions.ts",
  // server 启动日志,开发者可见(stderr),非用户可见错误
  "packages/claude-code-mcp/src/mcp-server.ts",
  // 批量 prompts 文案,Task 5.5 统一迁移到 i18n
  "packages/claude-code-mcp/src/prompts.ts",
  // resource description + markdown section header + 空内容占位符
  // 这些是 resource payload 的展示文案,Task 5.5 与 prompts 一起迁移
  "packages/claude-code-mcp/src/resources.ts",
  // LLM 字典 selector —— 这就是用语言选字典,本质不是 i18n key
  "packages/core/src/tools/llm-descriptions.ts",
];

const SCAN_DIRS: readonly string[] = [
  "packages/core/src",
  "packages/claude-code-mcp/src",
  "packages/openclaw-plugin/src",
  "packages/viewer/src",
];

/**
 * 上溯查找 monorepo root(含 packages/ 的目录)
 *
 * 从 dist/ 上溯到 packages/contracts-test/ → packages/ → root。
 */
function findMonorepoRoot(startDir: string): string {
  let cur = startDir;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(cur, "packages"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  throw new Error(`monorepo root not found from ${startDir}`);
}

function listTsFiles(dir: string): readonly string[] {
  const out: string[] = [];
  let entries: readonly string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (
      entry.endsWith(".ts") &&
      !entry.endsWith(".test.ts") &&
      !entry.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

export async function runI18nContractTests(): Promise<ContractResult> {
  const diffs: ContractDiff[] = [];

  // 1. zh / en key parity
  const zhKeys = new Set(Object.keys(zh));
  const enKeys = new Set(Object.keys(en));
  for (const k of zhKeys) {
    if (!enKeys.has(k)) {
      diffs.push({
        kind: "i18n",
        detail: `key "${k}" 在 zh 字典有但 en 缺失`,
      });
    }
  }
  for (const k of enKeys) {
    if (!zhKeys.has(k)) {
      diffs.push({
        kind: "i18n",
        detail: `key "${k}" 在 en 字典有但 zh 缺失`,
      });
    }
  }

  // 2. 扫描硬编码 `language === "zh" ?` ternary
  const root = findMonorepoRoot(__dirname);
  for (const dir of SCAN_DIRS) {
    const fullPath = join(root, dir);
    if (!existsSync(fullPath)) continue;
    const files = listTsFiles(fullPath);
    for (const file of files) {
      const rel = relative(root, file);
      if (WHITELIST.includes(rel)) continue;
      const content = readFileSync(file, "utf8");
      // 匹配 `language === "zh" ?` 或 `language === 'zh' ?`(允许跨行空白)
      const matches = content.match(/language\s*===\s*["']zh["']\s*\?/g);
      if (matches && matches.length > 0) {
        diffs.push({
          kind: "i18n",
          detail: `${rel}: 发现 ${matches.length} 处 \`language === "zh" ?\` ternary(应使用 i18n key;如确属 selector 请加入 WHITELIST)`,
        });
      }
    }
  }

  return { passed: diffs.length === 0, diffs };
}
