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

// Mirrors the Rust clamp (settings.rs clamp_pet_zoom): NaN/negative → 1.0,
// else clamp into [0.5, 1.5] — shared by the pet window (hit-test mapping +
// transform) and the chat window (slider UI); was duplicated verbatim in
// both until the final review dedupe.
const PET_ZOOM_MIN = 0.5;
const PET_ZOOM_MAX = 1.5;
const PET_ZOOM_DEFAULT = 1.0;

export function clampPetZoom(z: number): number {
  if (Number.isNaN(z) || z < 0) {
    return PET_ZOOM_DEFAULT;
  }
  return Math.min(PET_ZOOM_MAX, Math.max(PET_ZOOM_MIN, z));
}

// petSkin (v1.2 多皮肤): 空/空白 → "default"，镜像 src-tauri/src/settings.rs
// 的归一化规则。这里不做可用性校验——皮肤集合归 pet.json 的 skins 映射管，
// 由 chat.ts 的 get_skins 消费侧判断（设置面板渲染实际存在的芯片）。
export function normalizePetSkin(s: string | undefined): string {
  const v = (s ?? "").trim();
  return v === "" ? "default" : v;
}
