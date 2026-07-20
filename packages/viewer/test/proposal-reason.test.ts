import { describe, it, expect } from "vitest";
import { zh, en } from "@co-engram/core";
import { TABS_RUNTIME } from "../src/runtime/tabs.js";

const NEW_KEYS = [
  "viewer.proposals.sourceLine.conversation",
  "viewer.proposals.sourceLine.external",
  "viewer.proposals.sourceLine.autoMemory",
  "viewer.proposals.sourceLine.times",
  "viewer.proposals.why.title",
  "viewer.proposals.why.source",
  "viewer.proposals.why.window",
  "viewer.proposals.why.necessity",
  "viewer.proposals.why.samples",
  "viewer.proposals.why.necessity.conversation",
  "viewer.proposals.why.necessity.fallback",
  "viewer.proposals.why.necessity.external",
  "viewer.proposals.why.necessity.autoMemory",
  "viewer.proposals.why.sourceLabel.conversation",
  "viewer.proposals.why.sourceLabel.external",
  "viewer.proposals.why.sourceLabel.autoMemory",
  "viewer.proposals.why.window.within",
  "viewer.proposals.why.window.minute",
  "viewer.proposals.why.window.hour",
  "viewer.proposals.why.window.day",
  "viewer.proposals.why.advanced",
  "viewer.proposals.why.advancedReason",
  "viewer.proposals.why.advancedRule",
];

describe("提案生成原因 i18n key 双语对等", () => {
  it("zh 与 en 字典都含全部新 key", () => {
    for (const k of NEW_KEYS) {
      expect(zh[k], `zh 缺 ${k}`).toBeTruthy();
      expect(en[k], `en 缺 ${k}`).toBeTruthy();
    }
  });
});
