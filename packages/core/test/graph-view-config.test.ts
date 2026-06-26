import { describe, it, expect } from "vitest";
import {
  serializeViewConfig,
  parseViewConfig,
  encodeViewConfigToUrl,
  decodeViewConfigFromUrl,
  createDefaultViewConfig,
  type GraphViewConfig,
} from "../src/graph/index.js";

// ============================================================
// createDefaultViewConfig
// ============================================================

describe("createDefaultViewConfig", () => {
  it("默认配置：force-directed + 空 filter", () => {
    const c = createDefaultViewConfig({ name: "test" });
    expect(c.schemaVersion).toBe(1);
    expect(c.name).toBe("test");
    expect(c.layout).toBe("force-directed");
    expect(c.filter).toEqual({});
    expect(c.createdAt).toBeTruthy();
    expect(c.updatedAt).toBeTruthy();
  });

  it("自定义 filter 和 layout", () => {
    const c = createDefaultViewConfig({
      name: "myview",
      description: "我的视图",
      createdBy: "alice",
      filter: { kinds: ["fact"], minImportance: 0.5 },
      layout: "temporal",
    });
    expect(c.description).toBe("我的视图");
    expect(c.createdBy).toBe("alice");
    expect(c.filter.kinds).toEqual(["fact"]);
    expect(c.layout).toBe("temporal");
  });
});

// ============================================================
// YAML 序列化/解析 round-trip
// ============================================================

describe("YAML round-trip", () => {
  it("基本字段：name + layout", () => {
    const original = createDefaultViewConfig({
      name: "basics",
      description: "基础测试",
      layout: "force-directed",
    });
    const yaml = serializeViewConfig(original);
    const parsed = parseViewConfig(yaml);

    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.name).toBe("basics");
    expect(parsed.description).toBe("基础测试");
    expect(parsed.layout).toBe("force-directed");
  });

  it("含 filter", () => {
    const original = createDefaultViewConfig({
      name: "filtered",
      filter: {
        kinds: ["fact", "pattern"],
        domainTags: ["mobile"],
        minImportance: 0.5,
        maxImportance: 0.9,
        orphansOnly: true,
      },
    });
    const yaml = serializeViewConfig(original);
    const parsed = parseViewConfig(yaml);

    expect(parsed.filter.kinds).toEqual(["fact", "pattern"]);
    expect(parsed.filter.domainTags).toEqual(["mobile"]);
    expect(parsed.filter.minImportance).toBe(0.5);
    expect(parsed.filter.maxImportance).toBe(0.9);
    expect(parsed.filter.orphansOnly).toBe(true);
  });

  it("含 viewport + display", () => {
    const original: GraphViewConfig = {
      schemaVersion: 1,
      name: "full",
      filter: {},
      layout: "domain-cluster",
      viewport: { zoom: 1.5, centerX: 100, centerY: 200 },
      display: {
        showEdgeLabels: true,
        nodeColorBy: "kind",
        nodeSizeBy: "importance",
      },
    };
    const yaml = serializeViewConfig(original);
    const parsed = parseViewConfig(yaml);

    expect(parsed.viewport?.zoom).toBe(1.5);
    expect(parsed.viewport?.centerX).toBe(100);
    expect(parsed.display?.showEdgeLabels).toBe(true);
    expect(parsed.display?.nodeColorBy).toBe("kind");
  });

  it("含 scenePreset", () => {
    const original: GraphViewConfig = {
      schemaVersion: 1,
      name: "preset-view",
      scenePreset: "lineage",
      filter: { synapseKinds: ["derives_from"] },
      layout: "force-directed",
    };
    const yaml = serializeViewConfig(original);
    const parsed = parseViewConfig(yaml);

    expect(parsed.scenePreset).toBe("lineage");
    expect(parsed.filter.synapseKinds).toEqual(["derives_from"]);
  });
});

// ============================================================
// URL 编码/解码
// ============================================================

describe("URL 编码", () => {
  it("round-trip：encode → decode 等价", () => {
    const original: GraphViewConfig = {
      schemaVersion: 1,
      name: "shared",
      filter: { kinds: ["fact"], minImportance: 0.3 },
      layout: "temporal",
    };
    const encoded = encodeViewConfigToUrl(original);
    expect(encoded.startsWith("view=")).toBe(true);

    const decoded = decodeViewConfigFromUrl(encoded);
    expect(decoded.name).toBe("shared");
    expect(decoded.filter.kinds).toEqual(["fact"]);
    expect(decoded.filter.minImportance).toBe(0.3);
    expect(decoded.layout).toBe("temporal");
  });

  it("复杂配置 round-trip", () => {
    const original: GraphViewConfig = {
      schemaVersion: 1,
      name: "complex",
      description: "含所有字段",
      createdBy: "alice",
      scenePreset: "contradictions",
      filter: { contradictionsOnly: true },
      layout: "force-directed",
      viewport: { zoom: 2, centerX: 50, centerY: 75 },
      display: { showEdgeLabels: false, nodeSizeBy: "retrievalCount" },
    };
    const encoded = encodeViewConfigToUrl(original);
    const decoded = decodeViewConfigFromUrl(encoded);

    expect(decoded.description).toBe("含所有字段");
    expect(decoded.scenePreset).toBe("contradictions");
    expect(decoded.filter.contradictionsOnly).toBe(true);
    expect(decoded.viewport?.zoom).toBe(2);
    expect(decoded.display?.nodeSizeBy).toBe("retrievalCount");
  });

  it("解码无 view= 前缀的字符串也可用", () => {
    const original: GraphViewConfig = {
      schemaVersion: 1,
      name: "noPrefix",
      filter: {},
      layout: "kind-group",
    };
    const encoded = encodeViewConfigToUrl(original).slice(5); // 去掉 view=
    const decoded = decodeViewConfigFromUrl(encoded);
    expect(decoded.name).toBe("noPrefix");
    expect(decoded.layout).toBe("kind-group");
  });
});

// ============================================================
// YAML 格式特征
// ============================================================

describe("YAML 格式", () => {
  it("包含 schemaVersion: 1", () => {
    const yaml = serializeViewConfig(createDefaultViewConfig({ name: "x" }));
    expect(yaml).toContain("schemaVersion: 1");
  });

  it("可选字段为 undefined 时不输出", () => {
    const yaml = serializeViewConfig(
      createDefaultViewConfig({ name: "minimal" }),
    );
    expect(yaml).not.toContain("description:");
    expect(yaml).not.toContain("scenePreset:");
    expect(yaml).not.toContain("viewport:");
  });

  it("中文字符串正确序列化", () => {
    const yaml = serializeViewConfig(
      createDefaultViewConfig({ name: "中文视图", description: "描述说明" }),
    );
    expect(yaml).toContain("name: 中文视图");
    expect(yaml).toContain("description: 描述说明");
  });

  it("数组字段正确序列化", () => {
    const yaml = serializeViewConfig(
      createDefaultViewConfig({
        name: "arr",
        filter: { kinds: ["observation", "fact"] },
      }),
    );
    expect(yaml).toContain("- observation");
    expect(yaml).toContain("- fact");
  });
});

// ============================================================
// 端到端：保存到文件再加载
// ============================================================

describe("端到端：保存/加载视图", () => {
  it("序列化后能完整还原（含所有 spec §12.7 场景 filter）", () => {
    const original: GraphViewConfig = {
      schemaVersion: 1,
      name: "all-scenes",
      description: "测试所有场景",
      filter: {
        // 场景 2
        domainTags: ["mobile"],
        // 场景 3
        minImportance: 0.3,
        // 场景 4
        contradictionsOnly: false,
        // 场景 5
        orphansOnly: false,
        // 场景 6
        synapseKinds: ["derives_from", "consolidates", "supersedes"],
        hideContradicts: true,
        // 场景 7
        createdBy: ["alice"],
        // 场景 8
        createdAfter: "2026-01-01",
        createdBefore: "2026-06-01",
        freshness: ["fresh", "aging"],
      },
      layout: "domain-cluster",
    };
    const yaml = serializeViewConfig(original);
    const parsed = parseViewConfig(yaml);

    // 关键字段都保留
    expect(parsed.filter.domainTags).toEqual(["mobile"]);
    expect(parsed.filter.minImportance).toBe(0.3);
    expect(parsed.filter.synapseKinds).toHaveLength(3);
    expect(parsed.filter.createdBy).toEqual(["alice"]);
    expect(parsed.filter.createdAfter).toBe("2026-01-01");
    expect(parsed.filter.freshness).toEqual(["fresh", "aging"]);
  });
});
