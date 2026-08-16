/**
 * viewer holder-gating 启动(dsh 宿主)
 *
 * 与 MCP 路径同语义(mcp-server.ts:446-510):enabled ?? proposalEnabled;
 * 仅 holder 启动(18899 单端口契约);onLost 关闭让新 holder 接管。
 *
 * @module @co-engram/dsh
 */
import { startViewerServer } from "@co-engram/viewer";
import type { Language, ProcessLock, ToolContext } from "@co-engram/core";

export async function startHolderViewer(opts: {
  ctx: ToolContext;
  language: Language;
  dataRoot: string;
  viewerEnabled: boolean;
  token?: string;
  processLock: ProcessLock;
}): Promise<void> {
  if (!opts.viewerEnabled || !opts.processLock.isHolder) return;
  try {
    const runtime = await startViewerServer(opts.ctx, {
      language: opts.language,
      ...(opts.token ? { token: opts.token } : {}),
      dataRoot: opts.dataRoot,
    });
    process.stderr.write(
      `[co-engram] Viewer listening on http://127.0.0.1:${runtime.port}\n`,
    );
    opts.processLock.onLost(() => {
      runtime.stop().catch(() => {
        // ignore — 关闭失败不阻塞失去锁流程
      });
    });
  } catch (err) {
    // fail-soft:viewer 故障不阻塞工具服务(Task 1 实证行为)
    process.stderr.write(
      `[co-engram] Viewer failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}
