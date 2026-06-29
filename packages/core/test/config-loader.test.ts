import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config/loader.js";

describe("config.json overrides defaults (Task 1.5)", () => {
  it("fills all sections with defaults when called with empty partial", () => {
    const cfg = loadConfig();
    expect(cfg.version).toBe(1);
    expect(cfg.reinforcement).toBeDefined();
    expect(cfg.search).toBeDefined();
    expect(cfg.observation).toBeDefined();
  });

  it("reinforcement.ltpGain can be overridden", () => {
    const cfg = loadConfig({ reinforcement: { ltpGain: 0.05 } });
    expect(cfg.reinforcement?.ltpGain).toBe(0.05);
    // Other reinforcement fields fall back to defaults
    expect(cfg.reinforcement?.ltdPenalty).toBe(0.03);
    expect(cfg.reinforcement?.hebbianRatio).toBe(0.5);
    expect(cfg.reinforcement?.failureThreshold).toBe(3);
    expect(cfg.reinforcement?.failureEscalation).toBe(1.5);
  });

  it("search weights can be overridden", () => {
    const cfg = loadConfig({
      search: { relevance: 0.6, recency: 0.2, importance: 0.2 },
    });
    expect(cfg.search?.relevance).toBe(0.6);
    expect(cfg.search?.recency).toBe(0.2);
    expect(cfg.search?.importance).toBe(0.2);
  });

  it("search weights default to spec 3.7 (α=0.5, β=0.3, γ=0.2)", () => {
    const cfg = loadConfig();
    expect(cfg.search?.relevance).toBe(0.5);
    expect(cfg.search?.recency).toBe(0.3);
    expect(cfg.search?.importance).toBe(0.2);
  });

  it("observation windows can be overridden per kind", () => {
    const cfg = loadConfig({ observation: { fact: 48 * 60 * 60 * 1000 } });
    expect(cfg.observation?.fact).toBe(48 * 60 * 60 * 1000);
    // Unspecified kinds fall back to defaults
    expect(cfg.observation?.observation).toBe(6 * 60 * 60 * 1000);
    expect(cfg.observation?.hypothesis).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("observation windows default to per-kind spec values", () => {
    const cfg = loadConfig();
    expect(cfg.observation?.observation).toBe(6 * 60 * 60 * 1000); // 6h
    expect(cfg.observation?.fact).toBe(24 * 60 * 60 * 1000); // 24h
    expect(cfg.observation?.pattern).toBe(48 * 60 * 60 * 1000); // 48h
    expect(cfg.observation?.procedure).toBe(48 * 60 * 60 * 1000); // 48h
    expect(cfg.observation?.hypothesis).toBe(7 * 24 * 60 * 60 * 1000); // 7d
  });

  it("partial reinforcement + partial search can be mixed", () => {
    const cfg = loadConfig({
      reinforcement: { hebbianRatio: 0.7 },
      search: { relevance: 0.4 },
    });
    expect(cfg.reinforcement?.hebbianRatio).toBe(0.7);
    expect(cfg.reinforcement?.ltpGain).toBe(0.02); // default
    expect(cfg.search?.relevance).toBe(0.4);
    expect(cfg.search?.recency).toBe(0.3); // default
  });

  it("normalizeConfig round-trip: full override → all fields preserved", () => {
    const original = {
      reinforcement: {
        ltpGain: 0.01,
        ltdPenalty: 0.05,
        hebbianRatio: 0.6,
        failureThreshold: 5,
        failureEscalation: 2.0,
      },
      search: { relevance: 0.7, recency: 0.2, importance: 0.1 },
      observation: {
        observation: 3 * 60 * 60 * 1000,
        fact: 12 * 60 * 60 * 1000,
        pattern: 36 * 60 * 60 * 1000,
        procedure: 36 * 60 * 60 * 1000,
        hypothesis: 14 * 24 * 60 * 60 * 1000,
      },
    };
    const cfg = loadConfig(original);
    expect(cfg.reinforcement).toEqual(original.reinforcement);
    expect(cfg.search).toEqual(original.search);
    expect(cfg.observation).toEqual(original.observation);
  });
});
