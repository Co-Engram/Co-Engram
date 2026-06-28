/**
 * Obsidian 集成:派生 wikilinks
 *
 * 当 synapse 写入时,自动在涉及的 engram.md 正文末尾追加一个派生段:
 *
 *   <!-- co-engram-derived:synapses -->
 *   ## Synapses (derived)
 *
 *   - → [[co-engram-foo|Some Title · extends]]
 *   - ← [[co-engram-bar|Other Title · similar_to]]
 *
 * wikilink target 用文件名(去 .md),Obsidian 直接解析,不依赖 frontmatter
 * aliases。display 含目标 engram 的标题 + 关系 kind,人类一眼可读。
 *
 * 权威源仍是 synapse.yaml;此派生段是 denormalized view,丢失能从 yaml 重建。
 * 文件名漂移(title 改 → rename)时派生段会断,doctor / cascade refresh 重建。
 *
 * @module @co-engram/core/storage
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { readEngramFile, writeEngramFile, type EngramFile } from "./engram-store.js";
import { readEngramIndex, type EngramIndexMap } from "./engram-index.js";
import { listSynapsesForEngram } from "./synapse-store.js";
import type { Language } from "../i18n/types.js";
import type { SynapseKind } from "../types/synapse.js";

/** 派生段起始 marker,兼作剥离锚点 */
export const DERIVED_SYNAPSES_MARKER = "<!-- co-engram-derived:synapses -->";

/** 派生段标题(紧跟 marker) */
const DERIVED_HEADING = "## Synapses (derived)";

/**
 * 解析后的 edge:wikilink target(文件名,去 .md)+ display(标题)。
 *
 * target 用文件名而非 ULID,Obsidian 无需 frontmatter aliases 即可解析。
 * dangling(synapse 引用不存在的 engram)在 resolve 时被过滤。
 */
interface ResolvedEdge {
  readonly kind: SynapseKind;
  readonly target: string;
  readonly title: string;
}

/**
 * 排序:contradicts 前置(警告性),其他按 kind 字母序;
 * 同 kind 内按 target 文件名字典序(确定性,不依赖 readdir 顺序)。
 */
function sortEdges(a: ResolvedEdge, b: ResolvedEdge): number {
  if (a.kind === "contradicts" && b.kind !== "contradicts") return -1;
  if (b.kind === "contradicts" && a.kind !== "contradicts") return 1;
  if (a.kind < b.kind) return -1;
  if (a.kind > b.kind) return 1;
  if (a.target < b.target) return -1;
  if (a.target > b.target) return 1;
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
 * 通过 engram-index 把 synapse endpoint id 解析为 wikilink target + display。
 *
 * - target = path 最后一段去 .md(文件名)
 * - title = index entry 的 title 字段
 *
 * index 中找不到(dangling synapse)返回 undefined,调用方过滤。
 */
function resolveEdge(
  index: EngramIndexMap,
  id: string,
): { readonly target: string; readonly title: string } | undefined {
  const entry = index.entries.get(id as never);
  if (!entry) return undefined;
  const fileName = entry.path.split("/").pop();
  if (!fileName) return undefined;
  const target = fileName.replace(/\.md$/i, "");
  if (target.length === 0) return undefined;
  return { target, title: entry.title };
}

/**
 * 构造派生段字符串(wikilink target = 文件名,display = "标题 · kind")。
 *
 * 无 resolved edge 时返回空串(不写空段,保持 engram 文件干净)。
 */
function buildDerivedSection(
  outgoing: readonly ResolvedEdge[],
  incoming: readonly ResolvedEdge[],
): string {
  if (outgoing.length === 0 && incoming.length === 0) return "";

  const lines: string[] = [DERIVED_SYNAPSES_MARKER, DERIVED_HEADING, ""];

  for (const s of [...outgoing].sort(sortEdges)) {
    lines.push(`- → [[${s.target}|${s.title} · ${s.kind}]]`);
  }
  for (const s of [...incoming].sort(sortEdges)) {
    lines.push(`- ← [[${s.target}|${s.title} · ${s.kind}]]`);
  }

  return lines.join("\n");
}

/**
 * 把 touching synapse 集合通过 index 解析为 ResolvedEdge(过滤 dangling)。
 */
function resolveTouching(
  index: EngramIndexMap,
  touching: {
    readonly outgoing: readonly { readonly kind: SynapseKind; readonly to: string }[];
    readonly incoming: readonly { readonly kind: SynapseKind; readonly from: string }[];
  },
): { readonly outgoing: readonly ResolvedEdge[]; readonly incoming: readonly ResolvedEdge[] } {
  const outgoing = touching.outgoing
    .map((s) => {
      const r = resolveEdge(index, s.to);
      return r ? { kind: s.kind, target: r.target, title: r.title } : null;
    })
    .filter((x): x is ResolvedEdge => x !== null);
  const incoming = touching.incoming
    .map((s) => {
      const r = resolveEdge(index, s.from);
      return r ? { kind: s.kind, target: r.target, title: r.title } : null;
    })
    .filter((x): x is ResolvedEdge => x !== null);
  return { outgoing, incoming };
}

/**
 * 检查一条 engram 的派生段是否与权威源(synapse yaml)一致。
 *
 * 用于 doctor 自愈扫描:派生段内容(基于当前 synapse 集合的预期)
 * 与文件正文里的派生段不一致 → stale。
 *
 * @param file 当前磁盘上的 engram 文件(已 parse)
 * @param touching 当前 synapse 集合(outgoing + incoming)
 * @param index 用于把 endpoint id 解析为文件名 + 标题
 */
export function checkObsidianView(
  file: EngramFile,
  touching: {
    readonly outgoing: readonly { readonly kind: SynapseKind; readonly to: string }[];
    readonly incoming: readonly { readonly kind: SynapseKind; readonly from: string }[];
  },
  index: EngramIndexMap,
): { readonly stale: boolean } {
  const resolved = resolveTouching(index, touching);
  const cleanBody = stripDerivedSection(file.content);
  const expected = buildDerivedSection(resolved.outgoing, resolved.incoming);
  const expectedContent = expected ? `${cleanBody}\n\n${expected}` : cleanBody;
  return { stale: expectedContent !== file.content };
}

/**
 * 重写一条 engram 的派生 synapse 段。
 *
 * 步骤:
 *   1. 解析 stableId → 相对路径(失败静默返回)
 *   2. 读 engram 文件
 *   3. 剥离现有派生段(幂等)
 *   4. 读 outgoing + incoming synapses
 *   5. 通过 index 把 endpoint id 解析为文件名 + 标题(dangling 过滤)
 *   6. 构造新派生段(无 resolved edge 时 = 不写段)
 *   7. checkObsidianView 判定 stale 才写盘
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

    const status = checkObsidianView(file, touching, index);
    if (!status.stale) return;

    const resolved = resolveTouching(index, touching);
    const cleanBody = stripDerivedSection(file.content);
    const derived = buildDerivedSection(resolved.outgoing, resolved.incoming);
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
