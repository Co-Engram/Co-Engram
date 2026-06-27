/**
 * OpenClaw 插件专属:auto-onboard bundle 路径解析。
 *
 * 核心逻辑(findGitRepoRoot / autoOnboardMergeDriver 等)在 `@co-engram/core/merge/auto-onboard`,
 * 这里只保留 host-specific 的 bundle 定位(取决于 host 的 node_modules 布局)。
 *
 * @module @co-engram/openclaw
 */

import { createRequire } from "node:module";
import { resolveMergeDriverBundle } from "@co-engram/core";

export {
  resolveMergeDriverBundle,
  findGitRepoRoot,
  autoOnboardMergeDriver,
  type AutoOnboardResult,
} from "@co-engram/core";

/**
 * 自动定位已安装的 `@co-engram/core` 中的 merge-driver bundle。
 *
 * 通过 `createRequire` 解析 `@co-engram/core/types` 子路径,exports 字段已暴露。
 * 该子路径只能 import 不能 require,所以显式传 `conditions: ['import','default']`。
 *
 * 失败(如 bundle 未构建 / 解析不到)返回 null,不抛错 —— auto-onboard 按跳过处理。
 */
export function findInstalledMergeDriverBundle(): string | null {
  try {
    const require = createRequire(import.meta.url);
    // @co-engram/core 的 exports 只声明 import 条件,默认 require.resolve 走 require 条件会失败。
    // 显式传 conditions 让 resolver 接受 import-only 入口。
    // Node 22 运行时支持 conditions,但部分 @types/node 版本未声明字段,所以做 unknown cast。
    const opts = { conditions: ["import", "default"] } as unknown as Parameters<
      typeof require.resolve
    >[1];
    const typesEntryPath = require.resolve("@co-engram/core/types", opts);
    const coreDistDir = typesEntryPath.replace(/\/types\/[^/]+$/, "");
    return resolveMergeDriverBundle(coreDistDir);
  } catch {
    return null;
  }
}
