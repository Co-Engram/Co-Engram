import { describe, it, expect } from "vitest";

import { computeSynapseId, isSynapseId } from "../src/types/synapse-id.js";

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

  it("directional:from/to 顺序不同 → id 不同", () => {
    const ab = computeSynapseId(
      "01KVNJ9RN190DVHBKFB7NHDF9Q",
      "01KVNJ9RN3GW1KWXKVJ56RGJ0W",
      "extends",
      "directional",
    );
    const ba = computeSynapseId(
      "01KVNJ9RN3GW1KWXKVJ56RGJ0W",
      "01KVNJ9RN190DVHBKFB7NHDF9Q",
      "extends",
      "directional",
    );
    expect(ab).not.toBe(ba);
  });

  it("bidirectional:from/to 顺序无关(对称边)", () => {
    const ab = computeSynapseId(
      "01KVNJ9RN190DVHBKFB7NHDF9Q",
      "01KVNJ9RN3GW1KWXKVJ56RGJ0W",
      "similar_to",
      "bidirectional",
    );
    const ba = computeSynapseId(
      "01KVNJ9RN3GW1KWXKVJ56RGJ0W",
      "01KVNJ9RN190DVHBKFB7NHDF9Q",
      "similar_to",
      "bidirectional",
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
