/**
 * 稳定排序键:importance DESC, updatedAt DESC, id ASC
 *
 * cursor 是 opaque base64url token,encode 当前页最后一条的 sort key,
 * 让下一页查询能"接着"这个位置往后取(避免 offset 漂移导致的数据跳过/重复)。
 *
 * 选择 base64url 而非 base64:cursor 经常出现在 URL query string,
 * base64url 无需 URL encode(+ / = 等特殊字符)。
 */

import { validationError } from "../tools/error-schema.js";

export interface SortKey {
	readonly importance: number;
	readonly updatedAt: number; // epoch ms
	readonly id: string;
}

export function encodeCursor(key: SortKey): string {
	// 用数组而非 object:更紧凑,且避免 key 顺序歧义
	const json = JSON.stringify([key.importance, key.updatedAt, key.id]);
	return Buffer.from(json, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): SortKey {
	if (!cursor) throw validationError("invalid cursor: empty");
	let json: string;
	try {
		json = Buffer.from(cursor, "base64url").toString("utf8");
	} catch {
		throw validationError("invalid cursor: base64 decode failed");
	}
	let arr: unknown;
	try {
		arr = JSON.parse(json);
	} catch {
		throw validationError("invalid cursor: JSON parse failed");
	}
	if (
		!Array.isArray(arr) ||
		arr.length !== 3 ||
		typeof arr[0] !== "number" ||
		typeof arr[1] !== "number" ||
		typeof arr[2] !== "string"
	) {
		throw validationError("invalid cursor: shape mismatch");
	}
	return { importance: arr[0], updatedAt: arr[1], id: arr[2] };
}

/**
 * 比较两个 sort key,返回 -1 / 0 / 1。
 * 返回 -1 表示 a 排在 b 前面;1 表示 a 排在 b 后面;0 表示相等。
 *
 * 顺序:importance 大→小;同分 updatedAt 新→旧;再同分 id 字典序升序(稳定)。
 *
 * 用于 cursor 分页:取出 cursor 之后,过滤掉所有 compareSortKey(key, cursor) <= 0 的项
 * (cursor 之前或等于的项跳过),从下一个开始取。
 */
export function compareSortKey(a: SortKey, b: SortKey): number {
	if (a.importance !== b.importance) return a.importance > b.importance ? -1 : 1;
	if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? -1 : 1;
	if (a.id !== b.id) return a.id < b.id ? -1 : 1;
	return 0;
}
