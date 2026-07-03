import { describe, it, expect } from "vitest";
import { encodeCursor, decodeCursor, compareSortKey } from "../../src/storage/index-db-cursor.js";

describe("cursor 编解码", () => {
	it("round-trip 保留字段", () => {
		const key = { importance: 0.85, updatedAt: 1718000000000, id: "01KWMH4ETY5T7BF6Y8365F4ZZZ" };
		const cursor = encodeCursor(key);
		const decoded = decodeCursor(cursor);
		expect(decoded).toEqual(key);
	});

	it("encode 生成 base64url(无 padding,URL-safe)", () => {
		const cursor = encodeCursor({ importance: 0.5, updatedAt: 1, id: "a" });
		expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(cursor).not.toContain("=");
	});

	it("decode 拒绝格式错误", () => {
		expect(() => decodeCursor("!!!invalid-base64!!!")).toThrow(/invalid cursor/);
		expect(() => decodeCursor("")).toThrow(/invalid cursor/);
	});

	it("decode 拒绝 shape mismatch(数组长度不对 / 类型不对)", () => {
		// 构造合法 base64url 但内部 JSON shape 错的 cursor
		const badShape = Buffer.from(JSON.stringify({ foo: "bar" }), "utf8").toString("base64url");
		expect(() => decodeCursor(badShape)).toThrow(/invalid cursor/);

		const shortArr = Buffer.from(JSON.stringify([0.5, 1]), "utf8").toString("base64url");
		expect(() => decodeCursor(shortArr)).toThrow(/invalid cursor/);

		const wrongType = Buffer.from(JSON.stringify(["x", 1, "a"]), "utf8").toString("base64url");
		expect(() => decodeCursor(wrongType)).toThrow(/invalid cursor/);
	});
});

describe("compareSortKey", () => {
	it("importance 大的排前(descending)", () => {
		const a = { importance: 0.9, updatedAt: 100, id: "a" };
		const b = { importance: 0.5, updatedAt: 100, id: "a" };
		expect(compareSortKey(a, b)).toBe(-1);
		expect(compareSortKey(b, a)).toBe(1);
	});

	it("importance 相同,updatedAt 新的排前", () => {
		const a = { importance: 0.5, updatedAt: 200, id: "a" };
		const b = { importance: 0.5, updatedAt: 100, id: "a" };
		expect(compareSortKey(a, b)).toBe(-1);
	});

	it("importance + updatedAt 都相同,id 字典序排前(稳定)", () => {
		const a = { importance: 0.5, updatedAt: 100, id: "aaa" };
		const b = { importance: 0.5, updatedAt: 100, id: "bbb" };
		expect(compareSortKey(a, b)).toBe(-1);
	});

	it("完全相同的 key 返回 0", () => {
		const a = { importance: 0.5, updatedAt: 100, id: "a" };
		expect(compareSortKey(a, a)).toBe(0);
	});
});
