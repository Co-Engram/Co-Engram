/**
 * Obsidian 集成:派生 wikilinks
 *
 * 当 synapse 写入时,自动在涉及的 engram.md 正文末尾追加一个派生段:
 *
 *   <!-- co-engram-derived:synapses -->
 *   ## Synapses (derived)
 *
 *   - → [[01J-xxx|extends]]
 *   - ← [[01J-yyy|similar_to]]
 *
 * 配合 frontmatter 中的 `aliases: [ULID]`(由 serializeEngramFile 自动注入),
 * 让 Obsidian graph view 能可视化记忆网络。Obsidian 解析 wikilink 时,
 * 通过 alias 匹配到对应 engram 文件(文件名可能因 title slug 漂移,ULID 稳定)。
 *
 * 权威源仍是 synapse.yaml;此派生段是 denormalized view,丢失能从 yaml 重建。
 * Obsidian graph 是无差别无向边,kind 信息只能在 wikilink 显示文本里看到。
 *
 * @module @co-engram/core/storage
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { readEngramFile, writeEngramFile, type EngramFile } from "./engram-store.js";
import { readEngramIndex } from "./engram-index.js";
import { listSynapsesForEngram } from "./synapse-store.js";
import type { Language } from "../i18n/types.js";
import type { SynapseKind } from "../types/synapse.js";

/** 派生段起始 marker,兼作剥离锚点 */
export const DERIVED_SYNAPSES_MARKER = "<!-- co-engram-derived:synapses -->";

/** 派生段标题(紧跟 marker) */
const DERIVED_HEADING = "## Synapses (derived)";

/**
 * 排序:contradicts 前置(警告性),其他按 kind 字母序;
 * 同 kind 内按 target ULID 字典序(确定性,不依赖 readdir 顺序)。
 *
 * @param aKind 第一条 synapse 的 kind
 * @param bKind 第二条 synapse 的 kind
 * @param aTarget 第一条 wikilink 的 target ULID(outgoing 用 .to / incoming 用 .from)
 * @param bTarget 第二条 wikilink 的 target ULID
 */
function sortEdges(
  aKind: SynapseKind,
  bKind: SynapseKind,
  aTarget: string,
  bTarget: string,
): number {
  if (aKind === "contradicts" && bKind !== "contradicts") return -1;
  if (bKind === "contradicts" && aKind !== "contradicts") return 1;
  if (aKind < bKind) return -1;
  if (aKind > bKind) return 1;
  // 同 kind:按 target ULID 字典序
  if (aTarget < bTarget) return -1;
  if (aTarget > bTarget) return 1;
  return 0;
}

/**
 * 剥离现有派生段(含 marker 至文件末尾),返回干净正文。
 *
 * 不存在 marker 时返回原 content(去尾空白)。
 */
function stripDerivedSection(content: string): string {
  const idx = content.indexOf(DERIVED_SYNAPSES_MARKER);
  if (idx < 0) return content.replace(/\n+$/, "");
  return content.slice(0, idx).replace(/\n+$/, "");
}

/**
 * 构造派生段字符串。
 *
 * 无 synapse 时返回空串(不写空段,保持 engram 文件干净)。
 */
function buildDerivedSection(
  outgoing: readonly { readonly kind: SynapseKind; readonly to: string }[],
  incoming: readonly { readonly kind: SynapseKind; readonly from: string }[],
): string {
  if (outgoing.length === 0 && incoming.length === 0) return "";

  const lines: string[] = [DERIVED_SYNAPSES_MARKER, DERIVED_HEADING, ""];

  const outgoingSorted = [...outgoing].sort((a, b) =>
    sortEdges(a.kind, b.kind, a.to, b.to),
  );
  for (const s of outgoingSorted) {
    lines.push(`- → [[${s.to}|${s.kind}]]`);
  }

  const incomingSorted = [...incoming].sort((a, b) =>
    sortEdges(a.kind, b.kind, a.from, b.from),
  );
  for (const s of incomingSorted) {
    lines.push(`- ← [[${s.from}|${s.kind}]]`);
  }

  return lines.join("\n");
}

/**
 * 检查一条 engram 的 Obsidian 视图(aliases + 派生段)是否与权威源一致。
 *
 * 用于 doctor 自愈扫描:任一字段 stale 即需要 regenerate。
 *
 * - aliasesMissing:frontmatter.aliases 不存在或不含本 engram.id
 *   (writeEngramFile 会自动注入,但只在写入路径触发)
 * - derivedStale:派生段内容(基于当前 synapse 集合的预期)
 *   与文件正文里的派生段不一致
 *
 * @param file 当前磁盘上的 engram 文件(已 parse)
 * @param touching 当前 synapse 集合(outgoing + incoming)
 */
export function checkObsidianView(
  file: EngramFile,
  touching: {
    readonly outgoing: readonly { readonly kind: SynapseKind; readonly to: string }[];
    readonly incoming: readonly { readonly kind: SynapseKind; readonly from: string }[];
  },
): { readonly aliasesMissing: boolean; readonly derivedStale: boolean } {
  const id = file.frontmatter.id;
  const aliases = file.frontmatter.aliases;
  const aliasesMissing =
    !Array.isArray(aliases) || !aliases.includes(id);

  const cleanBody = stripDerivedSection(file.content);
  const expected = buildDerivedSection(touching.outgoing, touching.incoming);
  const expectedContent = expected ? `${cleanBody}\n\n${expected}` : cleanBody;
  const derivedStale = expectedContent !== file.content;

  return { aliasesMissing, derivedStale };
}

/**
 * 重写一条 engram 的派生 synapse 段 + 注入 aliases。
 *
 * 步骤:
 *   1. 解析 stableId → 相对路径(失败静默返回)
 *   2. 读 engram 文件
 *   3. 剥离现有派生段(幂等)
 *   4. 读 outgoing + incoming synapses
 *   5. 构造新派生段(无 synapse 时 = 不写段)
 *   6. checkObsidianView 判定:aliases 缺失 OR 派生段 stale 才写盘
 *
 * 写盘时 writeEngramFile → serializeEngramFile 会自动注入 aliases: [id]。
 *
 * 永不抛 — 派生段是 denormalized view,失败不阻塞业务。
 *
 * @param dataRoot 仓库根
 * @param stableId engram 的 ULID
 * @param language 写盘语言
 */
export function regenerateObsidianLinks(
  dataRoot: string,
  stableId: string,
  language: Language,
): void {
  try {
    const index = readEngramIndex(dataRoot);
    const entry = index.entries.get(stableId as never);
    if (!entry) return;

    const absPath = join(dataRoot, entry.path);
    if (!existsSync(absPath)) return;

    const file = readEngramFile(absPath);
    const touching = listSynapsesForEngram(dataRoot, stableId);

    const status = checkObsidianView(file, touching);
    if (!status.aliasesMissing && !status.derivedStale) return;

    const cleanBody = stripDerivedSection(file.content);
    const derived = buildDerivedSection(touching.outgoing, touching.incoming);
    const newContent = derived ? `${cleanBody}\n\n${derived}` : cleanBody;

    const newFile: EngramFile = {
      frontmatter: file.frontmatter,
      content: newContent,
    };
    writeEngramFile(absPath, newFile, language);
  } catch {
    // intentional:派生段失败不阻塞业务逻辑
  }
}
