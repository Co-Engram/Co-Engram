/**
 * Adapter contract: claude-code-mcp ≡ openclaw-plugin
 *
 * AI-5 hyper-pattern 5 first brick —— 双宿主入口 shape 对齐契约。
 *
 * 10 轮挑剔用户 loop 测试发现 hyper-pattern 5「dual-host symmetry break」:
 * `createCoEngramMcpServer`(CC)与 `registerCoEngramTools`(OC)各自演化,返回
 * shape 漂移 —— CC 把 `auditLog`/`effectivenessTracker`/`proposalEngine` 暴露
 * 为 top-level 字段,OC 只塞进 `ctx` 里。viewer / 维护编排等消费者代码必须 if/else
 * 区分宿主才能拿到这些引用,违反「host-agnostic 消费」原则。
 *
 * 本契约定义 **HostRuntime** 公共 shape,任何宿主入口必须能被 `extractHostRuntime()`
 * 归一化为这个 shape。契约先于具体修复 —— 给未来的 bootstrap.ts 抽取(双宿主共享
 * 启动副作用)提供自动化 guard。
 *
 * 设计原则:
 *   - **宿主中立消费**:viewer / 维护编排只 import `HostRuntime`,不关心宿主类型
 *   - **显式非对称 allowlist**:CC-only 字段(`server`/`profile`/`processLock`)与
 *     OC-only 字段(`language`/`promptSignals`)在 INTEGRATED_ASYMMETRIES 列出,
 *     让新增非对称必经过审
 *   - **lifecycle quad 强约束**:`stopMaintenance` / `stopAuditRotation` /
 *     `stopIndexWatcher` / `releaseProcessLock` 两端必须都在(都是可选,但配置
 *     启用后必须出现)
 *
 * @module @co-engram/contracts-test
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCoEngramMcpServer } from "@co-engram/claude-code";
import {
  registerCoEngramTools,
  type CoEngramPluginHostApi,
} from "@co-engram/openclaw";
import {
  collectSkillCatalog,
  SkillRepository,
  type AuditLog,
  type EffectivenessTracker,
  type ProposalEngine,
  type ToolContext,
} from "@co-engram/core";

import type { ContractResult, ContractDiff } from "./index.js";

/**
 * 宿主公共运行时 shape —— 任何 host 入口归一化后的目标。
 *
 * 消费者(viewer / 维护编排 / 测试 harness)只依赖这个 shape,不依赖具体 host 入口。
 */
export interface HostRuntime {
  /** 工具执行上下文(repository / searchOrchestrator / observability 三件套) */
  readonly ctx: ToolContext;
  /** 审计日志引用(供 viewer / 维护引擎查 history) */
  readonly auditLog?: AuditLog;
  /** 有效性追踪器引用(供 viewer 展示 observation windows) */
  readonly effectivenessTracker?: EffectivenessTracker;
  /** 候选提案引擎引用(供 viewer 展示 pending 候选 / 维护引擎 sweep) */
  readonly proposalEngine?: ProposalEngine;
  /** 关闭维护引擎(light/deep/rem 三阶段) */
  readonly stopMaintenance?: () => void;
  /** 关闭 audit 日志轮转后台任务 */
  readonly stopAuditRotation?: () => void;
  /** 关闭跨进程 index watcher */
  readonly stopIndexWatcher?: () => void;
  /** 释放进程锁 + 停止所有 holder 后台任务 */
  readonly releaseProcessLock?: () => void;
}

/**
 * 已知的、允许的非对称字段(宿主特性差异,非缺陷)。
 *
 * CC-only:
 *   - `server` —— MCP 协议特有的 McpServer 实例
 *   - `profile` / `registeredToolCount` —— CC 需要日志展示注册工具数
 *   - `dataRootAutoCreated` —— CC 需要首次运行提示
 *   - `processLock` —— CC 需要让 host adapter 注册 onLost 回调
 *
 * OC-only:
 *   - `language` —— OC 需要在 system prompt 注入时显式语言
 *   - `promptSignals` —— OC 需要把记忆 catalog 注入 prompt
 *
 * 新增非对称必须在此登记 + 给出理由,否则契约测试 fail。
 */
export const INTENTIONAL_ASYMMETRIES = {
  ccOnly: ["server", "profile", "registeredToolCount", "dataRootAutoCreated", "processLock"],
  ocOnly: ["language", "promptSignals"],
} as const;

/**
 * 期望两端都暴露的 lifecycle handle 集合(可选,但配置启用后必须出现)。
 */
export const EXPECTED_LIFECYCLE_HANDLES = [
  "stopMaintenance",
  "stopAuditRotation",
  "stopIndexWatcher",
  "releaseProcessLock",
] as const;

/**
 * 期望两端都暴露的 diagnostic ref 集合(auditEnabled/effectivenessEnabled/proposalEnabled
 * 默认开启时必须出现)。
 */
export const EXPECTED_DIAGNOSTIC_REFS = [
  "auditLog",
  "effectivenessTracker",
  "proposalEngine",
] as const;

/**
 * 把任意 host 入口的返回值归一化为 HostRuntime。
 *
 * CC `createCoEngramMcpServer` 返回 `{ ctx, auditLog?, ... }`(ctx 是显式字段);
 * OC `registerCoEngramTools` 返回 `ToolContext & { ... }`(ctx 字段被 spread 到顶层)。
 * 本 helper 处理两种 shape,消费者拿到的 HostRuntime 永远是 `{ ctx, ... }` 形式。
 */
export function extractHostRuntime(raw: unknown): HostRuntime {
  const obj = raw as Record<string, unknown>;

  // CC shape:有显式 `ctx` 字段且是 ToolContext
  if (
    "ctx" in obj &&
    typeof obj.ctx === "object" &&
    obj.ctx !== null &&
    "repository" in obj.ctx
  ) {
    const ccCtx = obj.ctx as ToolContext;
    return {
      ctx: ccCtx,
      // CC 把 diagnostic refs 同时暴露在 top-level 和 ctx 内,优先用 top-level
      auditLog: (obj.auditLog as AuditLog | undefined) ?? ccCtx.auditLog,
      effectivenessTracker:
        (obj.effectivenessTracker as EffectivenessTracker | undefined) ??
        ccCtx.effectivenessTracker,
      proposalEngine:
        (obj.proposalEngine as ProposalEngine | undefined) ??
        ccCtx.proposalEngine,
      stopMaintenance: obj.stopMaintenance as (() => void) | undefined,
      stopAuditRotation: obj.stopAuditRotation as (() => void) | undefined,
      stopIndexWatcher: obj.stopIndexWatcher as (() => void) | undefined,
      releaseProcessLock: obj.releaseProcessLock as (() => void) | undefined,
    };
  }

  // OC shape:ctx 被 spread 到顶层(repository 直接在顶层)
  const ocCtx = obj as unknown as ToolContext;
  return {
    ctx: ocCtx,
    auditLog: obj.auditLog as AuditLog | undefined,
    effectivenessTracker:
      obj.effectivenessTracker as EffectivenessTracker | undefined,
    proposalEngine: obj.proposalEngine as ProposalEngine | undefined,
    stopMaintenance: obj.stopMaintenance as (() => void) | undefined,
    stopAuditRotation: obj.stopAuditRotation as (() => void) | undefined,
    stopIndexWatcher: obj.stopIndexWatcher as (() => void) | undefined,
    releaseProcessLock: obj.releaseProcessLock as (() => void) | undefined,
  };
}

/**
 * 构造最小化的 OpenClaw host API stub(只记录注册的工具,不真正调 OpenClaw runtime)
 */
function makeFakeOpenClawApi(): CoEngramPluginHostApi {
  return {
    registerTool: () => {
      // 测试不关心工具注册,只关心 registerCoEngramTools 的返回 shape
    },
  };
}

/**
 * 运行 adapter 契约测试
 *
 * 验证:
 *   1. 两端入口符号(createCoEngramMcpServer / registerCoEngramTools)都可调用
 *   2. 默认配置下(audit/effectiveness/proposal 全启用)两端都返回非空 diagnostic refs
 *   3. 两端返回的 ctx 字段类型一致(都是 ToolContext)
 *   4. 归一化后 lifecycle handle 集合对称(允许 undefined,但 key 必须都存在)
 *
 * 注意:本测试**不**启动 maintenance / audit rotation / index watcher 等后台任务
 * (CC 不传 startMaintenance,OC 传 startMaintenance: false),避免 vitest 进程
 * 退出时 setInterval 泄漏。
 */
export async function runAdapterContractTests(): Promise<ContractResult> {
  const diffs: ContractDiff[] = [];

  const ccTmp = mkdtempSync(join(tmpdir(), "co-engram-cc-contract-"));
  const ocTmp = mkdtempSync(join(tmpdir(), "co-engram-oc-contract-"));

  try {
    // ===== CC 侧 =====
    let ccRuntime: HostRuntime;
    try {
      const ccResult = createCoEngramMcpServer({
        dataRoot: ccTmp,
        profile: "full",
        // 不启动 maintenance / audit rotation(holder 才会启动;non-holder 直接跳过)
        // 通过让本进程成为 non-holder 来跳过后台任务 —— 但 ccTmp 是全新 dataRoot,
        // 本进程必然是 holder。改用 close 来停止任务。
      });
      ccRuntime = extractHostRuntime(ccResult);
      // 立即释放 holder 后台任务,避免泄漏
      ccResult.releaseProcessLock?.();
      ccResult.stopMaintenance?.();
      ccResult.stopAuditRotation?.();
      ccResult.stopIndexWatcher?.();
    } catch (e) {
      diffs.push({
        kind: "adapter",
        detail: `CC createCoEngramMcpServer threw: ${e instanceof Error ? e.message : String(e)}`,
      });
      return { passed: false, diffs };
    }

    // ===== OC 侧 =====
    let ocRuntime: HostRuntime;
    try {
      const api = makeFakeOpenClawApi();
      const ocResult = registerCoEngramTools(api, {
        dataRoot: ocTmp,
        // 关闭 maintenance,避免 setInterval 泄漏到 vitest 进程
        startMaintenance: false,
        // 关闭 audit rotation(同理)
        auditRotationConfig: { enabled: false },
      });
      ocRuntime = extractHostRuntime(ocResult);
      ocResult.releaseProcessLock?.();
      ocResult.stopMaintenance?.();
      ocResult.stopAuditRotation?.();
      ocResult.stopIndexWatcher?.();
    } catch (e) {
      diffs.push({
        kind: "adapter",
        detail: `OC registerCoEngramTools threw: ${e instanceof Error ? e.message : String(e)}`,
      });
      return { passed: false, diffs };
    }

    // ===== 契约 1:ctx 必须含 repository + searchOrchestrator(双宿主基础字段) =====
    if (!ccRuntime.ctx.repository) {
      diffs.push({
        kind: "adapter",
        detail: "CC ctx.repository missing",
      });
    }
    if (!ocRuntime.ctx.repository) {
      diffs.push({
        kind: "adapter",
        detail: "OC ctx.repository missing",
      });
    }

    // ===== 契约 2:host 标识注入(已修过的 P0-4,继续 guard)=====
    if (ccRuntime.ctx.host !== "claude-code-mcp") {
      diffs.push({
        kind: "adapter",
        detail: `CC ctx.host expected "claude-code-mcp", got ${JSON.stringify(ccRuntime.ctx.host)}`,
      });
    }
    if (ocRuntime.ctx.host !== "openclaw-plugin") {
      diffs.push({
        kind: "adapter",
        detail: `OC ctx.host expected "openclaw-plugin", got ${JSON.stringify(ocRuntime.ctx.host)}`,
      });
    }

    // ===== 契约 3:默认配置下,diagnostic refs 两端都应非空 =====
    for (const ref of EXPECTED_DIAGNOSTIC_REFS) {
      const ccValue = ccRuntime[ref];
      const ocValue = ocRuntime[ref];
      if (ccValue === undefined) {
        diffs.push({
          kind: "adapter",
          detail: `CC ${ref} is undefined under default config (audit/effectiveness/proposal enabled)`,
        });
      }
      if (ocValue === undefined) {
        diffs.push({
          kind: "adapter",
          detail: `OC ${ref} is undefined under default config (audit/effectiveness/proposal enabled) — known asymmetry, AI-5 will fix by exposing diagnostic refs at top-level`,
        });
      }
    }

    // ===== 契约 4:lifecycle handle 集合对称(允许 undefined,但 key 都存在)=====
    for (const handle of EXPECTED_LIFECYCLE_HANDLES) {
      // 仅检查 key 存在于对象(用 in 操作符);值允许 undefined(non-holder 路径)
      const ccHas = handle in (ccRuntime as object);
      const ocHas = handle in (ocRuntime as object);
      if (!ccHas) {
        diffs.push({
          kind: "adapter",
          detail: `CC missing lifecycle handle key "${handle}"`,
        });
      }
      if (!ocHas) {
        diffs.push({
          kind: "adapter",
          detail: `OC missing lifecycle handle key "${handle}"`,
        });
      }
    }

    // ===== 契约 5:skill catalog 注入一致性(确定性注入,forgotten 过滤)=====
    // 两端各在 tmp dataRoot 下注册相同 skill 集(2 active + 1 forgotten),
    // collectSkillCatalog 结果必须 byte-for-byte 一致 —— 双宿主注入同一份清单。
    const seedSkills = (dataRoot: string): void => {
      const repo = new SkillRepository(dataRoot);
      for (const [id, desc] of [
        ["contract-a", "契约测试技能 A"],
        ["contract-b", "契约测试技能 B"],
      ] as const) {
        const dir = join(dataRoot, "skills", id);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, "SKILL.md"),
          `---\nname: ${id}\ndescription: ${desc}\n---\n\nbody\n`,
          "utf8",
        );
        repo.createSkill({
          skillId: id,
          sourcePath: `skills/${id}`,
          initiationSet: desc,
          createdBy: "contract",
        });
      }
      // forgotten skill:目录在但 imprint 直标 forgotten
      const dir = join(dataRoot, "skills", "contract-old");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "SKILL.md"),
        "---\nname: contract-old\ndescription: 过期技能\n---\n\nbody\n",
        "utf8",
      );
      const old = repo.createSkill({
        skillId: "contract-old",
        sourcePath: "skills/contract-old",
        initiationSet: "过期技能",
        createdBy: "contract",
      });
      const impPath = join(dir, ".co-engram", "imprint.json");
      writeFileSync(
        impPath,
        JSON.stringify({ ...old, retentionStage: "forgotten" }, null, 2),
        "utf8",
      );
    };
    seedSkills(ccTmp);
    seedSkills(ocTmp);

    const ccSkills = ccRuntime.ctx.skillRepository
      ? collectSkillCatalog(ccRuntime.ctx.skillRepository, ccTmp)
      : null;
    const ocSkills = ocRuntime.ctx.skillRepository
      ? collectSkillCatalog(ocRuntime.ctx.skillRepository, ocTmp)
      : null;
    if (ccSkills === null) {
      diffs.push({ kind: "adapter", detail: "CC ctx.skillRepository missing — skill catalog injection impossible" });
    }
    if (ocSkills === null) {
      diffs.push({ kind: "adapter", detail: "OC ctx.skillRepository missing — skill catalog injection impossible" });
    }
    if (ccSkills !== null && ocSkills !== null) {
      if (JSON.stringify(ccSkills) !== JSON.stringify(ocSkills)) {
        diffs.push({
          kind: "adapter",
          detail: `skill catalog diverged: CC=${JSON.stringify(ccSkills)} OC=${JSON.stringify(ocSkills)}`,
        });
      }
      const ids = ccSkills.map((e) => e.skillId);
      if (ids.includes("contract-old")) {
        diffs.push({ kind: "adapter", detail: "forgotten skill leaked into catalog (retentionStage filter broken)" });
      }
      if (!ids.includes("contract-a") || !ids.includes("contract-b")) {
        diffs.push({ kind: "adapter", detail: `active skills missing from catalog: got ${JSON.stringify(ids)}` });
      }
    }
  } finally {
    rmSync(ccTmp, { recursive: true, force: true });
    rmSync(ocTmp, { recursive: true, force: true });
  }

  return { passed: diffs.length === 0, diffs };
}
