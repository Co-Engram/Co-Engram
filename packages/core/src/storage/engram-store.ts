/**
 * Engram 单文件存储(frontmatter + content)
 *
 * 设计要点:
 * - 单文件:meta 字段进 frontmatter,content 跟在后面(英文)或前面(中文)
 * - ULID 作为 stable id(永不变),与路径解耦
 * - 文件可放在任意多层目录,slug 是文件名(可被 frontmatter 锁定)
 *
 * ## 双语双位置格式
 *
 * ### 英文模式(legacy,默认):
 * ```
 * ---
 * id: 01JXKA9F8S7TQN8C9V2F3M4P5
 * title: ...
 * kind: observation
 * ...
 * ---
 *
 * <content>
 * ```
 *
 * ### 中文模式(language='zh'):
 * ```
 * <content>
 *
 * <!-- co-engram-meta:zh -->
 * ---
 * 标识: 01JXKA9F8S7TQN8C9V2F3M4P5
 * 标题: ...
 * 类型: observation
 * ...
 * __语言: zh
 * ---
 * ```
 *
 * 中文模式的字段名按 `ENGRAM_FIELD_MAP.zh` 映射;`__语言: zh` 是保留标记,
 * 解析时剥离,不进入运行时 `Engram` 对象。
 *
 * 解析器(`parseEngramFile`)自动检测两种格式并归一化为运行时英文 keys,
 * 因此旧文件无需迁移即可读取。
 *
 * @module @co-engram/core/storage
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  unlinkSync,
  renameSync,
} from "node:fs";
import { dirname } from "node:path";
import { parse, stringify } from "yaml";

import type {
  EngramKind,
  EngramSourceType,
  EngramVisibility,
  VerificationStatus,
} from "../types/engram.js";
import type { StableEngramId } from "../types/repository-types.js";
import type { Language } from "../i18n/types.js";
import { DEFAULT_LANGUAGE } from "../i18n/index.js";
import {
  ENGRAM_FIELD_MAP,
  ENGRAM_FIELD_REVERSE_MAP,
  delocalizeKeys,
  detectChineseKeys,
  localizeKeys,
} from "../i18n/field-names.js";

/** Frontmatter 字段 */
export interface EngramFrontmatter {
  /** Stable engram id (ULID) */
  readonly id: StableEngramId;
  readonly title: string;
  /** 显式 slug(锁定);不存在则从 title slugify */
  readonly slug?: string;
  /** 显式 domainTags(锁定);不存在则从路径推断 */
  readonly domainTags?: readonly string[];
  readonly kind: EngramKind;
  readonly kinds?: readonly EngramKind[];
  readonly tags?: readonly string[];
  readonly summary?: string;
  readonly contentHash?: string;
  readonly contentSize?: number;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedBy: string;
  readonly updatedAt: string;
  readonly version: number;
  readonly importance?: number;
  readonly confidence?: number;
  readonly sourceType?: EngramSourceType;
  readonly evidenceCount?: number;
  readonly retrievalCount?: number;
  readonly effectiveRetrievals?: number;
  readonly failedUses?: number;
  readonly reinforcementScore?: number;
  readonly lastRetrievedAt?: string;
  readonly lastEffectiveAt?: string;
  readonly lastRetrievalScore?: number;
  /** 显式锁定的 freshness(优先于派生);仅当 lifecycle 工具强制切换时设置 */
  readonly forcedFreshness?: "fresh" | "aging" | "stale" | "forgotten";
  readonly status?: "draft" | "active" | "archived" | "forgotten";
  readonly visibility?: EngramVisibility;
  readonly verificationStatus?: VerificationStatus;
  readonly encodingContext?: string;
  readonly perspective?: string;
  readonly contextTags?: readonly string[];
  /** 其他扩展字段 */
  readonly [key: string]: unknown;
}

/** Engram 单文件结构 */
export interface EngramFile {
  readonly frontmatter: EngramFrontmatter;
  readonly content: string;
}

const FRONTMATTER_DELIMITER = "---";

/**
 * 底部 frontmatter 的开场 HTML 注释标记
 *
 * 形式:`<!-- co-engram-meta:<lang> -->`(`:zh` / `:en`)
 * 解析时容忍缺失 lang 后缀(向后兼容),允许任何后缀值。
 * 注释行让 markdown 渲染器忽略,人类阅读时不被干扰。
 */
const BOTTOM_META_MARKER_RE = /<!--[ \t]*co-engram-meta:?[a-z]*[ \t]*-->\s*\n/;

/**
 * 序列化为 frontmatter + content 的 markdown。
 *
 * - `language='en'`(默认):顶部 frontmatter + 英文字段名(legacy 格式)
 * - `language='zh'`:正文在前 + 底部 frontmatter + 中文字段名 + `__语言: zh` 标记
 *
 * 默认 `'en'` 保证未传 language 的现有调用零破坏。
 */
export function serializeEngramFile(
  file: EngramFile,
  language: Language = DEFAULT_LANGUAGE,
): string {
  const body = file.content.replace(/^\n+/, "").replace(/\n+$/, "");

  // Obsidian 派生段 wikilink 用文件名作 target(见 obsidian-links.ts),
  // 不依赖 frontmatter aliases。中文模式 frontmatter 在文件底部,
  // Obsidian 不识别底部 frontmatter,aliases 注入也无意义。
  // 历史 engram 中残留的 aliases 字段会被显式剥离,doctor 重写后清干净。
  //
  // Task 5.4:剥离前 warn 一次,让用户知道手动加的 aliases 字段会被丢弃
  // (R15 实证:静默剥离让用户困惑"我加的字段去哪了")。
  if (
    "aliases" in file.frontmatter &&
    Array.isArray((file.frontmatter as { aliases?: unknown }).aliases) &&
    (file.frontmatter as { aliases?: unknown[] }).aliases!.length > 0
  ) {
    const id = (file.frontmatter as { id?: string }).id ?? "<unknown>";
    console.warn(
      `[co-engram] engram ${id}: aliases field stripped (legacy field, no longer used; Obsidian wikilinks use filename as target).`,
    );
  }
  const { aliases: _drop, ...frontmatter } = file.frontmatter;
  void _drop;

  if (language === "zh") {
    const localized = localizeKeys(
      frontmatter,
      "zh",
      ENGRAM_FIELD_MAP,
      {
        attachLangMarker: true,
      },
    );
    const yamlStr = stringify(localized, { lineWidth: 0 });
    const yamlTrimmed = yamlStr.endsWith("\n") ? yamlStr : yamlStr + "\n";
    return `${body}\n\n<!-- co-engram-meta:zh -->\n${FRONTMATTER_DELIMITER}\n${yamlTrimmed}${FRONTMATTER_DELIMITER}\n`;
  }

  const yamlStr = stringify(frontmatter, { lineWidth: 0 });
  const yamlTrimmed = yamlStr.endsWith("\n") ? yamlStr : yamlStr + "\n";
  return `${FRONTMATTER_DELIMITER}\n${yamlTrimmed}${FRONTMATTER_DELIMITER}\n\n${body}\n`;
}

/**
 * 解析单文件,自动检测格式(顶部/底部、中文/英文)。
 *
 * 检测顺序:
 * 1. 开头是 `---\n` → 顶部 frontmatter(英文 legacy 或未来中文顶部)
 * 2. 否则若含 `<!-- co-engram-meta:` 标记 → 底部 frontmatter(中文)
 * 3. 否则抛错
 *
 * 解析后:
 * - 反向归一化磁盘 keys 为运行时英文 keys(自动检测中文 keys)
 * - 剥离语言标记字段(`__lang` / `__语言`)
 * - 验证 id/title 存在
 *
 * 解析失败抛 Error(不静默回退,人类错误由 doctor 报告)。
 */
export function parseEngramFile(raw: string): EngramFile {
  // 检测格式:顶部 vs 底部
  let yamlText: string;
  let body: string;

  if (raw.startsWith(FRONTMATTER_DELIMITER)) {
    // 顶部 frontmatter(legacy en 或顶部的 zh)
    const closeMarker = `\n${FRONTMATTER_DELIMITER}\n`;
    const closeIndex = raw.indexOf(closeMarker, FRONTMATTER_DELIMITER.length);
    if (closeIndex === -1) {
      throw new Error(
        "Invalid engram file: missing closing frontmatter delimiter",
      );
    }
    const yamlStart = FRONTMATTER_DELIMITER.length + 1;
    yamlText = raw.slice(yamlStart, closeIndex);
    const bodyRaw = raw.slice(closeIndex + closeMarker.length);
    body = bodyRaw.replace(/^\n+/, "").replace(/\n+$/, "");
  } else {
    // 底部 frontmatter:查找 `<!-- co-engram-meta -->` 标记
    const markerMatch = raw.match(BOTTOM_META_MARKER_RE);
    if (!markerMatch || markerMatch.index === undefined) {
      throw new Error(
        "Invalid engram file: missing frontmatter (expected leading `---` or `<!-- co-engram-meta -->` marker)",
      );
    }
    const yamlRegionStart = markerMatch.index + markerMatch[0].length;
    const rest = raw.slice(yamlRegionStart);
    if (!rest.startsWith(FRONTMATTER_DELIMITER)) {
      throw new Error(
        "Invalid engram file: bottom meta marker not followed by `---`",
      );
    }
    const closeMarker = `\n${FRONTMATTER_DELIMITER}\n`;
    const closeIndex = rest.indexOf(closeMarker, FRONTMATTER_DELIMITER.length);
    if (closeIndex === -1) {
      throw new Error(
        "Invalid engram file: missing closing bottom frontmatter delimiter",
      );
    }
    const yamlStart = FRONTMATTER_DELIMITER.length;
    yamlText = rest.slice(yamlStart, closeIndex);
    const bodyRaw = raw.slice(0, markerMatch.index);
    body = bodyRaw.replace(/^\n+/, "").replace(/\n+$/, "");
  }

  const parsed = parse(yamlText);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid engram file: frontmatter is not an object");
  }

  const rawObj = parsed as Record<string, unknown>;
  const { normalized } = delocalizeKeys(rawObj, ENGRAM_FIELD_REVERSE_MAP);

  // 兜底:如果反向索引未识别出中文 keys(老版数据没有 __语言 标记),
  // 检测 raw 顶层是否含中文 key 并尝试归一化。delocalizeKeys 已用反向索引覆盖,
  // 这里只是确保未来添加新字段时不会丢失。
  void detectChineseKeys; // 保留导入以便未来扩展(启发式检测目前由 delocalizeKeys 覆盖)

  const frontmatter = normalized as EngramFrontmatter;
  if (typeof frontmatter.id !== "string" || frontmatter.id.length === 0) {
    throw new Error("Invalid engram file: frontmatter missing id");
  }
  if (typeof frontmatter.title !== "string") {
    throw new Error("Invalid engram file: frontmatter missing title");
  }

  return { frontmatter, content: body };
}

/** 读取 engram 文件 */
export function readEngramFile(filePath: string): EngramFile {
  const raw = readFileSync(filePath, "utf8");
  return parseEngramFile(raw);
}

/** 写入 engram 文件(自动创建父目录);language 决定磁盘格式 */
export function writeEngramFile(
  filePath: string,
  file: EngramFile,
  language: Language = DEFAULT_LANGUAGE,
): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, serializeEngramFile(file, language), "utf8");
}

/** 删除 engram 文件 */
export function deleteEngramFile(filePath: string): void {
  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }
}

/** 原子重命名(用于 doctor 修复文件路径) */
export function renameEngramFile(oldPath: string, newPath: string): void {
  mkdirSync(dirname(newPath), { recursive: true });
  renameSync(oldPath, newPath);
}

/**
 * 检查文件是否是 engram(顶部 `---` + 有效 frontmatter,或含底部 meta marker)。
 *
 * 用于 doctor 扫描时区分:
 * - 单文件 frontmatter 的 engram
 * - 普通 markdown(无 frontmatter,提示注册为 engram)
 */
export function isEngramFile(raw: string): boolean {
  // 快速路径:顶部 frontmatter
  if (raw.startsWith(FRONTMATTER_DELIMITER)) {
    try {
      parseEngramFile(raw);
      return true;
    } catch {
      return false;
    }
  }
  // 底部 frontmatter:必须含 marker
  if (BOTTOM_META_MARKER_RE.test(raw)) {
    try {
      parseEngramFile(raw);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * 检测已序列化文件的磁盘 language(供迁移逻辑判断是否需重写)。
 *
 * 返回:
 * - `'zh'` — 底部 frontmatter(中文模式)
 * - `'en'` — 顶部 frontmatter 且无中文标记(英文模式)
 * - `undefined` — 不是有效 engram 文件
 */
export function detectEngramFileLanguage(raw: string): Language | undefined {
  if (!isEngramFile(raw)) return undefined;
  // 底部 marker 表示 zh
  if (
    BOTTOM_META_MARKER_RE.test(raw) &&
    !raw.startsWith(FRONTMATTER_DELIMITER)
  ) {
    return "zh";
  }
  return "en";
}
