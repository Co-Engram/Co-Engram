import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

// 用 createRequire 绕过 Vite 静态分析:`import("node:sqlite")` 在 vitest 2.x 下
// 会被 Vite 拦截报 `Failed to load url sqlite`。createRequire 在运行时调用,
// Vite 无法静态解析,直接走 Node builtin resolver。
// 这是 vitest + Node 22+ 新 builtin 的标准 workaround。
const MODULE_NAME = "node:" + "sqlite";
const require = createRequire(import.meta.url);

interface SqliteModule {
	DatabaseSync: new (path: string) => {
		exec(sql: string): void;
		prepare(sql: string): { run(...args: unknown[]): unknown; get<T = unknown>(): T | undefined };
		close(): void;
	};
}

function loadSqlite(): SqliteModule["DatabaseSync"] | null {
	try {
		const mod = require(MODULE_NAME) as SqliteModule;
		return mod.DatabaseSync;
	} catch (e) {
		console.warn(
			"node:sqlite 不可用 — 跳过(CI 矩阵需覆盖 Node 22+)",
			e instanceof Error ? e.message : e,
		);
		return null;
	}
}

describe("node:sqlite smoke", () => {
	it("可以打开内存数据库并执行简单 SQL", () => {
		const DatabaseSync = loadSqlite();
		if (!DatabaseSync) return;
		const db = new DatabaseSync(":memory:");
		db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
		const insert = db.prepare("INSERT INTO t (v) VALUES (?)");
		insert.run("hello");
		const row = db.prepare("SELECT * FROM t").get<{ id: number; v: string }>();
		expect(row).toEqual({ id: 1, v: "hello" });
		db.close();
	});

	it("支持 FTS5 + trigram tokenizer", () => {
		const DatabaseSync = loadSqlite();
		if (!DatabaseSync) return;
		const db = new DatabaseSync(":memory:");
		db.exec(`
			CREATE VIRTUAL TABLE fts USING fts5(
				content,
				tokenize = 'trigram'
			)
		`);
		db.prepare("INSERT INTO fts (rowid, content) VALUES (?, ?)").run(1, "中文测试 memory");
		// FTS5 MATCH 不支持直接 bind 到操作数,用字符串拼接 + escape
		// trigram tokenizer 要求 query ≥ 3 字符
		const query = "中文测".replace(/'/g, "''");
		const hit = db.prepare(`SELECT content FROM fts WHERE fts MATCH '${query}'`).get<{ content: string }>();
		expect(hit?.content).toContain("中文");
		db.close();
	});
});
