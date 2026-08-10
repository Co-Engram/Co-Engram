/**
 * Engram / Synapse 磁盘字段名双语映射
 *
 * 设计要点：
 * - 内存运行时字段名永远是英文（`EngramFrontmatter` interface 的硬约束）
 * - 磁盘 YAML 字段名根据当前 language 决定（英文 identity / 中文映射）
 * - `__lang` / `__语言` 是保留字段：写入时填入，读取后剥离（不进入运行时对象）
 * - 反向索引在模块加载时一次性构建（O(1) lookup）
 *
 * @module @co-engram/core/i18n
 */

import type { Language } from "./types.js";

/**
 * Frontmatter 中标记语言的保留字段（写入时填入，delocalize 时剥离）
 *
 * 英文模式：`__lang: en`
 * 中文模式：`__语言: zh`
 */
export const LANG_MARKER_FIELD_EN = "__lang";
export const LANG_MARKER_FIELD_ZH = "__语言";

/**
 * Engram frontmatter 字段映射
 *
 * key = 运行时英文字段名（与 `EngramFrontmatter` interface 对齐）
 * value = 该语言下的磁盘字段名
 */
export const ENGRAM_FIELD_MAP: Readonly<
  Record<Language, Readonly<Record<string, string>>>
> = {
  en: {
    id: "id",
    title: "title",
    slug: "slug",
    kind: "kind",
    kinds: "kinds",
    tags: "tags",
    domainTags: "domainTags",
    summary: "summary",
    contentHash: "contentHash",
    contentSize: "contentSize",
    createdBy: "createdBy",
    createdAt: "createdAt",
    updatedBy: "updatedBy",
    updatedAt: "updatedAt",
    version: "version",
    importance: "importance",
    confidence: "confidence",
    sourceType: "sourceType",
    evidenceCount: "evidenceCount",
    retrievalCount: "retrievalCount",
    effectiveRetrievals: "effectiveRetrievals",
    failedUses: "failedUses",
    reinforcementScore: "reinforcementScore",
    lastRetrievedAt: "lastRetrievedAt",
    lastEffectiveAt: "lastEffectiveAt",
    lastRetrievalScore: "lastRetrievalScore",
    forcedFreshness: "forcedFreshness",
    status: "status",
    visibility: "visibility",
    verificationStatus: "verificationStatus",
    encodingContext: "encodingContext",
    perspective: "perspective",
    contextTags: "contextTags",
  },
  zh: {
    id: "标识",
    title: "标题",
    slug: "别名",
    kind: "类型",
    kinds: "类型列表",
    tags: "标签",
    domainTags: "领域标签",
    summary: "摘要",
    contentHash: "内容哈希",
    contentSize: "内容大小",
    createdBy: "创建者",
    createdAt: "创建时间",
    updatedBy: "更新者",
    updatedAt: "更新时间",
    version: "版本",
    importance: "重要性",
    confidence: "置信度",
    sourceType: "来源类型",
    evidenceCount: "证据数",
    retrievalCount: "检索次数",
    effectiveRetrievals: "有效检索数",
    failedUses: "失败使用数",
    reinforcementScore: "强化分数",
    lastRetrievedAt: "最近检索时间",
    lastEffectiveAt: "最近有效时间",
    lastRetrievalScore: "最近检索分数",
    forcedFreshness: "强制新鲜度",
    status: "状态",
    visibility: "可见性",
    verificationStatus: "验证状态",
    encodingContext: "编码情境",
    perspective: "视角",
    contextTags: "情境标签",
  },
};

/**
 * Synapse 顶层字段映射
 */
export const SYNAPSE_FIELD_MAP: Readonly<
  Record<Language, Readonly<Record<string, string>>>
> = {
  en: {
    id: "id",
    from: "from",
    to: "to",
    kind: "kind",
    weight: "weight",
    evidence: "evidence",
    createdBy: "createdBy",
    createdAt: "createdAt",
    updatedAt: "updatedAt",
    sourceSemantic: "sourceSemantic",
    targetSemantic: "targetSemantic",
    resolutionState: "resolutionState",
  },
  zh: {
    id: "标识",
    from: "起点",
    to: "终点",
    kind: "类型",
    weight: "权重",
    evidence: "证据",
    createdBy: "创建者",
    createdAt: "创建时间",
    updatedAt: "更新时间",
    sourceSemantic: "源语义",
    targetSemantic: "目标语义",
    resolutionState: "裁决状态",
  },
};

/**
 * SynapseEvidence 嵌套字段映射（数组元素的 shape）
 */
export const SYNAPSE_EVIDENCE_FIELD_MAP: Readonly<
  Record<Language, Readonly<Record<string, string>>>
> = {
  en: {
    description: "description",
    source: "source",
    confidence: "confidence",
    addedAt: "addedAt",
    addedBy: "addedBy",
  },
  zh: {
    description: "描述",
    source: "来源",
    confidence: "置信度",
    addedAt: "添加时间",
    addedBy: "添加者",
  },
};

/**
 * SynapseResolutionState 嵌套字段映射
 */
export const SYNAPSE_RESOLUTION_FIELD_MAP: Readonly<
  Record<Language, Readonly<Record<string, string>>>
> = {
  en: {
    status: "status",
    phase: "phase",
    verdict: "verdict",
    rationale: "rationale",
    confidence: "confidence",
    escalatedTo: "escalatedTo",
    escalatedAt: "escalatedAt",
    expiresAt: "expiresAt",
    resolvedAt: "resolvedAt",
    resolvedBy: "resolvedBy",
  },
  zh: {
    status: "状态",
    phase: "阶段",
    verdict: "裁决",
    rationale: "理由",
    confidence: "置信度",
    escalatedTo: "升级给",
    escalatedAt: "升级时间",
    expiresAt: "过期时间",
    resolvedAt: "解决时间",
    resolvedBy: "解决者",
  },
};

/**
 * 模块加载时构建的反向索引：磁盘字段名（任意语言）→ 运行时英文字段名
 *
 * 若同一个中文 key 恰好与某个英文 key 重名（实际不会发生，因为中文 keys 都是中文词），
 * 英文优先（先注册）。
 */
function buildReverseMap(
  fieldMap: Readonly<Record<Language, Readonly<Record<string, string>>>>,
): Readonly<Record<string, string>> {
  const reverse: Record<string, string> = {};
  // 先注册英文（identity），再注册中文；若冲突英文优先
  for (const [enKey, enDiskKey] of Object.entries(fieldMap.en)) {
    reverse[enDiskKey] = enKey;
  }
  for (const [enKey, zhDiskKey] of Object.entries(fieldMap.zh)) {
    if (!(zhDiskKey in reverse)) {
      reverse[zhDiskKey] = enKey;
    }
  }
  return Object.freeze(reverse);
}

export const ENGRAM_FIELD_REVERSE_MAP = buildReverseMap(ENGRAM_FIELD_MAP);
export const SYNAPSE_FIELD_REVERSE_MAP = buildReverseMap(SYNAPSE_FIELD_MAP);
export const SYNAPSE_EVIDENCE_FIELD_REVERSE_MAP = buildReverseMap(
  SYNAPSE_EVIDENCE_FIELD_MAP,
);
export const SYNAPSE_RESOLUTION_FIELD_REVERSE_MAP = buildReverseMap(
  SYNAPSE_RESOLUTION_FIELD_MAP,
);

/**
 * 语言标记字段的反向索引：磁盘标记名 → 是否中文
 */
const LANG_MARKER_REVERSE: Record<string, boolean> = {
  [LANG_MARKER_FIELD_EN]: false,
  [LANG_MARKER_FIELD_ZH]: true,
};

/**
 * 把对象的所有 key 按 fieldMap 替换为目标语言的磁盘字段名
 *
 * - 值保持不变（包括嵌套数组/对象，调用方负责递归）
 * - 写入前调用
 *
 * @param obj 原始对象（运行时英文 keys）
 * @param language 目标语言
 * @param fieldMap 字段映射表（ENGRAM_FIELD_MAP / SYNAPSE_FIELD_MAP / ...）
 * @param options.attachLangMarker 是否追加 `__lang` / `__语言` 标记字段
 */
export function localizeKeys<T extends Record<string, unknown>>(
  obj: T,
  language: Language,
  fieldMap: Readonly<Record<Language, Readonly<Record<string, string>>>>,
  options?: { attachLangMarker?: boolean },
): Record<string, unknown> {
  const targetMap = fieldMap[language];
  const out: Record<string, unknown> = {};
  for (const [runtimeKey, value] of Object.entries(obj)) {
    const diskKey = targetMap[runtimeKey] ?? runtimeKey;
    out[diskKey] = value;
  }
  if (options?.attachLangMarker) {
    if (language === "zh") {
      out[LANG_MARKER_FIELD_ZH] = "zh";
    } else {
      out[LANG_MARKER_FIELD_EN] = "en";
    }
  }
  return out;
}

/**
 * 把磁盘读出的对象 key 归一化为运行时英文字段名
 *
 * - 反向索引找不到的 key 原样保留（兼容未知字段 / 扩展字段）
 * - 剥离语言标记字段（`__lang` / `__语言`），返回值附带检测到的语言
 *
 * @param rawObj 磁盘读出的对象（YAML parse 结果）
 * @param reverseMap 反向索引
 */
export function delocalizeKeys(
  rawObj: Record<string, unknown>,
  reverseMap: Readonly<Record<string, string>>,
): {
  normalized: Record<string, unknown>;
  detectedLanguage: Language | undefined;
} {
  const normalized: Record<string, unknown> = {};
  let detectedLanguage: Language | undefined;

  for (const [diskKey, value] of Object.entries(rawObj)) {
    // 先检测语言标记
    if (diskKey in LANG_MARKER_REVERSE) {
      detectedLanguage = LANG_MARKER_REVERSE[diskKey] ? "zh" : "en";
      continue; // 标记字段不进入运行时对象
    }
    const runtimeKey = reverseMap[diskKey] ?? diskKey;
    normalized[runtimeKey] = value;
  }

  return { normalized, detectedLanguage };
}

/**
 * 递归 localize Synapse 完整对象（顶层 + evidence[] + resolutionState）
 *
 * Synapse 的嵌套结构需要递归处理，不能只映射顶层。
 */
export function localizeSynapse(
  synapse: Record<string, unknown>,
  language: Language,
  options?: { attachLangMarker?: boolean },
): Record<string, unknown> {
  const topLocalized = localizeKeys(
    synapse,
    language,
    SYNAPSE_FIELD_MAP,
    options,
  );
  const synapseMap = SYNAPSE_FIELD_MAP[language]!;

  // evidence: 数组，每个元素用 SYNAPSE_EVIDENCE_FIELD_MAP
  const evidenceDiskKey = synapseMap.evidence!;
  if (Array.isArray(topLocalized[evidenceDiskKey])) {
    topLocalized[evidenceDiskKey] = (
      topLocalized[evidenceDiskKey] as Array<Record<string, unknown>>
    ).map((item) => localizeKeys(item, language, SYNAPSE_EVIDENCE_FIELD_MAP));
  }

  // resolutionState: 对象（可选），用 SYNAPSE_RESOLUTION_FIELD_MAP
  const resolutionDiskKey = synapseMap.resolutionState!;
  if (
    topLocalized[resolutionDiskKey] &&
    typeof topLocalized[resolutionDiskKey] === "object"
  ) {
    topLocalized[resolutionDiskKey] = localizeKeys(
      topLocalized[resolutionDiskKey] as Record<string, unknown>,
      language,
      SYNAPSE_RESOLUTION_FIELD_MAP,
    );
  }

  return topLocalized;
}

/**
 * 递归 delocalize Synapse 完整对象（磁盘 → 运行时）
 */
export function delocalizeSynapse(rawSynapse: Record<string, unknown>): {
  normalized: Record<string, unknown>;
  detectedLanguage: Language | undefined;
} {
  const { normalized: topNormalized, detectedLanguage } = delocalizeKeys(
    rawSynapse,
    SYNAPSE_FIELD_REVERSE_MAP,
  );

  // evidence 反向映射
  if (Array.isArray(topNormalized.evidence)) {
    topNormalized.evidence = (
      topNormalized.evidence as Array<Record<string, unknown>>
    ).map((item) => {
      const ev = delocalizeKeys(item, SYNAPSE_EVIDENCE_FIELD_REVERSE_MAP);
      return ev.normalized;
    });
  }

  // resolutionState 反向映射
  if (
    topNormalized.resolutionState &&
    typeof topNormalized.resolutionState === "object"
  ) {
    const rs = delocalizeKeys(
      topNormalized.resolutionState as Record<string, unknown>,
      SYNAPSE_RESOLUTION_FIELD_REVERSE_MAP,
    );
    topNormalized.resolutionState = rs.normalized;
  }

  return { normalized: topNormalized, detectedLanguage };
}

/**
 * 启发式检测：磁盘读出的对象是否使用中文字段名
 *
 * 仅在 `__lang` / `__语言` 标记缺失时使用。检测条件：
 * - 对象包含任意一个中文 keys（来自 ENGRAM_FIELD_MAP.zh / SYNAPSE_FIELD_MAP.zh）
 *
 * @param rawKeys 磁盘读出的对象的所有 key
 */
export function detectChineseKeys(rawKeys: readonly string[]): boolean {
  const zhKeys = new Set<string>();
  for (const zk of Object.values(ENGRAM_FIELD_MAP.zh)) zhKeys.add(zk);
  for (const zk of Object.values(SYNAPSE_FIELD_MAP.zh)) zhKeys.add(zk);
  for (const zk of Object.values(SYNAPSE_EVIDENCE_FIELD_MAP.zh)) zhKeys.add(zk);
  for (const zk of Object.values(SYNAPSE_RESOLUTION_FIELD_MAP.zh))
    zhKeys.add(zk);
  return rawKeys.some((k) => zhKeys.has(k));
}
