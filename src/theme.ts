// Theme settings normalization (v1.1): the pure half of the chat window's
// settings handling — no Tauri imports, unit-testable under vitest. Mirrors
// the Rust-side rules in src-tauri/src/settings.rs (invalid style → "c",
// opacity clamped into [0.3, 1.0], NaN → default 0.92).

export type ThemeStyle = "a" | "b" | "c";

const DEFAULT_STYLE: ThemeStyle = "c";
const OPACITY_MIN = 0.3;
const OPACITY_MAX = 1.0;
const DEFAULT_OPACITY = 0.92;

// style ∉ {"a","b","c"} → "c" (settings.json can be hand-edited; the panel
// only ever sends valid values, but the apply side re-normalizes regardless).
export function normalizeStyle(s: string | undefined): ThemeStyle {
  return s === "a" || s === "b" || s === "c" ? s : DEFAULT_STYLE;
}

// Clamps into [0.3, 1.0]; NaN (e.g. from a corrupted payload) falls back to
// the 0.92 default instead of producing an unusable alpha.
export function clampOpacity(n: number): number {
  if (Number.isNaN(n)) {
    return DEFAULT_OPACITY;
  }
  return Math.min(OPACITY_MAX, Math.max(OPACITY_MIN, n));
}
