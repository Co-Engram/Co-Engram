/**
 * zod v3 shape → dsh ParameterSchemaSpec 转换器
 *
 * dsh 的 defineTool.parameters 是自有 DSL(JSON Schema 子集):
 *   { type: 'string'|'integer'|'number'|'boolean'|'json'|'array'|'object',
 *     required?, description?, enum?, items?, properties?, additionalProperties? }
 * 不认识的 zod 类型降级为 { type: 'json' } —— 工具内部 zod 二次校验保语义安全。
 *
 * @module @co-engram/dsh
 */
import type { z } from "zod";

/** 本地最小 DSL 类型(与 @deepseek-ai/dsh-tools 的 ParameterPropertySpec 结构兼容) */
export interface ParameterPropertySpecLike {
  readonly type:
    | "string"
    | "integer"
    | "number"
    | "boolean"
    | "json"
    | "array"
    | "object";
  readonly required?: true;
  readonly description?: string;
  readonly enum?: readonly (string | number)[];
  readonly items?: ParameterPropertySpecLike;
  readonly properties?: Record<string, ParameterPropertySpecLike>;
  readonly additionalProperties?: boolean;
}

const JSON_FALLBACK: ParameterPropertySpecLike = { type: "json" };

/** zod v3 _def 的最小结构视图 */
interface ZodDefView {
  typeName?: string;
  checks?: Array<{ kind?: string }>;
  values?: readonly (string | number)[];
  value?: string | number;
  type?: z.ZodTypeAny;
  shape?: () => Record<string, z.ZodTypeAny>;
  innerType?: z.ZodTypeAny;
}

function defOf(t: z.ZodTypeAny): ZodDefView {
  return (t as unknown as { _def?: ZodDefView })._def ?? {};
}

function descOf(t: z.ZodTypeAny): { description?: string } {
  const description = (t as unknown as { description?: string }).description;
  return description !== undefined ? { description } : {};
}

/** zod v3 的 .int() 是 checks 里的 kind: 'int' */
function isIntType(t: z.ZodTypeAny): boolean {
  const checks = defOf(t).checks;
  return Array.isArray(checks) && checks.some((c) => c?.kind === "int");
}

/** 单个 zod 类型 → 值 spec(不含 required) */
function zodTypeToValueSpec(t: z.ZodTypeAny): ParameterPropertySpecLike {
  const def = defOf(t);
  const d = descOf(t);
  switch (def.typeName) {
    case "ZodString":
      return { type: "string", ...d };
    case "ZodNumber":
      return { type: isIntType(t) ? "integer" : "number", ...d };
    case "ZodBoolean":
      return { type: "boolean", ...d };
    case "ZodLiteral":
      return { type: typeof def.value === "number" ? "number" : "string", enum: [def.value as string | number], ...d };
    case "ZodEnum":
    case "ZodNativeEnum": {
      const values = (def.values ?? []) as readonly (string | number)[];
      return { type: typeof values[0] === "number" ? "number" : "string", enum: values, ...d };
    }
    case "ZodArray": {
      // zod v3: 元素类型在 _def.type(v4 才是 _def.element)
      const element = def.type ?? def.innerType;
      const items = element ? zodTypeToValueSpec(element) : JSON_FALLBACK;
      return { type: "array", items, ...d };
    }
    case "ZodObject": {
      const shape = typeof def.shape === "function" ? def.shape() : {};
      const properties: Record<string, ParameterPropertySpecLike> = {};
      for (const [k, v] of Object.entries(shape)) {
        properties[k] = zodTypeToProperty(v);
      }
      return { type: "object", properties, additionalProperties: false, ...d };
    }
    case "ZodOptional":
    case "ZodNullable":
    case "ZodDefault": {
      const inner = def.innerType;
      return inner ? zodTypeToValueSpec(inner) : JSON_FALLBACK;
    }
    default:
      return JSON_FALLBACK;
  }
}

/** 顶层属性:optional/default 剥 required,其余 required: true */
function zodTypeToProperty(t: z.ZodTypeAny): ParameterPropertySpecLike {
  const typeName = defOf(t).typeName;
  if (typeName === "ZodOptional" || typeName === "ZodDefault") {
    const inner = defOf(t).innerType;
    const value = inner ? zodTypeToValueSpec(inner) : JSON_FALLBACK;
    // describe 常挂在外层实例(z.string().optional().describe(...)),需合并保留
    const d = descOf(t);
    return Object.keys(d).length > 0 ? { ...value, ...d } : value;
  }
  return { ...zodTypeToValueSpec(t), required: true };
}

/** zod shape(Record<string, ZodType>)→ dsh 参数 DSL */
export function zodShapeToParameterSpec(
  shape: Record<string, z.ZodTypeAny>,
): Record<string, ParameterPropertySpecLike> {
  const out: Record<string, ParameterPropertySpecLike> = {};
  for (const [k, v] of Object.entries(shape)) {
    out[k] = zodTypeToProperty(v);
  }
  return out;
}
