/**
 * Config schema contract: host-only / deprecated 字段两端识别一致
 *
 * 攻击面:core 改了 config schema 后,一端识别某字段、另一端静默忽略,
 * 导致"我在 host A 配置 X,host B 看不到效果"的隐性 break。
 *
 * 本 contract 守住三个不变量:
 *
 *   1. **round-trip 加载**:包含所有 host-only + deprecated 字段的 config
 *      通过 loadAndSelfHealConfig 加载不崩溃(防止字段突然变 required)。
 *
 *   2. **deprecated 字段被丢弃**:viewer.port(已废弃,两宿主共享 persisted
 *      config 会抢端口)在 normalize 后必须不存在。
 *
 *   3. **host-only 字段保留**:toolsProfile / autoMemorySync(Claude Code MCP
 *      专用)在 normalize 后保留 —— loader 不应主动剔除另一 host 的字段。
 *
 *   4. **JSDoc 标记在场**:types.ts 里的 @deprecated / "Claude Code MCP" 标记
 *      不能因重构丢失(grep 检查,防止意外删除文档)。
 *
 * @module @co-engram/contracts-test
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadAndSelfHealConfig, createDefaultConfig } from "@co-engram/core";
import type { ContractResult, ContractDiff } from "./index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * 上溯查找 monorepo root(含 packages/ 的目录)
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

/**
 * types.ts 里 host-only / deprecated 字段应有的文档标记
 *
 * 每条:[字段名, 应在 types.ts 中出现的文档子串]
 * 重构时若意外删掉这些标记,contract test 抓得到。
 */
const DOCUMENTATION_MARKERS: ReadonlyArray<readonly [string, string]> = [
  // host-only 字段
  ["toolsProfile", "Claude Code MCP 工具暴露 profile"],
  ["autoMemorySync", "Claude Code MCP 专用"],
  // deprecated 字段
  ["viewer.port", "@deprecated 已废弃"],
];

export async function runConfigSchemaContractTests(): Promise<ContractResult> {
  const diffs: ContractDiff[] = [];
  const root = findMonorepoRoot(__dirname);

  // ─── 1. round-trip + drop deprecated + preserve host-only ───────────────
  const tmpDir = mkdtempSync(join(tmpdir(), "co-engram-cfg-contract-"));
  try {
    mkdirSync(join(tmpDir, ".co-engram"), { recursive: true });

    // 构造一个含所有 host-only + deprecated 字段的 config
    const fullConfig = {
      ...createDefaultConfig(),
      // host-only
      toolsProfile: "standard",
      autoMemorySync: { enabled: true, projectsRoot: "/tmp", debounceMs: 500 },
      // deprecated(应在 normalize 时被丢弃)
      viewer: { enabled: true, port: 9999, url: "http://example" },
    };
    writeFileSync(
      join(tmpDir, ".co-engram", "config.json"),
      JSON.stringify(fullConfig),
    );

    const { config: loaded } = await loadAndSelfHealConfig(tmpDir);

    // host-only 字段保留
    if (loaded.toolsProfile !== "standard") {
      diffs.push({
        kind: "config",
        detail: `host-only toolsProfile 应保留为 "standard",实际为 "${loaded.toolsProfile}"`,
      });
    }
    if (!loaded.autoMemorySync?.enabled) {
      diffs.push({
        kind: "config",
        detail: "host-only autoMemorySync.enabled 应保留,实际缺失或为 false",
      });
    }

    // deprecated viewer.port 必须被丢弃
    if (loaded.viewer?.port !== undefined) {
      diffs.push({
        kind: "config",
        detail: `deprecated viewer.port 应在 normalize 时丢弃,实际保留为 ${loaded.viewer.port}`,
      });
    }
    // viewer 其他字段保留
    if (loaded.viewer?.enabled !== true) {
      diffs.push({
        kind: "config",
        detail: "viewer.enabled 应保留,实际缺失或为 false",
      });
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  // ─── 2. JSDoc 标记在场 ───────────────────────────────────────────────────
  const typesSource = readFileSync(
    join(root, "packages/core/src/config/types.ts"),
    "utf8",
  );
  for (const [field, marker] of DOCUMENTATION_MARKERS) {
    if (!typesSource.includes(marker)) {
      diffs.push({
        kind: "config",
        detail: `${field}: 在 config/types.ts 中找不到文档标记 "${marker}"(可能因重构丢失)`,
      });
    }
  }

  return { passed: diffs.length === 0, diffs };
}
