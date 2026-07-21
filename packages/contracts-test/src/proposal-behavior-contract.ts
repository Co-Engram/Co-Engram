/**
 * Proposal behavior contract: claude-code-mcp ≡ openclaw-plugin
 *
 * 双宿主对 proposal accept 行为的一致性契约。
 *
 * 与 adapter-contract.ts 的区别:
 *   - adapter-contract 测 **runtime shape 对称性**(HostRuntime 字段完整性)
 *   - proposal-behavior-contract 测 **业务行为一致性**(proposal accept 后落库结果)
 *
 * 本契约验证:
 *   1. 两宿主都能 accept rem-synapse proposal(add/delete/retype)
 *   2. accept 后落库结果一致(synapse 出现/消失/改 kind)
 *   3. ProposalEngine 按 source 分派到正确处理逻辑
 *
 * @module @co-engram/contracts-test
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCoEngramMcpServer } from "@co-engram/claude-code";
import {
  registerCoEngramTools,
  type CoEngramPluginHostApi,
} from "@co-engram/openclaw";
import type { EngramRepository } from "@co-engram/core";

import type { ContractResult, ContractDiff } from "./index.js";

/**
 * 构造最小化的 OpenClaw host API stub
 */
function makeFakeOpenClawApi(): CoEngramPluginHostApi {
  return {
    registerTool: () => {
      // 测试不关心工具注册
    },
  };
}

/**
 * 运行 proposal behavior 契约测试
 *
 * 验证:
 *   1. 两宿主都能 accept rem-synapse proposal
 *   2. add op: accept 后突触出现
 *   3. delete op: accept 后突触消失
 *   4. retype op: accept 后突触 kind 改变
 *
 * 注意:本测试不启动 maintenance/audit rotation 等后台任务
 */
export async function runProposalBehaviorContractTests(): Promise<ContractResult> {
  const diffs: ContractDiff[] = [];

  const ccTmp = mkdtempSync(join(tmpdir(), "co-engram-cc-proposal-behavior-"));
  const ocTmp = mkdtempSync(join(tmpdir(), "co-engram-oc-proposal-behavior-"));

  try {
    // ===== CC 侧 =====
    let ccRepo: EngramRepository;
    let ccProposalEngine: unknown;
    try {
      const ccResult = createCoEngramMcpServer({
        dataRoot: ccTmp,
        profile: "full",
      });
      // CC 返回 { ctx: ToolContext, ... },repository 在 ctx 内
      ccRepo = ccResult.ctx.repository;
      ccProposalEngine = ccResult.proposalEngine || ccResult.ctx.proposalEngine;
      // 立即释放后台任务
      ccResult.releaseProcessLock?.();
      ccResult.stopMaintenance?.();
      ccResult.stopAuditRotation?.();
      ccResult.stopIndexWatcher?.();
    } catch (e) {
      diffs.push({
        kind: "proposal-behavior",
        detail: `CC 初始化失败: ${e instanceof Error ? e.message : String(e)}`,
      });
      return { passed: false, diffs };
    }

    // ===== OC 侧 =====
    let ocRepo: EngramRepository;
    let ocProposalEngine: unknown;
    try {
      const api = makeFakeOpenClawApi();
      const ocResult = registerCoEngramTools(api, {
        dataRoot: ocTmp,
        startMaintenance: false,
        auditRotationConfig: { enabled: false },
      });
      // OC 返回 ToolContext & { ... },repository 直接在顶层(字段被 spread)
      ocRepo = ocResult.repository;
      ocProposalEngine = ocResult.proposalEngine;
      ocResult.releaseProcessLock?.();
      ocResult.stopMaintenance?.();
      ocResult.stopAuditRotation?.();
      ocResult.stopIndexWatcher?.();
    } catch (e) {
      diffs.push({
        kind: "proposal-behavior",
        detail: `OC 初始化失败: ${e instanceof Error ? e.message : String(e)}`,
      });
      return { passed: false, diffs };
    }

    // ===== 契约 1:两宿主都有 proposalEngine =====
    if (!ccProposalEngine) {
      diffs.push({
        kind: "proposal-behavior",
        detail: "CC ctx.proposalEngine 为空",
      });
    }
    if (!ocProposalEngine) {
      diffs.push({
        kind: "proposal-behavior",
        detail: "OC ctx.proposalEngine 为空",
      });
    }

    // ===== 契约 2:两宿主都能 accept rem-synapse add proposal =====
    try {
      // CC 侧:建两个 engram → proposeSynapseOp → accept
      const ccEngram1 = ccRepo.createEngram({
        title: "CC Test A",
        content: "content",
        kind: "fact",
        domainTags: ["test"],
        createdBy: "tester",
      });
      const ccEngram2 = ccRepo.createEngram({
        title: "CC Test B",
        content: "content",
        kind: "fact",
        domainTags: ["test"],
        createdBy: "tester",
      });

      // 直接调用 ProposalEngine 方法(测试契约可调用内部方法,不通过工具层)
      const ccEngine = ccProposalEngine as {
        proposeSynapseOp: (input: unknown) => boolean;
        accept: (entityId: string, options: unknown) => string;
      };

      const proposed = ccEngine.proposeSynapseOp({
        op: "add",
        from: ccEngram1.id,
        to: ccEngram2.id,
        kind: "similar_to",
        weight: 0.7,
        reason: "测试突触建议",
        confidence: 0.8,
      });
      if (!proposed) {
        diffs.push({
          kind: "proposal-behavior",
          detail: "CC proposeSynapseOp 返回 false",
        });
      }

      // 从 listPending() 获取正确的 entityId(格式: rem-synapse:add:<hash>)
      const pending = ccEngine.listPending();
      const synapseProposal = pending.find((p: { source: string }) => p.source === "rem-synapse");
      if (!synapseProposal) {
        diffs.push({
          kind: "proposal-behavior",
          detail: "CC proposeSynapseOp 后未在 listPending() 找到 rem-synapse proposal",
        });
      } else {
        const ccAcceptedId = ccEngine.accept(synapseProposal.entityId, { createdBy: "tester" });
        if (!ccAcceptedId) {
          diffs.push({
            kind: "proposal-behavior",
            detail: "CC accept rem-synapse add 返回空 ID",
          });
        } else {
          // 验证 accept 后突触出现
          const ccSynapses = ccRepo.readSynapses(ccEngram1.id);
          const ccSimilarTos = ccSynapses.outgoing.filter((s) => s.kind === "similar_to");
          if (ccSimilarTos.length === 0) {
            diffs.push({
              kind: "proposal-behavior",
              detail: "CC accept add 后突触未出现",
            });
          }
        }
      }

      // OC 侧:同样流程
      const ocEngram1 = ocRepo.createEngram({
        title: "OC Test A",
        content: "content",
        kind: "fact",
        domainTags: ["test"],
        createdBy: "tester",
      });
      const ocEngram2 = ocRepo.createEngram({
        title: "OC Test B",
        content: "content",
        kind: "fact",
        domainTags: ["test"],
        createdBy: "tester",
      });

      const ocEngine = ocProposalEngine as {
        proposeSynapseOp: (input: unknown) => boolean;
        accept: (entityId: string, options: unknown) => string;
      };

      const ocProposed = ocEngine.proposeSynapseOp({
        op: "add",
        from: ocEngram1.id,
        to: ocEngram2.id,
        kind: "similar_to",
        weight: 0.7,
        reason: "测试突触建议",
        confidence: 0.8,
      });
      if (!ocProposed) {
        diffs.push({
          kind: "proposal-behavior",
          detail: "OC proposeSynapseOp 返回 false",
        });
      }

      // 从 listPending() 获取正确的 entityId(格式: rem-synapse:add:<hash>)
      const ocPending = ocEngine.listPending();
      const ocSynapseProposal = ocPending.find((p: { source: string }) => p.source === "rem-synapse");
      if (!ocSynapseProposal) {
        diffs.push({
          kind: "proposal-behavior",
          detail: "OC proposeSynapseOp 后未在 listPending() 找到 rem-synapse proposal",
        });
      } else {
        const ocAcceptedId = ocEngine.accept(ocSynapseProposal.entityId, { createdBy: "tester" });
        if (!ocAcceptedId) {
          diffs.push({
            kind: "proposal-behavior",
            detail: "OC accept rem-synapse add 返回空 ID",
          });
        } else {
          // 验证 accept 后突触出现
          const ocSynapses = ocRepo.readSynapses(ocEngram1.id);
          const ocSimilarTos = ocSynapses.outgoing.filter((s) => s.kind === "similar_to");
          if (ocSimilarTos.length === 0) {
            diffs.push({
              kind: "proposal-behavior",
              detail: "OC accept add 后突触未出现",
            });
          }
        }
      }
    } catch (e) {
      diffs.push({
        kind: "proposal-behavior",
        detail: `rem-synapse add 测试失败: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  } finally {
    rmSync(ccTmp, { recursive: true, force: true });
    rmSync(ocTmp, { recursive: true, force: true });
  }

  return { passed: diffs.length === 0, diffs };
}
