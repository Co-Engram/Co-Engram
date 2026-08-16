/**
 * @co-engram/dsh —— DeepSeek Harness 原生 Cordis 插件
 *
 * 用法(cordis.patch.yml):
 *   - insert:
 *       - id: co-engram
 *         name: '@co-engram/dsh'
 *         config:
 *           language: en        # 或 zh
 *
 * 注册:38 个裸名记忆工具(engram_*)到 ctx.tools;
 * 注入:memory:co-engram system prompt 段(prompt-signals 每次组装动态求值);
 * 协调:与 claude-code-mcp / openclaw-plugin 共享 dataRoot,ProcessLock 选 holder。
 *
 * @module @co-engram/dsh
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { DshRuntime } from "./bootstrap.js";
import { createDshRuntime } from "./bootstrap.js";
import { adaptAllTools } from "./adapter.js";
import { createCoEngramPromptSection } from "./prompt.js";
import { startHolderViewer } from "./viewer.js";

/** cordis Context 的最小消费面(openclaw-plugin 同款最小接口惯例,零宿主运行时依赖) */
interface ContextLike {
  readonly tools: {
    register: (definition: unknown) => () => void;
  };
  readonly systemPrompt: {
    section: (section: {
      name: string;
      order: number;
      text: string | ((asmCtx: unknown) => string);
    }) => () => void;
  };
  readonly effect: (fn: () => () => void, label: string) => () => void;
}

/** dsh 配置(宽容解析;详细字段见包 README) */
interface DshHostConfig {
  readonly language?: string;
  readonly defaultCreatedBy?: string;
  readonly startMaintenance?: boolean;
  readonly auditEnabled?: boolean;
  readonly effectivenessEnabled?: boolean;
  readonly proposalEnabled?: boolean;
  readonly autoOnboardMergeDriver?: boolean;
  readonly startViewer?: boolean;
  readonly viewerToken?: string;
}

export const inject = ["tools", "systemPrompt"];

export async function apply(
  ctx: ContextLike,
  config: DshHostConfig = {},
): Promise<void> {
  const testRoot = process.env.CO_ENGRAM_TEST_DATAROOT;
  const runtime: DshRuntime = await createDshRuntime({
    language: config.language === "zh" ? "zh" : "en",
    ...(config.defaultCreatedBy
      ? { defaultCreatedBy: config.defaultCreatedBy }
      : {}),
    startMaintenance: config.startMaintenance !== false,
    auditEnabled: config.auditEnabled !== false,
    effectivenessEnabled: config.effectivenessEnabled !== false,
    proposalEnabled: config.proposalEnabled !== false,
    autoOnboardMergeDriver: config.autoOnboardMergeDriver !== false,
    ...(testRoot ? { dataRootOverrideForTest: testRoot } : {}),
  });

  // 工具注册(defineTool 官方工厂:DSL→JSON Schema + 注册期校验;
  // ctx.tools.register 直接强校验 JSON Schema 契约,不经工厂需自行复刻转换)
  const defs = adaptAllTools(runtime.tools, runtime.ctx, runtime.language);
  for (const def of defs) {
    ctx.tools.register(
      defineTool({
        name: def.name,
        description: def.description,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        parameters: def.parameters as any,
        output: {
          schema: { type: "json" },
          render: (_args, value) => [
            { type: "text", text: JSON.stringify(value, null, 2) },
          ],
        },
        async execute(args, exec) {
          // core 工具返回值即 lossless JSON(序列化为 MCP text 的同一产物)
          return def.execute(args, { signal: exec.signal }) as Promise<never>;
        },
      }),
    );
  }

  // prompt-signals 段(每次组装动态求值)
  ctx.systemPrompt.section(createCoEngramPromptSection(runtime));

  // 启动 banner(对齐 claude-code-mcp 的 Loaded 惯例,便于用户确认插件生效)
  try {
    const engramCount = runtime.ctx.repository.listEngrams().length;
    process.stderr.write(
      `[co-engram] dsh plugin active: ${engramCount} engrams, ${defs.length} tools registered (host=dsh-plugin)\n`,
    );
  } catch {
    // logging 失败不阻塞
  }

  // viewer(holder gating,fire-and-forget 不阻塞激活)
  const viewerEnabled =
    config.startViewer ?? (config.proposalEnabled !== false);
  void startHolderViewer({
    ctx: runtime.ctx,
    language: runtime.language,
    dataRoot: runtime.dataRoot,
    viewerEnabled,
    ...(config.viewerToken ? { token: config.viewerToken } : {}),
    processLock: runtime.processLock,
  });

  // 插件 dispose → runtime 资源释放(watcher/maintenance/rotation/锁)
  ctx.effect(() => () => runtime.stop(), "co-engram-dsh.runtime");
}
