import { describe, expect, it } from "vitest";
import { assertVisibilityTransitionAllowed } from "../src/storage/visibility-gate.js";

describe("assertVisibilityTransitionAllowed", () => {
  it("allows same visibility (no-op)", () => {
    expect(() => assertVisibilityTransitionAllowed("public", "public")).not.toThrow();
    expect(() => assertVisibilityTransitionAllowed("private", "private")).not.toThrow();
  });

  it("allows public → team", () => {
    expect(() => assertVisibilityTransitionAllowed("public", "team")).not.toThrow();
  });

  it("allows team → public (reversible)", () => {
    expect(() => assertVisibilityTransitionAllowed("team", "public")).not.toThrow();
  });

  it("allows public → restricted", () => {
    expect(() => assertVisibilityTransitionAllowed("public", "restricted")).not.toThrow();
  });

  it("allows restricted → public", () => {
    expect(() => assertVisibilityTransitionAllowed("restricted", "public")).not.toThrow();
  });

  it("allows private → public (one-way open)", () => {
    expect(() => assertVisibilityTransitionAllowed("private", "public")).not.toThrow();
  });

  it("allows private → team", () => {
    expect(() => assertVisibilityTransitionAllowed("private", "team")).not.toThrow();
  });

  it("forbids public → private", () => {
    expect(() => assertVisibilityTransitionAllowed("public", "private"))
      .toThrow(/private.*not allowed/);
  });

  it("forbids team → private", () => {
    expect(() => assertVisibilityTransitionAllowed("team", "private"))
      .toThrow(/private.*not allowed/);
  });

  it("forbids restricted → private", () => {
    expect(() => assertVisibilityTransitionAllowed("restricted", "private"))
      .toThrow(/private.*not allowed/);
  });
});
