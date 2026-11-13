import { describe, expect, it } from "vitest";

import { clampOpacity, normalizePetSkin, normalizeStyle } from "./theme";

describe("normalizeStyle", () => {
  it("test_normalize_style_valid", () => {
    expect(normalizeStyle("a")).toBe("a");
    expect(normalizeStyle("c")).toBe("c");
  });

  it("test_normalize_style_invalid_defaults_c", () => {
    expect(normalizeStyle("d")).toBe("c");
    expect(normalizeStyle(undefined)).toBe("c");
  });
});

describe("clampOpacity", () => {
  it("test_clamp_opacity", () => {
    expect(clampOpacity(2)).toBe(1);
    expect(clampOpacity(0.1)).toBe(0.3);
    expect(clampOpacity(0.7)).toBe(0.7);
    expect(clampOpacity(NaN)).toBe(0.92);
  });
});

describe("normalizePetSkin", () => {
  it("test_normalize_pet_skin_keeps_nonempty", () => {
    expect(normalizePetSkin("official")).toBe("official");
    expect(normalizePetSkin(" official ")).toBe("official");
  });

  it("test_normalize_pet_skin_empty_defaults", () => {
    expect(normalizePetSkin("")).toBe("default");
    expect(normalizePetSkin("   ")).toBe("default");
    expect(normalizePetSkin(undefined)).toBe("default");
  });
});
