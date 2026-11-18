import { describe, expect, it } from "vitest";

import { clampDrag, grabOffset, roundPhysical, splitVerticalTarget, type MonitorBounds } from "./drag";

// 测试基准：猫窗 288×312（物理 px），显示器可见区 = 1920×1056 @ (0,24)
// （顶部 24px 为菜单栏，即 visibleFrame 顶在 y=24）。
const WIN_W = 288;
const WIN_H = 312;
const BOUNDS: MonitorBounds = { x: 0, y: 24, width: 1920, height: 1056 };

describe("roundPhysical", () => {
  // 「完全拖不动」实修钉：macOS 光标物理坐标带小数（缩放分辨率非整数
  // scaleFactor），set_position 的 i32 参数拒收浮点——IPC 边界必须取整。
  it("rounds fractional physical coordinates", () => {
    expect(roundPhysical({ x: 1603.140625, y: 522.2109375 })).toEqual({
      x: 1603,
      y: 522,
    });
    expect(roundPhysical({ x: 2413.1953125, y: 2095.2421875 })).toEqual({
      x: 2413,
      y: 2095,
    });
  });

  it("uses JS Math.round half-up semantics and keeps integers", () => {
    expect(roundPhysical({ x: 100.5, y: -100.5 })).toEqual({ x: 101, y: -100 });
    expect(roundPhysical({ x: 42, y: 0 })).toEqual({ x: 42, y: 0 });
  });
});

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

describe("splitVerticalTarget", () => {
  // 「贴不到顶」终修钉：tao set_position 落在 setFrameTopLeftPoint，AppKit
  // constrainFrameRect 把负 y 无声拍回屏幕顶——窗口只能 ≥0，剩余向上位移
  // 由精灵窗内上滑（shift ≤ 0）承担。基准：sf=2、K=173.45（zoom 0.85 实测）、
  // 猫头线 33 逻辑（workArea.y=66 物理）。
  const SF = 2;
  const K = 173.45;
  const LINE = 33;

  it("keeps 1:1 cursor tracking while the window is fully on-screen", () => {
    const { winY, shift } = splitVerticalTarget(500, SF, K, LINE);
    expect(winY).toBe(500);
    expect(shift).toBe(0);
    // head = winY/sf + K + shift = 250 + 173.45
  });

  it("takes over with a sprite shift once the window top pins at the screen top", () => {
    // 语义：head = max(rawY/sf + K, LINE)；winY = max(rawY, 0)；
    // shift = min(0, head − K)（head 严格 1:1 跟光标，贴线即停）。
    // rawY=-140 物理（=-70 逻辑）：desired head=103.45>33 未贴线，
    // 窗口钉 0，shift=-70.45 → head=0+K-70.45=103.45=desired ✓
    const near = splitVerticalTarget(-140, SF, K, LINE);
    expect(near.winY).toBe(0);
    expect(near.shift).toBeCloseTo(103.45 - K, 2);
    // 猛推到头：desired<线 → 钳在线上，shift=LINE-K=-140.45
    const pinned = splitVerticalTarget(-1000, SF, K, LINE);
    expect(pinned.winY).toBe(0);
    expect(pinned.shift).toBeCloseTo(LINE - K, 2);
    // 连续性：rawY 恰在贴线临界 ((LINE-K)×sf) → shift=LINE-K
    const edge = splitVerticalTarget((LINE - K) * SF, SF, K, LINE);
    expect(edge.shift).toBeCloseTo(LINE - K, 2);
  });

  it("returns shift to zero smoothly when dragging back down", () => {
    // 从贴线处下拖：desired 回升 → shift 向 0 收敛、winY 仍 0（rawY<0）；
    // rawY=-60 → desired=143.45>33 → shift=143.45-K=-30，head 连续
    const back = splitVerticalTarget(-60, SF, K, LINE);
    expect(back.winY).toBe(0);
    expect(back.shift).toBeCloseTo(-30, 2);
    // rawY 过 0 → shift=0、窗口接管，head 连续（K 在两侧一致）
    const over = splitVerticalTarget(10, SF, K, LINE);
    expect(over.winY).toBe(10);
    expect(over.shift).toBe(0);
    const atZero = splitVerticalTarget(0, SF, K, LINE);
    expect(atZero.winY).toBe(0);
    expect(atZero.shift).toBe(0);
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
    // 轻微越顶不钳：y 向交集 = winH − (bounds.y − y) = 312 − 24 = 288 ≥ 48
    expect(clampDrag({ x: 500, y: 0 }, WIN_W, WIN_H, BOUNDS)).toEqual({
      x: 500,
      y: 0,
    });
    // 悬挂越顶 → 钳到只剩 48px 可见：y = bounds.y + 48 − winH = −240（x 不动）
    expect(clampDrag({ x: 500, y: -1000 }, WIN_W, WIN_H, BOUNDS)).toEqual({
      x: 500,
      y: -240,
    });
    // 交集验证：窗底缘 − 可见区顶 = (−240+312) − 24 = 48
    const { y } = clampDrag({ x: 500, y: -1000 }, WIN_W, WIN_H, BOUNDS);
    expect(Math.min(y + WIN_H, BOUNDS.y + BOUNDS.height) - Math.max(y, BOUNDS.y)).toBe(48);
  });

  it("test_clamp_drag_head_aware_ymin_pins_cat_head_at_visible_top", () => {
    // 「卡住/猫没了」实修钉：猫锚窗底，「窗口留 margin」口径会把猫身几乎整只
    // 滑进菜单栏（实测仅剩 ~9px 脚尖）。yMin = 可见区顶 − 猫头窗口内偏移时，
    // 顶界以猫头为准：猫头贴线即停，永不越线。
    // 基准：winH=312 逻辑，猫头偏移 159 逻辑（zoom 1.0：104 + 208×0.5 的一半
    // 处取整口径不影响断言，直接用调用侧换算后的物理值 318、可见区顶 66）。
    const yMin = 66 - 318; // -252 物理px：窗 y=-252 时猫头恰在可见区顶
    expect(clampDrag({ x: 500, y: -1000 }, WIN_W, WIN_H, BOUNDS, 48, yMin)).toEqual({
      x: 500,
      y: -252,
    });
    // 窗位高于猫头线 → 钳回；低于 → 不钳（正常屏内拖拽零影响）
    expect(clampDrag({ x: 500, y: -300 }, WIN_W, WIN_H, BOUNDS, 48, yMin).y).toBe(-252);
    expect(clampDrag({ x: 500, y: -100 }, WIN_W, WIN_H, BOUNDS, 48, yMin).y).toBe(-100);
  });

  it("test_clamp_drag_ymin_leaves_x_and_bottom_intact", () => {
    // yMin 只接管顶界：左右/底部 48px 口径不受影响
    const r = clampDrag({ x: 1900, y: -1000 }, WIN_W, WIN_H, BOUNDS, 48, -252);
    expect(r.x).toBe(1872); // 右侧仍钳 48px
    expect(r.y).toBe(-252); // 顶部用 yMin
    const b = clampDrag({ x: 500, y: 1200 }, WIN_W, WIN_H, BOUNDS, 48, -252);
    expect(b.y).toBe(1032); // 底部仍钳 48px
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

describe("drag round trip", () => {
  it("test_round_trip_grab_point_screen_stationary", () => {
    // 组合往返（刚性拖拽不变量）：origin_new = cursor_new − (cursor₀ − origin₀)
    // 路径上抓取点相对屏幕不动。评审例：cursor0=(488,512), origin0=(200,200)
    // → grabOffset=(288,312)；cursor_new=(448,462) → origin_new=(160,150)。
    const cursor0 = { x: 488, y: 512 };
    const origin0 = { x: 200, y: 200 };
    const offset = grabOffset(cursor0, origin0);
    expect(offset).toEqual({ x: 288, y: 312 });

    const cursorNew = { x: 448, y: 462 };
    const rawNew = { x: cursorNew.x - offset.x, y: cursorNew.y - offset.y };
    const originNew = clampDrag(rawNew, WIN_W, WIN_H, BOUNDS);
    expect(originNew).toEqual({ x: 160, y: 150 }); // 屏内，钳制不干预

    // 抓取点在两次快照中同为屏幕上同一点：cursor − origin 恒等
    expect(cursorNew.x - originNew.x).toBe(cursor0.x - origin0.x);
    expect(cursorNew.y - originNew.y).toBe(cursor0.y - origin0.y);
  });

  it("test_round_trip_with_clamp_keeps_window_bounded", () => {
    // 光标甩出屏外时，钳制接管但窗位仍沿同一刚性映射方向（贴边界不翻转）
    const offset = grabOffset({ x: 488, y: 512 }, { x: 200, y: 200 });
    const raw = { x: 2600 - offset.x, y: 462 - offset.y }; // 光标远在右界外
    const clamped = clampDrag(raw, WIN_W, WIN_H, BOUNDS);
    expect(clamped.x).toBe(1920 - 48); // 右钳：窗左缘距右界 48px
    expect(clamped.y).toBe(raw.y); // y 方向屏内不动
  });
});
