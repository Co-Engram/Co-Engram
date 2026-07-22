import { describe, it, expect } from "vitest";
import {
  computeContentHash,
  verifyContentHash,
  computeContentSize,
} from "../src/storage/hash.js";
import { DERIVED_SYNAPSES_MARKER } from "../src/storage/derived-marker.js";

describe("computeContentHash", () => {
  it("生成 sha256: 前缀的哈希", () => {
    const hash = computeContentHash("hello");
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("相同内容生成相同哈希", () => {
    expect(computeContentHash("test")).toBe(computeContentHash("test"));
  });

  it("不同内容生成不同哈希", () => {
    expect(computeContentHash("a")).not.toBe(computeContentHash("b"));
  });

  it("空字符串也能哈希", () => {
    const hash = computeContentHash("");
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});

describe("verifyContentHash", () => {
  it("正确验证匹配的哈希", () => {
    const content = "test content";
    const hash = computeContentHash(content);
    expect(verifyContentHash(content, hash)).toBe(true);
  });

  it("拒绝不匹配的哈希", () => {
    expect(verifyContentHash("test", "sha256:abc")).toBe(false);
  });
});

describe("computeContentSize", () => {
  it("返回字符数", () => {
    expect(computeContentSize("hello")).toBe(5);
  });

  it("中文字符每个算 1", () => {
    expect(computeContentSize("你好")).toBe(2);
  });

  it("空字符串为 0", () => {
    expect(computeContentSize("")).toBe(0);
  });
});

describe("computeContentHash/Size 剥除派生突触段(防 doctor contentHash churn)", () => {
  // 回归 bug:派生段(<!-- co-engram-derived:synapses --> ...)每次 doctor 的
  // regenerateObsidianLinks 重写,若纳入 hash → contentHash 反复漂移 → doctor 反复
  // 误报 derived_field_stale(stable churn,~36 项/次)。contentHash/contentSize 必须
  // 定义在「原始内容(剥除派生段)」上,与 createEngram(input.content) 口径一致。
  const body = "这是原始内容,不含派生段。";
  const withDerived = `${body}\n\n${DERIVED_SYNAPSES_MARKER}\n## Synapses (derived)\n\n- → [[x|y · extends]]\n`;

  it("含派生段的内容 hash === 原始内容 hash(派生段被剥除)", () => {
    expect(computeContentHash(withDerived)).toBe(computeContentHash(body));
  });

  it("含派生段的内容 size === 原始内容 size", () => {
    expect(computeContentSize(withDerived)).toBe(computeContentSize(body));
  });

  it("无派生段时不误剥(无 marker 原样返回,仅去尾换行)", () => {
    expect(computeContentHash("plain\n\n")).toBe(computeContentHash("plain"));
  });

  it("round-trip:含派生段内容算的 hash,用原始内容验证通过", () => {
    expect(verifyContentHash(body, computeContentHash(withDerived))).toBe(true);
  });
});
