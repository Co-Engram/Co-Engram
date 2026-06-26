/**
 * Graph View 视图配置（spec §12.9，P3 4.7.4）
 *
 * 把"当前 filter + 布局 + 缩放"序列化为可保存/分享的配置。
 *
 * 用途：
 *   - 保存视图：保存到 `config/graph-views/<name>.yaml`（Git 友好）
 *   - 分享视图：URL 编码所有 filter state，团队成员可复现
 *   - 截图导出：附带视图配置作为 metadata
 *
 * @module @co-engram/core/graph
 */

import type { GraphFilter } from "./snapshot.js";
import type { LayoutAlgorithm } from "./layout.js";
import type { ScenePresetId } from "./presets.js";

/** 完整的视图配置（可序列化） */
export interface GraphViewConfig {
  /** 配置 schema 版本 */
  readonly schemaVersion: 1;
  /** 视图名称（用作文件名） */
  readonly name: string;
  /** 视图描述 */
  readonly description?: string;
  /** 创建者 */
  readonly createdBy?: string;
  /** 创建时间 ISO */
  readonly createdAt?: string;
  /** 更新时间 ISO */
  readonly updatedAt?: string;

  /** 关联的场景预设（可选） */
  readonly scenePreset?: ScenePresetId;

  /** 过滤器 */
  readonly filter: GraphFilter;

  /** 布局算法 */
  readonly layout: LayoutAlgorithm;

  /** 视口状态（UI 层使用） */
  readonly viewport?: GraphViewport;

  /** 显示选项（UI 层使用） */
  readonly display?: GraphDisplayOptions;
}

/** 视口（缩放/平移） */
export interface GraphViewport {
  readonly zoom: number;
  readonly centerX: number;
  readonly centerY: number;
}

/** 显示选项 */
export interface GraphDisplayOptions {
  /** 是否显示边标签 */
  readonly showEdgeLabels?: boolean;
  /** 是否显示节点 importance */
  readonly showImportance?: boolean;
  /** 节点大小映射字段 */
  readonly nodeSizeBy?:
    | "fixed"
    | "importance"
    | "retrievalCount"
    | "incomingCount";
  /** 节点颜色映射字段 */
  readonly nodeColorBy?: "kind" | "domain" | "createdBy" | "freshness";
  /** 边粗细映射字段 */
  readonly edgeWidthBy?: "fixed" | "weight" | "kind";
}

/** 序列化选项 */
export interface SerializeOptions {
  /** 缩进（默认 2） */
  readonly indent?: number;
}

/**
 * 序列化 GraphViewConfig 为 YAML 字符串
 *
 * 用于保存到 `config/graph-views/<name>.yaml`（Git 友好的纯文本）。
 */
export function serializeViewConfig(
  config: GraphViewConfig,
  options: SerializeOptions = {},
): string {
  const indent = options.indent ?? 2;
  return toYaml(config, indent);
}

/**
 * 反序列化 YAML 字符串为 GraphViewConfig
 *
 * 简易 YAML 解析（不支持完整 YAML spec，只支持本模块生成的格式）。
 * 生产环境建议用 `js-yaml` 或类似库。
 */
export function parseViewConfig(raw: string): GraphViewConfig {
  const parsed = parseYaml(raw);
  return normalizeViewConfig(parsed);
}

/**
 * 把 GraphViewConfig 编码为 URL 参数
 *
 * 用于分享视图：URL 编码所有 filter state（spec §12.9）
 */
export function encodeViewConfigToUrl(config: GraphViewConfig): string {
  // 简化版：用 base64 编码 JSON
  const json = JSON.stringify(config);
  const b64 = Buffer.from(json, "utf8").toString("base64");
  return `view=${b64}`;
}

/**
 * 从 URL 参数解码 GraphViewConfig
 */
export function decodeViewConfigFromUrl(urlParam: string): GraphViewConfig {
  const b64 = urlParam.startsWith("view=") ? urlParam.slice(5) : urlParam;
  const json = Buffer.from(b64, "base64").toString("utf8");
  const parsed = JSON.parse(json) as Record<string, unknown>;
  return normalizeViewConfig(parsed);
}

// ============================================================
// 默认配置
// ============================================================

export interface DefaultViewConfigOptions {
  readonly name: string;
  readonly description?: string;
  readonly createdBy?: string;
  readonly filter?: GraphFilter;
  readonly layout?: LayoutAlgorithm;
}

/**
 * 创建默认视图配置
 */
export function createDefaultViewConfig(
  options: DefaultViewConfigOptions,
): GraphViewConfig {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    name: options.name,
    description: options.description,
    createdBy: options.createdBy,
    createdAt: now,
    updatedAt: now,
    filter: options.filter ?? {},
    layout: options.layout ?? "force-directed",
  };
}

// ============================================================
// 内部：YAML 序列化/解析（简化版）
// ============================================================

function toYaml(value: unknown, indent: number, depth = 0): string {
  const pad = " ".repeat(indent * depth);
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") {
    // 需要引号的字符串
    if (/[:#{}\[\],&*?|<>=!%@`]/.test(value) || value.includes("\n")) {
      return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    }
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map((v) => {
      const inner = toYaml(v, indent, depth + 1);
      return `${pad}- ${inner.trimStart()}`;
    });
    return "\n" + items.join("\n");
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, v]) => v !== undefined,
    );
    if (entries.length === 0) return "{}";
    const lines = entries.map(([k, v]) => {
      if (v !== null && typeof v === "object" && !Array.isArray(v)) {
        const nested = toYaml(v, indent, depth + 1);
        return `${pad}${k}:\n${nested}`;
      }
      if (Array.isArray(v) && v.length > 0) {
        const nested = toYaml(v, indent, depth + 1);
        return `${pad}${k}:${nested}`;
      }
      if (Array.isArray(v) && v.length === 0) {
        return `${pad}${k}: []`;
      }
      return `${pad}${k}: ${toYaml(v, indent, depth + 1)}`;
    });
    return lines.join("\n");
  }
  return String(value);
}

function parseYaml(raw: string): Record<string, unknown> {
  const lines = raw
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("#"));
  const root: Record<string, unknown> = {};
  const stack: Array<{
    indent: number;
    container: Record<string, unknown> | unknown[];
  }> = [{ indent: -1, container: root }];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const indent = line.length - line.trimStart().length;
    const content = line.trim();

    // 弹出栈直到找到父容器
    while (stack.length > 1 && stack[stack.length - 1]!.indent >= indent) {
      stack.pop();
    }
    const container = stack[stack.length - 1]!.container;

    if (content.startsWith("- ")) {
      if (Array.isArray(container)) {
        container.push(parseScalar(content.slice(2)));
      }
      continue;
    }

    if (content.includes(":")) {
      if (Array.isArray(container)) continue;
      const colonIdx = content.indexOf(":");
      const key = content.slice(0, colonIdx).trim();
      const valueStr = content.slice(colonIdx + 1).trim();

      if (valueStr === "") {
        const nextLine = lines[i + 1];
        const nextIsArray =
          nextLine !== undefined &&
          nextLine.trim().startsWith("- ") &&
          nextLine.length - nextLine.trimStart().length > indent;
        if (nextIsArray) {
          const newArr: unknown[] = [];
          container[key] = newArr;
          stack.push({ indent, container: newArr });
        } else {
          const newObj: Record<string, unknown> = {};
          container[key] = newObj;
          stack.push({ indent, container: newObj });
        }
      } else {
        container[key] = parseScalar(valueStr);
      }
    }
  }

  return root;
}

function parseScalar(s: string): unknown {
  if (s === "null") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "[]") return [];
  if (s === "{}") return {};
  if (s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
  return s;
}

function normalizeViewConfig(parsed: Record<string, unknown>): GraphViewConfig {
  if (parsed.schemaVersion !== 1) {
    // 未来版本迁移点
  }
  const filter = (parsed.filter as GraphFilter) ?? {};
  const layout = (parsed.layout as LayoutAlgorithm) ?? "force-directed";
  const viewport = parsed.viewport as GraphViewport | undefined;
  const display = parsed.display as GraphDisplayOptions | undefined;
  const scenePreset = parsed.scenePreset as ScenePresetId | undefined;

  return {
    schemaVersion: 1,
    name: String(parsed.name ?? "unnamed"),
    description: parsed.description ? String(parsed.description) : undefined,
    createdBy: parsed.createdBy ? String(parsed.createdBy) : undefined,
    createdAt: parsed.createdAt ? String(parsed.createdAt) : undefined,
    updatedAt: parsed.updatedAt ? String(parsed.updatedAt) : undefined,
    scenePreset,
    filter,
    layout,
    viewport,
    display,
  };
}
