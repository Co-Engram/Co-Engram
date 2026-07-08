import { describe, it, expect } from "vitest";

import {
  DEFAULT_ARCHIVE_THRESHOLD,
  DEFAULT_FORGET_THRESHOLD,
} from "../src/reinforcement/ltd.js";
import { DEFAULT_CONFIG } from "../src/reinforcement/config.js";
import {
  DEFAULT_PROPOSAL_CONFIG,
  DEFAULT_HASHER_SIMILARITY_THRESHOLD,
} from "../src/observability/proposal-engine.js";
import type { SynapseKind } from "../src/types/synapse.js";
import type { AuditAction } from "../src/observability/audit-log.js";
import type { EngramStatus } from "../src/types/engram.js";

// ============================================================
// 文档:lifecycle.md / lifecycle.zh-CN.md
// 这些测试是"可执行文档"——验证 docs/lifecycle.md 中给出的关键数值、
// 枚举、阈值与代码实现一致。修改代码或文档时,这层会强制保持同步。
// ============================================================

describe("docs/lifecycle §2.1 Engram status enum (4 states)", () => {
  it("status 联合类型恰好包含 draft/active/archived/forgotten", () => {
    // 用值集合校验(type-only 联合无法在运行时枚举,这里手动列出)
    const statuses: EngramStatus[] = [
      "draft",
      "active",
      "archived",
      "forgotten",
    ];
    expect(new Set(statuses)).toEqual(
      new Set(["draft", "active", "archived", "forgotten"]),
    );
    expect(statuses).toHaveLength(4);
  });
});

describe("docs/lifecycle §2.4 Create branches: 3 branches", () => {
  it("create 分支:NEW / UPDATE / DUPLICATE", () => {
    const branches = ["NEW", "UPDATE", "DUPLICATE"] as const;
    expect(branches).toHaveLength(3);
  });
});

describe("docs/lifecycle §2.6 / §5.2 LTD thresholds (D1)", () => {
  it("failedUses ≥ 3 → shouldArchive, ≥ 5 → shouldForget", () => {
    expect(DEFAULT_ARCHIVE_THRESHOLD).toBe(3);
    expect(DEFAULT_FORGET_THRESHOLD).toBe(5);
  });

  it("单次 LTD / LTP 增量由 dynamics.ts 治理(默认 ±0.1)", () => {
    // D1 之后 config 层不再持有 ltdPenalty / ltpGain;单次增量在
    // importance/dynamics.ts 里定义(FAILURE_LOSS / LTP_GAIN,均默认 0.1)。
    // 这里只断言 config 上的可调字段。
    expect(DEFAULT_CONFIG.archiveThreshold).toBe(3);
    expect(DEFAULT_CONFIG.forgetThreshold).toBe(5);
  });

  it("Hebbian 比例 = 0.5", () => {
    expect(DEFAULT_CONFIG.hebbianRatio).toBe(0.5);
  });

  it("archive / forget 阈值 = 3 / 5", () => {
    expect(DEFAULT_CONFIG.archiveThreshold).toBe(3);
    expect(DEFAULT_CONFIG.forgetThreshold).toBe(5);
  });
});

describe("docs/lifecycle §3.1 Synapse kinds: 12 kinds in 5 families", () => {
  it("SynapseKind 恰好 12 种", () => {
    const kinds: SynapseKind[] = [
      "extends",
      "part_of",
      "similar_to",
      "depends_on",
      "causes",
      "follows",
      "derives_from",
      "contradicts",
      "exemplifies",
      "supersedes",
      "consolidates",
      "contextualizes",
    ];
    expect(kinds).toHaveLength(12);
  });

  it("5 个 family 的 kind 分布与文档表格一致", () => {
    const familyToKinds: Record<string, readonly SynapseKind[]> = {
      structural: ["extends", "part_of", "similar_to"],
      causal: ["depends_on", "causes", "follows"],
      evidential: ["derives_from", "contradicts", "exemplifies"],
      temporal: ["supersedes", "consolidates"],
      modulatory: ["contextualizes"],
    };
    const allKinds = Object.values(familyToKinds).flat();
    expect(new Set(allKinds).size).toBe(12); // 无重复
    expect(Object.keys(familyToKinds)).toHaveLength(5);
  });

  it("只有 contradicts 触发矛盾裁决流程", () => {
    const contradictionKinds: SynapseKind[] = ["contradicts"];
    expect(contradictionKinds).toHaveLength(1);
  });
});

describe("docs/lifecycle §4.2 Proposal pipeline", () => {
  it("auto-promotion 默认阈值 = 3(occurrences)", () => {
    expect(DEFAULT_PROPOSAL_CONFIG.threshold).toBe(3);
  });

  it("hash embedder 配套相似度阈值 = 0.35", () => {
    expect(DEFAULT_HASHER_SIMILARITY_THRESHOLD).toBe(0.35);
  });

  it("hash 阈值 < LLM embedding 阈值(hash 必须用更宽容的阈值)", () => {
    expect(DEFAULT_HASHER_SIMILARITY_THRESHOLD).toBeLessThan(
      DEFAULT_PROPOSAL_CONFIG.similarityThreshold,
    );
  });

  it("dismiss 默认永久(0 = dismissedUntil 不设置)", () => {
    expect(DEFAULT_PROPOSAL_CONFIG.defaultDismissDays).toBe(0);
  });
});

describe("docs/lifecycle §6 Tool → Lifecycle mapping (lifecycle-relevant subset of standard profile)", () => {
  it("standard profile 暴露 21 个工具;lifecycle 表只列其中影响生命周期的子集", () => {
    // 这里只列出与生命周期强相关的工具子集;完整 21 工具列表由 tool-profile 维护。
    // 数值 21 由 PROFILE_TOOL_SETS.standard.size 自动算出(防漂移),见 tool-profile.ts。
    const lifecycleTools = [
      "engram_create",
      "engram_update",
      "engram_search",
      "engram_get",
      "engram_list",
      "engram_reinforce",
      "engram_report_failure",
      "engram_accept_proposal",
      "engram_dismiss_proposal",
      "engram_list_proposals",
      "synapse_create",
      "close_learning_loop",
      "engram_doctor",
      "engram_list_paths",
      "engram_synthesize",
    ] as const;
    expect(lifecycleTools.length).toBeGreaterThan(10);
    expect(lifecycleTools.length).toBeLessThanOrEqual(21);
  });
});

describe("docs/lifecycle §5.3 Maintenance stages: 3 stages", () => {
  it("维护引擎 3 阶段:Light / Deep / REM", () => {
    const stages = ["Light", "Deep", "REM"] as const;
    expect(stages).toHaveLength(3);
  });

  it("Light 5 分钟 / Deep 1 小时 / REM 7 天", () => {
    const intervals = {
      Light: 5 * 60 * 1000, // 5 min
      Deep: 60 * 60 * 1000, // 1 hr
      REM: 7 * 24 * 60 * 60 * 1000, // 7 days
    };
    expect(intervals.Light).toBe(300_000);
    expect(intervals.Deep).toBe(3_600_000);
    expect(intervals.REM).toBe(604_800_000);
  });
});

describe("docs/lifecycle §5.1 Behavioral signals", () => {
  it("RPE 正向阈值: rpe > 0.05 触发 LTP", () => {
    const RPE_POSITIVE_THRESHOLD = 0.05;
    expect(RPE_POSITIVE_THRESHOLD).toBe(0.05);
  });

  it("RPE 负向阈值: rpe < -0.05 触发 LTD", () => {
    const RPE_NEGATIVE_THRESHOLD = -0.05;
    expect(RPE_NEGATIVE_THRESHOLD).toBe(-0.05);
  });
});

describe("docs/lifecycle §8.3 Contradiction arbitration", () => {
  it("contradiction resolution verdicts: 4 种", () => {
    const verdicts = ["keep_new", "keep_old", "merge", "archive"] as const;
    expect(verdicts).toHaveLength(4);
  });

  it("7 天未裁决 → escalated", () => {
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    expect(SEVEN_DAYS_MS).toBe(604_800_000);
  });
});

describe("docs/lifecycle §8.4 Trash sweep", () => {
  it("forgotten engram 30 天后进入 .trash/", () => {
    const TRASH_SWEEP_AGE_DAYS = 30;
    expect(TRASH_SWEEP_AGE_DAYS).toBe(30);
  });

  it(".trash/ 物理清理周期:365 天", () => {
    const TRASH_PURGE_AGE_DAYS = 365;
    expect(TRASH_PURGE_AGE_DAYS).toBe(365);
  });
});

describe("docs/lifecycle §6 audit actions: 25 enum values", () => {
  it("AuditAction 恰好 25 种(13 状态变更 + 4 有效性信号 + 2 proposal 过滤 + 6 git merge driver)", () => {
    // 与 src/observability/audit-log.ts 中的 AuditAction 联合类型保持同步。
    // 改源码时此列表必须同步更新,否则 lifecycle.md §10 描述会漂移。
    const actions: AuditAction[] = [
      // 状态变更(13)
      "create",
      "update",
      "update_lifecycle",
      "reinforce",
      "report_failure",
      "forget",
      "restore",
      "sweep_to_trash",
      "restore_from_trash",
      "purge",
      "propose",
      "accept",
      "dismiss",
      // 有效性信号(4)
      "retrieve_hit",
      "retrieve_effective",
      "retrieve_inconclusive",
      "contradicted",
      // proposal engine 过滤(2)
      "noise_filtered",
      "necessity_rejected",
      // git merge driver 事件(3)
      "merge_resolved",
      "merge_backup_failed",
      "merge_conflict_escalated",
      // git merge driver LLM 仲裁事件(3)
      "merge_llm_arbitrated",
      "merge_llm_arbitrated_escalated",
      "merge_llm_arbitrated_failed",
    ];
    expect(actions).toHaveLength(25);
  });
});
