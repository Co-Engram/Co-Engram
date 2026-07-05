import { describe, it, expect } from "vitest";
import { renderSpaHtml } from "../src/index.js";

describe("help tab rule visibility (元3 神经科学墙 fix)", () => {
  it("exposes verification 5-state machine with all states", () => {
    const html = renderSpaHtml({ language: "zh" });
    expect(html).toContain("未验证");
    expect(html).toContain("似合理");
    expect(html).toContain("较可能");
    expect(html).toContain("已验证");
    expect(html).toContain("已反驳");
  });

  it("exposes reinforcement parameters with default values (D1 dynamics)", () => {
    const html = renderSpaHtml({ language: "zh" });
    expect(html).toContain("dynamics.updateOnReinforce");
    expect(html).toContain("0.1");
    expect(html).toContain("dynamics.updateOnReportFailure");
    expect(html).toContain("archiveThreshold");
    expect(html).toContain("forgetThreshold");
    expect(html).toContain("hebbianRatio");
    expect(html).toContain("0.5");
  });

  it("exposes observation window concept with per-kind defaults", () => {
    const html = renderSpaHtml({ language: "zh" });
    expect(html).toContain("观察窗口");
    expect(html).toContain("6h");
    expect(html).toContain("24h");
  });

  it("exposes three-factor retrieval weights", () => {
    const html = renderSpaHtml({ language: "zh" });
    expect(html).toContain("relevance");
    expect(html).toContain("recency");
  });

  it("English version mirrors the same content", () => {
    const html = renderSpaHtml({ language: "en" });
    expect(html).toContain("dynamics.updateOnReinforce");
    expect(html).toContain("unverified");
    expect(html).toContain("plausible");
  });
});
