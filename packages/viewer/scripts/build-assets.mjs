/**
 * Build 预处理:把 src/assets/*.svg 生成 TS wrapper export
 *
 * 这样源 SVG 文件可以正常 diff/upgrade,build 后 dist 是自包含的(字符串字面量)。
 * 类似 build-vendor.mjs 的模式,但针对品牌 SVG。
 *
 * @module @co-engram/claude-code/scripts/build-assets
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const assetsDir = join(here, "..", "src", "assets");
const outFile = join(here, "..", "src", "brand-logos.ts");

if (!existsSync(assetsDir)) {
  console.log("[build-assets] src/assets/ not found, skipping");
  process.exit(0);
}

const svgs = readdirSync(assetsDir).filter((f) => f.endsWith(".svg"));
if (svgs.length === 0) {
  console.log("[build-assets] no .svg files in assets/, skipping");
  process.exit(0);
}

const lines = [
  "/* eslint-disable */",
  "/**",
  " * Auto-generated from src/assets/*.svg. Do not edit directly.",
  " *",
  " * 由 scripts/build-assets.mjs 生成;改 SVG 后跑 `pnpm build` 重新生成。",
  " */",
  "",
];

for (const svg of svgs) {
  const raw = readFileSync(join(assetsDir, svg), "utf8")
    .trim()
    // 把 svg 文件变成单行字符串字面量(更紧凑、减少 diff 噪音)
    .replace(/\s+/g, " ")
    // 转义反引号和 ${ (虽然 SVG 一般不会出现,但保险)
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, "\\${");
  const varName =
    svg
      .replace(/\.svg$/, "")
      .replace(/[-_]([a-z0-9])/g, (_, c) => c.toUpperCase())
      .toUpperCase() + "_SVG";
  lines.push(`export const ${varName} = \`${raw}\``);
  console.log(`[build-assets] ${svg} → ${varName} (${raw.length} bytes)`);
}

writeFileSync(outFile, lines.join("\n") + "\n", "utf8");
console.log(`[build-assets] wrote ${outFile}`);
