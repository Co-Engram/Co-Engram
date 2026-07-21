/**
 * Build 后处理:tsc 之后写 dist/build-info.json,记录构建时间(ISO,精确到秒)。
 *
 * viewer html.ts 运行时读取该文件,在首页 footer 不突出展示「构建时间」。
 * 文件位于 dist 内(随 dist gitignored + 随 cp 部署),故跨部署仍准——
 * 比「读文件 mtime」可靠(mtime 在 cp 部署后会变成部署时间,非构建时间)。
 *
 * @module @co-engram/viewer/scripts/gen-build-info
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outFile = join(here, "..", "dist", "build-info.json");
mkdirSync(dirname(outFile), { recursive: true });
const buildTime = new Date().toISOString();
writeFileSync(outFile, JSON.stringify({ buildTime }, null, 2) + "\n", "utf8");
console.log(`[build-info] wrote ${outFile} (buildTime=${buildTime})`);
