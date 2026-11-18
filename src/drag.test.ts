import { describe, expect, it } from "vitest";

import { clampDrag, grabOffset, type MonitorBounds } from "./drag";

// 测试基准：猫窗 288×312（物理 px），显示器可见区 = 1920×1056 @ (0,24)
// （顶部 24px 为菜单栏，即 visibleFrame 顶在 y=24）。
const WIN_W = 288;
const WIN_H = 312;
const BOUNDS: MonitorBounds = { x: 0, y: 24, width: 1920, height: 1056 };

describe("grabOffset", () => {
  it("test_grab_offset_delta", () => {
    expect(grabOffset({ x: 1100, y: 700 }, { x: 1000, y: 600 })).toEqual({
      x: 100,
      y: 100,
    });
  });

  it("test_grab_offset_negative", () => {
    // 窗口原点在光标右下方（抓猫的透明边角）→ 负偏移
    expect(grabOffset({ x: 500, y: 400 }, { x: 620, y: 500 })).toEqual({
      x: -120,
      y: -100,
    });
  });

  it("test_grab_offset_physical_passthrough", () => {
    // 物理坐标直传不改值：2x 屏上的物理数不值得任何换算，原样做差
    const cursor = { x: 2600, y: 1500 };
    const origin = { x: 2000, y: 1000 };
    expect(grabOffset(cursor, origin)).toEqual({ x: 600, y: 500 });
    expect(grabOffset({ x: 0, y: 0 }, { x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
  });
});

describe("clampDrag", () => {
  it("test_clamp_drag_inside_untouched", () => {
    expect(clampDrag({ x: 500, y: 400 }, WIN_W, WIN_H, BOUNDS)).toEqual({
      x: 500,
      y: 400,
    });
  });

  it("test_clamp_drag_top_to_visible_frame_top", () => {
    // 顶部越界 → 钳到 visibleFrame 顶（菜单栏下缘），x 不动
    expect(clampDrag({ x: 500, y: 0 }, WIN_W, WIN_H, BOUNDS)).toEqual({
      x: 500,
      y: 24,
    });
    // 贴住菜单栏下缘的合法位置原样保留
    expect(clampDrag({ x: 500, y: 24 }, WIN_W, WIN_H, BOUNDS)).toEqual({
      x: 500,
      y: 24,
    });
  });

  it("test_clamp_drag_left_to_48px_visible", () => {
    // 探出 200px 时交集仍有 88px（≥48）→ 合法，原样保留
    expect(clampDrag({ x: -200, y: 400 }, WIN_W, WIN_H, BOUNDS).x).toBe(-200);
    // 探出到交集 <48px 才钳：窗右缘只留 48px 在屏内
    const { x } = clampDrag({ x: -300, y: 400 }, WIN_W, WIN_H, BOUNDS);
    expect(x).toBe(48 - WIN_W); // -240
    // 交集宽验证：min(x+W, 界右) − max(x, 界左) = 48 − 0 = 48
    expect(Math.min(x + WIN_W, BOUNDS.x + BOUNDS.width) - Math.max(x, BOUNDS.x)).toBe(48);
  });

  it("test_clamp_drag_right_to_48px_visible", () => {
    const { x } = clampDrag({ x: 1900, y: 400 }, WIN_W, WIN_H, BOUNDS);
    expect(x).toBe(1920 - 48); // 1872：窗左缘距右界 48px
    expect(Math.min(x + WIN_W, BOUNDS.x + BOUNDS.width) - Math.max(x, BOUNDS.x)).toBe(48);
  });

  it("test_clamp_drag_bottom_to_48px_visible", () => {
    const { y } = clampDrag({ x: 500, y: 1200 }, WIN_W, WIN_H, BOUNDS);
    expect(y).toBe(24 + 1056 - 48); // 1032
    expect(Math.min(y + WIN_H, BOUNDS.y + BOUNDS.height) - Math.max(y, BOUNDS.y)).toBe(48);
  });

  it("test_clamp_drag_custom_margin", () => {
    const { x } = clampDrag({ x: 1900, y: 400 }, WIN_W, WIN_H, BOUNDS, 100);
    expect(x).toBe(1920 - 100);
  });

  it("test_clamp_drag_window_larger_than_display_no_negative", () => {
    // 4K 窗扔进 1080p 屏：钳制区间仍有效，交集 = 整屏（≥margin），无负值
    const r = clampDrag({ x: 0, y: 0 }, 3840, 2160, { x: 0, y: 0, width: 1920, height: 1080 });
    const iw = Math.min(r.x + 3840, 1920) - Math.max(r.x, 0);
    const ih = Math.min(r.y + 2160, 1080) - Math.max(r.y, 0);
    expect(iw).toBeGreaterThanOrEqual(48);
    expect(ih).toBeGreaterThanOrEqual(48);
    expect(Number.isFinite(r.x)).toBe(true);
    expect(Number.isFinite(r.y)).toBe(true);
  });

  it("test_clamp_drag_degenerate_bounds_margin_fallback", () => {
    // 退化：可见区比 margin 还小（80×80），窗口 10×10 → margin 自动收缩，
    // 交集非负且为屏内最大可行值，不出现倒挂/NaN
    const tiny: MonitorBounds = { x: 0, y: 0, width: 80, height: 80 };
    const r = clampDrag({ x: 35, y: 200 }, 10, 10, tiny, 48);
    expect(Number.isFinite(r.x)).toBe(true);
    expect(Number.isFinite(r.y)).toBe(true);
    const iw = Math.min(r.x + 10, 80) - Math.max(r.x, 0);
    const ih = Math.min(r.y + 10, 80) - Math.max(r.y, 0);
    expect(iw).toBeGreaterThanOrEqual(0);
    expect(ih).toBeGreaterThanOrEqual(0);
    expect(ih).toBe(10); // y 收回屏内：交集 = 窗高本身
    expect(r.y).toBe(70); // 底钳：70+10=80 贴住可见区底缘
  });
});
