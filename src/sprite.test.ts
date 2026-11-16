import { describe, expect, it } from "vitest";

import {
  decideCursorIgnore,
  frameAt,
  offsetFor,
  resolveSheetPath,
  shouldWriteFrame,
  type AnimationDef,
  type SkinDef,
} from "./sprite";

const idle: AnimationDef = { name: "idle", row: 0, frames: 4, fps: 3, loop: true };
const done: AnimationDef = { name: "done", row: 2, frames: 4, fps: 4, loop: false };

describe("frameAt", () => {
  it("returns frame 0 at elapsed 0", () => {
    expect(frameAt(idle, 0)).toBe(0);
  });

  it("advances to frame 1 after one frame duration", () => {
    expect(frameAt(idle, 334)).toBe(1);
  });

  it("wraps around for looping animations", () => {
    expect(frameAt(idle, 1400)).toBe(0);
  });

  it("clamps at the last frame for non-looping animations", () => {
    expect(frameAt(done, 2000)).toBe(3);
  });
});

describe("shouldWriteFrame", () => {
  it("always writes when nothing was written yet (prev null)", () => {
    // 新 playAnimation 链的起点：首帧必写，样式才与动画对齐。
    expect(shouldWriteFrame(null, { row: 0, col: 0 })).toBe(true);
    expect(shouldWriteFrame(null, { row: 3, col: 2 })).toBe(true);
  });

  it("skips the write when row and col are unchanged", () => {
    const frame = { row: 0, col: 1 };
    expect(shouldWriteFrame(frame, { row: 0, col: 1 })).toBe(false);
  });

  it("writes when the column changes within the same row", () => {
    expect(shouldWriteFrame({ row: 0, col: 1 }, { row: 0, col: 2 })).toBe(true);
  });

  it("writes when the row changes even at the same column", () => {
    // idle(0) → working(1) 切行：背景必须重写，不能只看列。
    expect(shouldWriteFrame({ row: 0, col: 1 }, { row: 1, col: 1 })).toBe(true);
  });
});

describe("decideCursorIgnore", () => {
  // 验收修复「可点击区域大于形象」：busy 恒 false 是手势安全钉——按下/
  // 拖拽中途翻穿透会吃掉 mouseup / 丢窗口。
  it("pins non-ignore while a pointer gesture is busy, regardless of alpha", () => {
    expect(decideCursorIgnore(0, true, 16)).toBe(false);
    expect(decideCursorIgnore(255, true, 16)).toBe(false);
  });

  it("ignores the mouse below the alpha threshold", () => {
    expect(decideCursorIgnore(0, false, 16)).toBe(true);
    expect(decideCursorIgnore(15, false, 16)).toBe(true);
  });

  it("keeps the clickable cat at or above the threshold", () => {
    expect(decideCursorIgnore(16, false, 16)).toBe(false);
    expect(decideCursorIgnore(255, false, 16)).toBe(false);
  });
});

describe("offsetFor", () => {
  it("computes background-position for (row 0, col 1)", () => {
    expect(offsetFor(0, 1)).toBe("-192px 0px");
  });

  it("computes background-position for (row 2, col 3)", () => {
    expect(offsetFor(2, 3)).toBe("-576px -416px");
  });
});

describe("resolveSheetPath", () => {
  const skins: Record<string, SkinDef> = {
    default: { spritesheetPath: "spritesheet.png", displayName: "像素猫" },
    official: {
      spritesheetPath: "skins/official/spritesheet.png",
      displayName: "official",
    },
  };

  it("picks the requested skin's spritesheetPath", () => {
    expect(resolveSheetPath(skins, "spritesheet.png", "official")).toBe(
      "skins/official/spritesheet.png",
    );
  });

  it("falls back to the default skin for an unknown id", () => {
    expect(resolveSheetPath(skins, "spritesheet.png", "ghost")).toBe(
      "spritesheet.png",
    );
    // skins 集里连 default 都没有 → 只能退根路径。
    expect(resolveSheetPath({ official: skins.official }, "root.png", "ghost")).toBe(
      "root.png",
    );
  });

  it("falls back to the default skin for an empty id", () => {
    expect(resolveSheetPath(skins, "spritesheet.png", "")).toBe(
      "spritesheet.png",
    );
    expect(resolveSheetPath(skins, "spritesheet.png", undefined)).toBe(
      "spritesheet.png",
    );
  });

  it("falls back to the root path when there is no skins map at all", () => {
    expect(resolveSheetPath(undefined, "root.png", "official")).toBe("root.png");
    expect(resolveSheetPath({}, "root.png", undefined)).toBe("root.png");
    // 连根路径都缺（损坏的 pet.json）→ 稳定的兜底文件名。
    expect(resolveSheetPath(undefined, undefined, undefined)).toBe(
      "spritesheet.png",
    );
  });
});
