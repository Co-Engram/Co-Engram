#!/usr/bin/env node
/**
 * verify-i18n-dist.mjs — 防止 i18n dist drift 的硬门
 *
 * 起因(2026-07):commit 53e3b04 把字典 key 从 purgeDismissedConfirm 改成
 * purgeConfirm,tabs.ts 调用点同步了,但运行中的 dist 没重新部署 → viewer
 * 里 T.t('viewer.proposals.batch.purgeConfirm') fallback 返回 key 本身,
 * 中文 UI 直接显示英文 key 名。这是 co-engram 第 5 个架构缺陷「i18n
 * dict-code drift」的典型表现(src 已改,dist 没跟上)。
 *
 * 本脚本解决「重新 build 后 dist 内容是否真的与 src 一致」这个问题:
 *   1. 从 src/i18n/zh.ts 文本提取 key 集合(正则)
 *   2. 动态 import dist/i18n/zh.js 拿到 build 后的 key 集合
 *   3. 比对,任何差异 → 退出码非零,打印详细 missing/extra
 *
 * 设计要点:
 *   - 同时检查 zh 和 en(core/src/i18n/{zh,en}.ts)
 *   - src 提取用正则,不依赖 tsx/jiti(零依赖)
 *   - dist 通过 file:// 动态 import,确保 dist 已编译且合法
 *   - 退出码非零时,deploy-co-engram.mjs 会 abort,防止部署半新半旧
 *
 * 退出码:
 *   0 — 全部对齐
 *   1 — dist 不存在(需先 build)
 *   2 — src 和 dist key 集合不一致(需重新 build)
 *
 * @module co-engram/scripts/verify-i18n-dist
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const CORE_PKG = join(ROOT, "packages", "core");

const SRC_FILES = {
  zh: join(CORE_PKG, "src", "i18n", "zh.ts"),
  en: join(CORE_PKG, "src", "i18n", "en.ts"),
};

const DIST_FILES = {
  zh: join(CORE_PKG, "dist", "i18n", "zh.js"),
  en: join(CORE_PKG, "dist", "i18n", "en.js"),
};

// 提取 src/i18n/zh.ts / en.ts 中所有顶层 "key": 字面量。
// 文件结构是 flat 的 `export const zh = { "key1": "...", ... }`,
// 没有 nested object,因此 `^\s*"key":` regex 安全。
const KEY_REGEX = /^\s*"([a-zA-Z0-9._-]+)":/gm;

async function extractSrcKeys(filePath) {
  const text = await readFile(filePath, "utf8");
  const keys = new Set();
  for (const match of text.matchAll(KEY_REGEX)) {
    keys.add(match[1]);
  }
  return keys;
}

async function extractDistKeys(filePath) {
  // 动态 import 拿到 build 后的 zh/en 对象,用 Object.keys 取 keys。
  // 加 query timestamp 防止 Node 的 module cache 把旧 dist 缓存住
  // (我们在一次会话里可能多次 build)。
  const url = `file://${filePath}?t=${Date.now()}`;
  const mod = await import(url);
  // zh.js / en.js 都 `export const zh = {...}` / `export const en = {...}`
  const dict = mod.zh ?? mod.en;
  if (!dict) {
    throw new Error(
      `${filePath} 未导出 zh 或 en(检查 build 是否正确生成)`,
    );
  }
  return new Set(Object.keys(dict));
}

function diff(setA, setB) {
  return [...setA].filter((k) => !setB.has(k)).sort();
}

async function checkOne(lang) {
  const srcPath = SRC_FILES[lang];
  const distPath = DIST_FILES[lang];

  if (!existsSync(distPath)) {
    console.error(`✗ ${lang}: dist 不存在(${distPath})`);
    console.error(`  请先 \`pnpm --filter @co-engram/core build\``);
    return 1;
  }

  const srcKeys = await extractSrcKeys(srcPath);
  const distKeys = await extractDistKeys(distPath);

  const missingInDist = diff(srcKeys, distKeys);
  const extraInDist = diff(distKeys, srcKeys);

  if (missingInDist.length === 0 && extraInDist.length === 0) {
    console.log(`✓ ${lang}: src 与 dist key 集合一致(${srcKeys.size} keys)`);
    return 0;
  }

  console.error(`✗ ${lang}: src 与 dist key 集合不一致`);
  console.error(`  src=${srcPath}`);
  console.error(`  dist=${distPath}`);
  if (missingInDist.length > 0) {
    console.error(
      `  src 有但 dist 缺(${missingInDist.length}): ${missingInDist.slice(0, 10).join(", ")}${missingInDist.length > 10 ? " ..." : ""}`,
    );
  }
  if (extraInDist.length > 0) {
    console.error(
      `  dist 有但 src 无(${extraInDist.length},可能旧 key 残留): ${extraInDist.slice(0, 10).join(", ")}${extraInDist.length > 10 ? " ..." : ""}`,
    );
  }
  console.error(`  → 重新 build: \`pnpm --filter @co-engram/core build\``);
  return 2;
}

async function main() {
  console.log("━ verify-i18n-dist: 检查 src 与 dist 字典 key 集合一致性 ━");

  // 预检:dist 目录是否存在
  if (!existsSync(join(CORE_PKG, "dist"))) {
    console.error(`✗ core/dist 不存在,请先 \`pnpm --filter @co-engram/core build\``);
    process.exit(1);
  }

  const zhCode = await checkOne("zh");
  if (zhCode !== 0) process.exit(zhCode);

  const enCode = await checkOne("en");
  if (enCode !== 0) process.exit(enCode);

  // 跨语言 sanity:zh 和 en key 集合必须一致(core 自己也断言这件事)
  const zhSrc = await extractSrcKeys(SRC_FILES.zh);
  const enSrc = await extractSrcKeys(SRC_FILES.en);
  const zhMissingEn = diff(zhSrc, enSrc);
  const enMissingZh = diff(enSrc, zhSrc);
  if (zhMissingEn.length > 0 || enMissingZh.length > 0) {
    console.error(`✗ zh 与 en key 集合不一致`);
    if (zhMissingEn.length > 0)
      console.error(`  zh 有但 en 缺: ${zhMissingEn.join(", ")}`);
    if (enMissingZh.length > 0)
      console.error(`  en 有但 zh 缺: ${enMissingZh.join(", ")}`);
    process.exit(2);
  }

  console.log(`✓ zh 与 en key 集合一致(各 ${zhSrc.size} keys)`);
  console.log("✓ i18n dist 一致性检查通过");
}

main().catch((err) => {
  console.error("verify-i18n-dist: 意外错误:", err);
  process.exit(1);
});
