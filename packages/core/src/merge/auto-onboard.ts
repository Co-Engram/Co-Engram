/**
 * Auto-onboard primitives:跨 host(openclaw-plugin / claude-code-mcp)共享的
 * merge driver 自动安装逻辑。
 *
 * 设计目标(匹配用户 low-friction-defaults 偏好):
 *   - 默认开启(host config.autoOnboardMergeDriver 默认 true)
 *   - 零手动步骤:首次启动就把 bundle / .gitattributes / .git/config 全部装好
 *   - 幂等:installMergeDriver 本身幂等,所以每次启动都跑也无副作用
 *   - 失败不阻塞 host:onboard 抛错时返回 error 字段,host 决定如何记录
 *
 * Host 自己负责 bundle 路径解析(取决于 host 的 node_modules 布局 / require.resolve 上下文)。
 *
 * @module @co-engram/core/merge
 */

import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { installMergeDriver } from "./onboard.js";
import { installPostMergeHook } from "./post-merge-hook.js";

/**
 * 解析 merge-driver bundle 的源路径。
 *
 * 调用方传入 `@co-engram/core` 的入口 dist 目录,bundle 就在它的 `merge-driver.cjs`。
 * 如果该路径不存在(例如 monorepo 未构建),返回 null,调用方按"装不上"处理。
 */
export function resolveMergeDriverBundle(coreDistDir: string): string | null {
  const candidate = `${coreDistDir}/merge-driver.cjs`;
  return existsSync(candidate) ? candidate : null;
}

/**
 * 从 dataRoot 起向上找最近的 git 仓库根。
 *
 * 找到 .git 目录(文件或目录)就返回该目录;到根目录都没找到就返回 null。
 */
export function findGitRepoRoot(dataRoot: string): string | null {
  let cur = dataRoot;
  for (let i = 0; i < 32; i++) {
    if (existsSync(`${cur}/.git`)) return cur;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}

export interface AutoOnboardResult {
  /** 是否执行了 onboard。false 表示跳过(不是 git repo / bundle 缺失)。 */
  readonly attempted: boolean;
  /** 找到的 git repo root,attempted=true 时必有。 */
  readonly repoRoot?: string;
  /** bundle 是否升级(true=新装或版本不同,false=版本相同跳过)。 */
  readonly bundleUpgraded?: boolean;
  /** .gitattributes 是否被新增条目。 */
  readonly gitattributesUpdated?: boolean;
  /** post-merge hook 是否在本次 onboard 中安装/覆盖(true=主路径或 sidecar 落地)。 */
  readonly postMergeHookInstalled?: boolean;
  /** 错误信息(onboard 抛错时填,host 不应崩溃)。 */
  readonly error?: string;
}

/**
 * 自动 onboard merge driver + post-merge hook。
 *
 * 行为:
 *   1. 找 dataRoot 所在 git repo(找不到就 noop)
 *   2. 验证 bundle 源存在(不存在就 noop)
 *   3. 调 installMergeDriver
 *   4. 调 installPostMergeHook —— 让 git pull 后自动跑 runPostMergeCheck,
 *      后者会调 runDoctor 重建索引,补齐"git pull 拉到新 .md → engram-index.json
 *      漏更新"的最后一公里(spec §7.5 + index-no-truth 架构缺陷修复)
 *
 * 任何步骤抛错都返回 `{ attempted: true, error: msg }`,不向上抛。
 * post-merge hook 安装失败不影响 merge driver 已装好的状态。
 */
export function autoOnboardMergeDriver(params: {
  dataRoot: string;
  bundleSourcePath: string;
  /** 可选:跳过 git repo 检测,直接认为 dataRoot 就是 repo root(测试用) */
  readonly repoRootOverride?: string;
}): AutoOnboardResult {
  const { dataRoot, bundleSourcePath, repoRootOverride } = params;

  const repoRoot = repoRootOverride ?? findGitRepoRoot(dataRoot);
  if (!repoRoot) {
    return { attempted: false };
  }
  if (!existsSync(bundleSourcePath)) {
    return { attempted: false };
  }

  let postMergeHookInstalled = false;
  let driverStats:
    | { bundleUpgraded: boolean; gitattributesUpdated: boolean }
    | undefined;
  let onboardError: string | undefined;

  try {
    driverStats = installMergeDriver({ repoRoot, bundleSourcePath });
  } catch (e) {
    onboardError = e instanceof Error ? e.message : String(e);
  }

  // merge driver 失败不阻塞 post-merge hook 安装(两者解决不同问题,
  // 用户至少要享受到 post-merge 索引同步的能力)。但任一失败都记到 error 字段。
  try {
    installPostMergeHook({ repoRoot });
    postMergeHookInstalled = true;
  } catch (e) {
    const hookError = e instanceof Error ? e.message : String(e);
    onboardError = onboardError
      ? `${onboardError}; ${hookError}`
      : hookError;
  }

  return {
    attempted: true,
    repoRoot,
    postMergeHookInstalled,
    ...(driverStats !== undefined
      ? {
          bundleUpgraded: driverStats.bundleUpgraded,
          gitattributesUpdated: driverStats.gitattributesUpdated,
        }
      : {}),
    ...(onboardError !== undefined ? { error: onboardError } : {}),
  };
}
