/**
 * OpenClaw Viewer 适配(M4)
 *
 * 通过 dynamic import 从 @co-engram/viewer 加载 host-agnostic viewer 实现,
 * 与 @co-engram/claude-code 共享同一份 viewer 源码。
 *
 * @module @co-engram/openclaw
 */

import type { Language, ToolContext } from "@co-engram/core";
import type { ViewerConfig } from "./types.js";

/** Viewer 运行时句柄(动态加载,类型宽松) */
export interface ViewerRuntime {
  readonly port: number;
  readonly stop: () => Promise<void>;
}

/**
 * 启动 viewer HTTP server
 *
 * 内部调用 @co-engram/viewer 的 startViewerServer。
 *
 * @throws 如果 @co-engram/viewer 未安装
 */
export async function startViewerForOpenClaw(
  ctx: ToolContext,
  config: ViewerConfig & {
    readonly language?: Language;
    readonly dataRoot?: string;
  } = {},
): Promise<ViewerRuntime> {
  const mod = await dynamicImportViewer();
  return mod.startViewerServer(ctx, config);
}

/**
 * 渲染 SPA HTML(仅用于测试 / 在 viewer 不可用时展示占位)
 *
 * 与 @co-engram/viewer 的 renderSpaHtml 保持同构。
 */
export async function renderViewerHtml(
  options: {
    readonly tokenRequired?: boolean;
    readonly language?: Language;
  } = {},
): Promise<string> {
  const mod = await dynamicImportViewer();
  return mod.renderSpaHtml(options);
}

/** 动态加载 viewer 模块(隔离类型,避免编译期依赖) */
async function dynamicImportViewer(): Promise<{
  readonly startViewerServer: (
    ctx: ToolContext,
    config: {
      readonly port?: number;
      readonly token?: string;
      readonly language?: Language;
      readonly dataRoot?: string;
    },
  ) => Promise<ViewerRuntime>;
  readonly renderSpaHtml: (options: {
    readonly tokenRequired?: boolean;
    readonly language?: Language;
  }) => string;
}> {
  try {
    // 用字符串变量名避免 TypeScript 把它视为静态依赖
    const specifier = "@co-engram/viewer";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import(specifier);
    if (typeof mod.startViewerServer !== "function") {
      throw new Error("@co-engram/viewer missing startViewerServer export");
    }
    return mod as {
      startViewerServer: (
        ctx: ToolContext,
        config: {
          readonly port?: number;
          readonly token?: string;
          readonly language?: Language;
          readonly dataRoot?: string;
        },
      ) => Promise<ViewerRuntime>;
      renderSpaHtml: (options: {
        readonly tokenRequired?: boolean;
        readonly language?: Language;
      }) => string;
    };
  } catch (err) {
    throw new Error(
      `Failed to load @co-engram/viewer. Install it first: pnpm add @co-engram/viewer. Cause: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
