import { describe, it, expect } from "vitest";

import { computeSynapseId, isSynapseId } from "../src/types/synapse-id.js";
import { isSymmetricKind, SYMMETRIC_KINDS } from "../src/types/synapse.js";

describe("computeSynapseId — 确定性", () => {
  it("相同 (from, to, kind) 生成相同 id", () => {
    const a = computeSynapseId(
      "01KVNJ9RN190DVHBKFB7NHDF9Q",
      "01KVNJ9RN3GW1KWXKVJ56RGJ0W",
      "extends",
    );
    const b = computeSynapseId(
      "01KVNJ9RN190DVHBKFB7NHDF9Q",
      "01KVNJ9RN3GW1KWXKVJ56RGJ0W",
      "extends",
    );
    expect(a).toBe(b);
  });

  it("kind 不同 → id 不同", () => {
    const extends_id = computeSynapseId(
      "01KVNJ9RN190DVHBKFB7NHDF9Q",
      "01KVNJ9RN3GW1KWXKVJ56RGJ0W",
      "extends",
    );
    const contradicts_id = computeSynapseId(
      "01KVNJ9RN190DVHBKFB7NHDF9Q",
      "01KVNJ9RN3GW1KWXKVJ56RGJ0W",
      "contradicts",
    );
    expect(extends_id).not.toBe(contradicts_id);
  });

  it("有向 kind(extends):from/to 顺序不同 → id 不同(方向承载语义)", () => {
    const ab = computeSynapseId(
      "01KVNJ9RN190DVHBKFB7NHDF9Q",
      "01KVNJ9RN3GW1KWXKVJ56RGJ0W",
      "extends",
    );
    const ba = computeSynapseId(
      "01KVNJ9RN3GW1KWXKVJ56RGJ0W",
      "01KVNJ9RN190DVHBKFB7NHDF9Q",
      "extends",
    );
    expect(ab).not.toBe(ba);
  });

  it("对称 kind(similar_to):from/to 顺序无关(端点规范化)", () => {
    const ab = computeSynapseId(
      "01KVNJ9RN190DVHBKFB7NHDF9Q",
      "01KVNJ9RN3GW1KWXKVJ56RGJ0W",
      "similar_to",
    );
    const ba = computeSynapseId(
      "01KVNJ9RN3GW1KWXKVJ56RGJ0W",
      "01KVNJ9RN190DVHBKFB7NHDF9Q",
      "similar_to",
    );
    expect(ab).toBe(ba);
  });

  it("对称 kind(contradicts):from/to 顺序无关", () => {
    const ab = computeSynapseId(
      "01KVNJ9RN190DVHBKFB7NHDF9Q",
      "01KVNJ9RN3GW1KWXKVJ56RGJ0W",
      "contradicts",
    );
    const ba = computeSynapseId(
      "01KVNJ9RN3GW1KWXKVJ56RGJ0W",
      "01KVNJ9RN190DVHBKFB7NHDF9Q",
      "contradicts",
    );
    expect(ab).toBe(ba);
  });

  it("生成的 id 以 syn- 前缀开头", () => {
    const id = computeSynapseId(
      "01KVNJ9RN190DVHBKFB7NHDF9Q",
      "01KVNJ9RN3GW1KWXKVJ56RGJ0W",
      "extends",
    );
    expect(id.startsWith("syn-")).toBe(true);
  });

  it("生成的 id 总长度为 20(syn- + 16 hex)", () => {
    const id = computeSynapseId(
      "01KVNJ9RN190DVHBKFB7NHDF9Q",
      "01KVNJ9RN3GW1KWXKVJ56RGJ0W",
      "extends",
    );
    expect(id.length).toBe(20);
  });
});

describe("isSynapseId", () => {
  it("合法 syn-id 通过校验", () => {
    expect(
      isSynapseId("syn-a1b2c3d4e5f6789001234567890abcd".slice(0, 20)),
    ).toBe(true);
  });

  it("computeSynapseId 输出通过校验", () => {
    const id = computeSynapseId(
      "01KVNJ9RN190DVHBKFB7NHDF9Q",
      "01KVNJ9RN3GW1KWXKVJ56RGJ0W",
      "extends",
    );
    expect(isSynapseId(id)).toBe(true);
  });

  it("无前缀拒绝", () => {
    expect(isSynapseId("a1b2c3d4e5f67890")).toBe(false);
  });

  it("长度不对拒绝", () => {
    expect(isSynapseId("syn-short")).toBe(false);
  });

  it("非 hex 字符拒绝", () => {
    expect(isSynapseId("syn-zzzzzzzzzzzzzzzz")).toBe(false);
  });
});

describe("isSymmetricKind — 对称性派生自 kind", () => {
  it("similar_to / contradicts 是对称 kind", () => {
    expect(isSymmetricKind("similar_to")).toBe(true);
    expect(isSymmetricKind("contradicts")).toBe(true);
  });

  it("其余 10 种 kind 是有向(源/靶语义不可交换)", () => {
    const directionalKinds = [
      "extends",
      "part_of",
      "depends_on",
      "causes",
      "follows",
      "derives_from",
      "exemplifies",
      "supersedes",
      "consolidates",
      "contextualizes",
    ] as const;
    for (const k of directionalKinds) {
      expect(isSymmetricKind(k)).toBe(false);
    }
  });

  it("SYMMETRIC_KINDS 恰好含 similar_to + contradicts", () => {
    expect(SYMMETRIC_KINDS.size).toBe(2);
    expect([...SYMMETRIC_KINDS].sort()).toEqual(["contradicts", "similar_to"]);
  });

  it("对称性 ↔ computeSynapseId 规范化一致(回归不变量,防两套真相源漂移)", () => {
    const lo = "01KVNJ9RN190DVHBKFB7NHDF9Q";
    const hi = "01KVNJ9RN3GW1KWXKVJ56RGJ0W";
    // 对称 kind 必须:端点顺序无关(isSymmetricKind=true ↔ id 规范化)
    expect(isSymmetricKind("similar_to")).toBe(true);
    expect(computeSynapseId(lo, hi, "similar_to")).toBe(
      computeSynapseId(hi, lo, "similar_to"),
    );
    expect(isSymmetricKind("contradicts")).toBe(true);
    expect(computeSynapseId(lo, hi, "contradicts")).toBe(
      computeSynapseId(hi, lo, "contradicts"),
    );
    // 有向 kind 必须:端点顺序敏感(isSymmetricKind=false ↔ id 保留顺序)
    expect(isSymmetricKind("extends")).toBe(false);
    expect(computeSynapseId(lo, hi, "extends")).not.toBe(
      computeSynapseId(hi, lo, "extends"),
    );
  });
});
