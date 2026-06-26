import { describe, it, expect } from "vitest";
import {
  computeContentHash,
  verifyContentHash,
  computeContentSize,
} from "../src/storage/hash.js";

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
