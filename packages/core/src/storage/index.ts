/**
 * 存储 barrel
 *
 * @module @co-engram/core/storage
 */

export * from "./path.js";
export * from "./hash.js";
export * from "./engram-store.js";
export * from "./synapse-store.js";
export * from "./git.js";
export * from "./git-stage.js";
export * from "./engram-index.js";
export * from "./repository.js";
export * from "./infra-doctor.js";
export * from "./index-cleanup.js";
// index-db.js 显式 re-export:EngramIndexEntry 与 types/repository-types 的同名,
// 不能 export *;只 re-export 公共符号,需要 EngramIndexEntry 类型时直接从
// ./index-db.js import(避免命名冲突 + 保持 SQLite 索引层类型在受控范围)。
export { IndexDb } from "./index-db.js";
export type { SynapseIndexEntry } from "./index-db.js";
export * from "./bootstrap.js";
