/**
 * Build 后处理:把 src/hooks/*.py 复制到 dist/hooks/
 *
 * tsc 只编译 .ts,不会带 .py 静态资源。Claude Code hook 需要 .py 在
 * dist/hooks/ 下,以便 settings.json 引用 <package>/dist/hooks/observe.py。
 *
 * @module @co-engram/claude-code/scripts/copy-hooks
 */

import { copyFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src", "hooks");
const distDir = join(here, "..", "dist", "hooks");

if (!existsSync(srcDir)) {
  console.log("[copy-hooks] src/hooks/ not found, skipping");
  process.exit(0);
}

mkdirSync(distDir, { recursive: true });

const files = readdirSync(srcDir).filter((f) => f.endsWith(".py"));
for (const f of files) {
  copyFileSync(join(srcDir, f), join(distDir, f));
  console.log(`[copy-hooks] copied ${f} → dist/hooks/`);
}
