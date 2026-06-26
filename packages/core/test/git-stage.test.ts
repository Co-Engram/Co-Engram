import { describe, it, expect } from "vitest";
import {
  stageChanges,
  generateCommitMessage,
  assessChangeRisk,
} from "../src/storage/git-stage.js";

// ============================================================
// stageChanges
// ============================================================

describe("stageChanges", () => {
  it("单个 engram 返回三个文件路径", () => {
    const files = stageChanges(["testing/adb/android"]);
    expect(files).toHaveLength(3);
    expect(files).toContain("engrams/content/testing/adb/android.md");
    expect(files).toContain("engrams/meta/testing/adb/android.yaml");
    expect(files).toContain("engrams/synapses/testing/adb/android.yaml");
  });

  it("多个 engram 累积 3N 个文件", () => {
    const files = stageChanges(["a", "b", "c"]);
    expect(files).toHaveLength(9);
  });

  it("空数组返回空", () => {
    expect(stageChanges([])).toEqual([]);
  });
});

// ============================================================
// generateCommitMessage
// ============================================================

describe("generateCommitMessage", () => {
  it("空变更返回提示", () => {
    const info = generateCommitMessage([]);
    expect(info.engramCount).toBe(0);
    expect(info.message).toMatch(/空变更/);
  });

  it("单个 engram 新增", () => {
    const files = stageChanges(["testing/x"]);
    const info = generateCommitMessage(files, { title: "ADB 调试" });
    expect(info.kind).toBe("create");
    expect(info.message).toMatch(/新增\[ADB 调试\]/);
    expect(info.engramCount).toBe(1);
  });

  it("含 synapseKinds 时附带连接信息", () => {
    const files = stageChanges(["a", "b"]);
    const info = generateCommitMessage(files, {
      title: "基础事实",
      synapseKinds: ["extends", "similar_to"],
    });
    expect(info.message).toMatch(/连接\(extends, similar_to\)/);
  });

  it("多个 engram 统计正确", () => {
    const files = stageChanges(["a", "b", "c"]);
    const info = generateCommitMessage(files);
    expect(info.engramCount).toBe(3);
    expect(info.message).toMatch(/3 个 engram/);
  });
});

// ============================================================
// assessChangeRisk
// ============================================================

describe("assessChangeRisk", () => {
  it("无变更 → 低风险", () => {
    const r = assessChangeRisk([], false);
    expect(r.risk).toBe("low");
  });

  it("仅 extends → 低风险", () => {
    const r = assessChangeRisk(["extends"], false);
    expect(r.risk).toBe("low");
  });

  it("contradicts → 高风险", () => {
    const r = assessChangeRisk(["contradicts"], false);
    expect(r.risk).toBe("high");
    expect(r.reasons.some((x) => x.includes("contradicts"))).toBe(true);
  });

  it("supersedes → 高风险", () => {
    const r = assessChangeRisk(["supersedes"], false);
    expect(r.risk).toBe("high");
  });

  it("depends_on → 中风险", () => {
    const r = assessChangeRisk(["depends_on"], false);
    expect(r.risk).toBe("medium");
  });

  it("删除已有连接 → 高风险", () => {
    const r = assessChangeRisk([], true);
    expect(r.risk).toBe("high");
    expect(r.reasons.some((x) => x.includes("删除"))).toBe(true);
  });

  it("混合（contradicts + extends）→ 高风险（取最高）", () => {
    const r = assessChangeRisk(["contradicts", "extends"], false);
    expect(r.risk).toBe("high");
  });
});
