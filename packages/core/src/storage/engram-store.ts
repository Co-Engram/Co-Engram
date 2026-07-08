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
import { ULID_REGEX } from "../types/repository-types.js";
import { computeContentHash, computeContentSize } from "./hash.js";
import type { Language } from "../i18n/types.js";
import { DEFAULT_LANGUAGE } from "../i18n/index.js";
import {
  ENGRAM_FIELD_MAP,
  ENGRAM_FIELD_REVERSE_MAP,
  delocalizeKeys,
  detectChineseKeys,
  localizeKeys,
} from "../i18n/field-names.js";

/**
 * frontmatter 字段校验问题(parseEngramFile 内部收集,不抛错)。
 *
 * _validationIssues 字段是 EngramFile 的可选属性,consumer 可忽略;
 * runDoctor 消费它转成 DoctorIssue 上报。
 */
export interface ValidationIssue {
  /** 字段路径,如 "kind" / "kinds[0]" / "visibility" */
  readonly field: string;
  readonly category:
    | "type_mismatch"
    | "out_of_range"
    | "invalid_enum"
    | "invalid_format"
    | "missing_required"
    | "unknown_field"
    | "derived_mismatch";
  readonly severity: "critical" | "high" | "medium" | "low";
  /** 人类可读说明,如 "kind must be one of: observation, fact, pattern, procedure, hypothesis" */
  readonly message: string;
  /** 当前值(供 doctor 展示) */
  readonly currentValue: unknown;
  /** 期望类型/格式(可选,如 "ULID" / "ISO 8601 date" / "number in [0,1]") */
  readonly expectedType?: string;
  /** 枚举的合法值列表(invalid_enum 用) */
  readonly validValues?: readonly unknown[];
}

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
  /**
   * 校验问题清单(parseEngramFile 内部收集,不抛错)。
   *
   * 下划线前缀显式标记"内部字段,消费者应忽略";只有 runDoctor 消费它。
   * 老 consumer(readEngramFile / rebuildEngramIndex / syncEngramToIndex /
   * FTS / viewer)忽略此字段即向后兼容。
   */
  readonly _validationIssues?: readonly ValidationIssue[];
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

const NUMERIC_FIELDS = new Set([
  "importance",
  "confidence",
  "lastRetrievalScore",
  "reinforcementScore",
  "evidenceCount",
  "retrievalCount",
  "effectiveRetrievals",
  "failedUses",
  "version",
  "contentSize",
]);

const ARRAY_FIELDS = new Set([
  "domainTags",
  "tags",
  "contextTags",
  "kinds",
]);

const VALID_ENGRAM_KINDS = new Set<string>([
  "observation",
  "fact",
  "pattern",
  "procedure",
  "hypothesis",
]);

const VALID_VISIBILITY = new Set<string>([
  "public",
  "team",
  "private",
  "restricted",
]);

const VALID_STATUS = new Set<string>(["draft", "active", "archived", "forgotten"]);

const VALID_SOURCE_TYPE = new Set<string>([
  "firsthand",
  "secondhand",
  "inferred",
]);

const VALID_FRESHNESS = new Set<string>(["fresh", "aging", "stale", "forgotten"]);

const VALID_VERIFICATION = new Set<string>([
  "unverified",
  "plausible",
  "probable",
  "verified",
  "refuted",
]);

const REQUIRED_FIELDS: ReadonlyArray<{
  readonly name: string;
  readonly severity: ValidationIssue["severity"];
}> = [
  { name: "id", severity: "critical" },
  { name: "title", severity: "high" },
  { name: "kind", severity: "high" },
  { name: "createdBy", severity: "medium" },
  { name: "createdAt", severity: "medium" },
  { name: "updatedAt", severity: "medium" },
];

/**
 * 安全归一化 frontmatter(幂等)。
 *
 * 只做"显式可逆"的轻量转换,失败字段保留原值(留给 validate 报 issue):
 *   - 数值字段:字符串 "0.8" → 0.8(Number() 成功用)
 *   - 数组字段:单值 "x" → ["x"]
 *
 * 不归一化:
 *   - bool → number(语义可疑)
 *   - 枚举外值、时间格式错、id 类型错(值语义只有用户知道)
 */
function normalizeFrontmatter(
  parsed: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...parsed };
  for (const [key, value] of Object.entries(out)) {
    if (NUMERIC_FIELDS.has(key) && typeof value === "string") {
      const converted = Number(value);
      if (!Number.isNaN(converted)) {
        out[key] = converted;
      }
      // NaN 时保留原值,validate 阶段报 type_mismatch
    }
    if (ARRAY_FIELDS.has(key) && typeof value === "string") {
      out[key] = [value];
    }
  }
  return out;
}

/**
 * 校验 frontmatter 字段值合法性,收集 ValidationIssue(不抛错)。
 *
 * 校验维度:
 *   1. 必填字段存在且非空(REQUIRED_FIELDS)
 *   2. id 是合法 ULID
 *   3. 数值字段是 number 且在 [0,1](importance/confidence 等)
 *   4. 枚举字段在合法值集合(kind/visibility/status/sourceType/...)
 *   5. 时间字段是合法 ISO(Date.parse 非 NaN)
 *   6. contentHash 与 contentSize 与实际 content 一致(derived_mismatch)
 *   7. 未知字段(unknown_field)
 */
function validateFrontmatter(
  fm: Record<string, unknown>,
  content: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // === 必填 ===
  for (const { name, severity } of REQUIRED_FIELDS) {
    const v = fm[name];
    if (v === undefined || v === null || v === "") {
      issues.push({
        field: name,
        category: "missing_required",
        severity,
        message: `Required field "${name}" is missing or empty`,
        currentValue: v,
      });
    }
  }

  // === id 必须是 ULID ===
  const id = fm.id;
  if (typeof id === "string" && id.length > 0 && !ULID_REGEX.test(id)) {
    issues.push({
      field: "id",
      category: "invalid_format",
      severity: "high",
      message: `id must match ULID format (26-char Crockford Base32), got: "${id}"`,
      currentValue: id,
      expectedType: "ULID",
    });
  }
  if (typeof id !== "string" && id !== undefined && id !== null) {
    issues.push({
      field: "id",
      category: "type_mismatch",
      severity: "critical",
      message: `id must be a string ULID, got ${typeof id}`,
      currentValue: id,
      expectedType: "ULID string",
    });
  }

  // === 数值字段类型 + 范围 ===
  const numericRangeChecks: ReadonlyArray<{
    readonly name: string;
    readonly min: number;
    readonly max: number;
    readonly severity: ValidationIssue["severity"];
  }> = [
    { name: "importance", min: 0, max: 1, severity: "medium" },
    { name: "confidence", min: 0, max: 1, severity: "medium" },
    { name: "lastRetrievalScore", min: 0, max: 1, severity: "low" },
    { name: "reinforcementScore", min: 0, max: 1, severity: "low" },
  ];
  for (const { name, min, max, severity } of numericRangeChecks) {
    const v = fm[name];
    if (v === undefined) continue;
    if (typeof v !== "number" || Number.isNaN(v)) {
      issues.push({
        field: name,
        category: "type_mismatch",
        severity: "high",
        message: `${name} must be a number, got ${typeof v}`,
        currentValue: v,
        expectedType: `number in [${min}, ${max}]`,
      });
      continue;
    }
    if (v < min || v > max) {
      issues.push({
        field: name,
        category: "out_of_range",
        severity,
        message: `${name}=${v} is out of range [${min}, ${max}]`,
        currentValue: v,
        expectedType: `number in [${min}, ${max}]`,
      });
    }
  }

  // === version 必须正整数 ===
  const version = fm.version;
  if (version !== undefined) {
    if (
      typeof version !== "number" ||
      !Number.isInteger(version) ||
      version < 1
    ) {
      issues.push({
        field: "version",
        category: "type_mismatch",
        severity: "medium",
        message: `version must be a positive integer, got ${String(version)}`,
        currentValue: version,
        expectedType: "positive integer",
      });
    }
  }

  // === contentSize 非负 ===
  const contentSize = fm.contentSize;
  if (typeof contentSize === "number" && contentSize < 0) {
    issues.push({
      field: "contentSize",
      category: "out_of_range",
      severity: "low",
      message: `contentSize=${contentSize} must be non-negative`,
      currentValue: contentSize,
      expectedType: "non-negative integer",
    });
  }

  // === 枚举字段 ===
  const enumChecks: ReadonlyArray<{
    readonly name: string;
    readonly valid: Set<string>;
    readonly severity: ValidationIssue["severity"];
    readonly message: string;
  }> = [
    {
      name: "kind",
      valid: VALID_ENGRAM_KINDS,
      severity: "high",
      message:
        "kind must be one of: observation, fact, pattern, procedure, hypothesis",
    },
    {
      name: "visibility",
      valid: VALID_VISIBILITY,
      severity: "critical", // fail-open 风险
      message:
        "visibility must be one of: public, team, private, restricted (SECURITY: invalid value may cause fail-open visibility leak)",
    },
    {
      name: "status",
      valid: VALID_STATUS,
      severity: "medium",
      message: "status must be one of: draft, active, archived, forgotten",
    },
    {
      name: "sourceType",
      valid: VALID_SOURCE_TYPE,
      severity: "low",
      message: "sourceType must be one of: firsthand, secondhand, inferred",
    },
    {
      name: "forcedFreshness",
      valid: VALID_FRESHNESS,
      severity: "low",
      message: "forcedFreshness must be one of: fresh, aging, stale, forgotten",
    },
    {
      name: "verificationStatus",
      valid: VALID_VERIFICATION,
      severity: "low",
      message:
        "verificationStatus must be one of: unverified, plausible, probable, verified, refuted",
    },
  ];
  for (const { name, valid, severity, message } of enumChecks) {
    const v = fm[name];
    if (v === undefined) continue;
    if (typeof v !== "string" || !valid.has(v)) {
      issues.push({
        field: name,
        category: "invalid_enum",
        severity,
        message,
        currentValue: v,
        validValues: Array.from(valid),
      });
    }
  }

  // === kinds 数组每一项必须在枚举 ===
  const kinds = fm.kinds;
  if (Array.isArray(kinds)) {
    kinds.forEach((k, i) => {
      if (typeof k !== "string" || !VALID_ENGRAM_KINDS.has(k)) {
        issues.push({
          field: `kinds[${i}]`,
          category: "invalid_enum",
          severity: "high",
          message: `kinds[${i}]="${String(k)}" is not a valid EngramKind`,
          currentValue: k,
          validValues: Array.from(VALID_ENGRAM_KINDS),
        });
      }
    });
  }

  // === 时间字段格式 ===
  const dateFields = [
    "createdAt",
    "updatedAt",
    "lastRetrievedAt",
    "lastEffectiveAt",
  ];
  for (const name of dateFields) {
    const v = fm[name];
    if (v === undefined) continue;
    if (typeof v !== "string" || Number.isNaN(Date.parse(v))) {
      issues.push({
        field: name,
        category: "invalid_format",
        severity: "medium",
        message: `${name}="${String(v)}" is not a valid ISO 8601 date`,
        currentValue: v,
        expectedType: "ISO 8601 date string",
      });
    }
  }

  // === contentHash 格式(computeContentHash 返回 "sha256:<64-hex>",共 72 字符)==
  const contentHash = fm.contentHash;
  if (
    typeof contentHash === "string" &&
    contentHash.length > 0 &&
    !/^sha256:[0-9a-f]{64}$/.test(contentHash)
  ) {
    issues.push({
      field: "contentHash",
      category: "invalid_format",
      severity: "low",
      message: "contentHash must be sha256-prefixed 64-char hex (sha256:<hex>)",
      currentValue: contentHash,
      expectedType: "sha256:<64-char hex>",
    });
  }

  // === contentHash 与实际 content 一致(derived_mismatch)==
  if (typeof contentHash === "string" && contentHash.length === 72) {
    const actual = computeContentHash(content);
    if (contentHash !== actual) {
      issues.push({
        field: "contentHash",
        category: "derived_mismatch",
        severity: "medium",
        message: `contentHash does not match actual content (expected ${actual})`,
        currentValue: contentHash,
      });
    }
  }

  // === contentSize 与实际 content 一致 ===
  if (typeof contentSize === "number" && contentSize >= 0) {
    const actual = computeContentSize(content);
    if (contentSize !== actual) {
      issues.push({
        field: "contentSize",
        category: "derived_mismatch",
        severity: "low",
        message: `contentSize=${contentSize} does not match actual ${actual}`,
        currentValue: contentSize,
      });
    }
  }

  // === 未知字段(unknown_field)==
  const knownFields = new Set<string>([
    ...REQUIRED_FIELDS.map((f) => f.name),
    "summary",
    "contentHash",
    "contentSize",
    "slug",
    "tags",
    "forcedFreshness",
    "verificationStatus",
    "encodingContext",
    "perspective",
    "lastRetrievedAt",
    "lastEffectiveAt",
    "lastRetrievalScore",
    "effectiveRetrievals",
    "failedUses",
    "evidenceCount",
    "retrievalCount",
    "__lang",
    "__语言",
  ]);
  // 把 NUMERIC_FIELDS 和 ARRAY_FIELDS 的 key 也加入
  for (const k of NUMERIC_FIELDS) knownFields.add(k);
  for (const k of ARRAY_FIELDS) knownFields.add(k);

  for (const key of Object.keys(fm)) {
    if (!knownFields.has(key)) {
      issues.push({
        field: key,
        category: "unknown_field",
        severity: "low",
        message: `Unknown field "${key}" will be removed by doctor (not in EngramFrontmatter schema)`,
        currentValue: fm[key],
      });
    }
  }

  return issues;
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
 * 检测 raw 字符串是否含 engram frontmatter marker(不尝试 parse)。
 *
 * 与 isEngramFile 的区别:
 *   - isEngramFile 尝试 parse,失败返回 false(无法区分"无 marker"和"marker 坏")
 *   - hasFrontmatterMarker 只看 marker 是否存在,用于 rebuildEngramIndex 分流:
 *     有 marker 但 parse 失败 → invalid_frontmatter;无 marker → orphan_markdown
 *
 * Marker 形式:
 *   - 顶部:开头是 `---\n`
 *   - 底部:含 `<!-- co-engram-meta -->`(BOTTOM_META_MARKER_RE)
 */
export function hasFrontmatterMarker(raw: string): boolean {
  if (raw.startsWith(FRONTMATTER_DELIMITER)) return true;
  return BOTTOM_META_MARKER_RE.test(raw);
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
