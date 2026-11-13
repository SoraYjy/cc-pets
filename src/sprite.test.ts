import { describe, expect, it } from "vitest";

import {
  frameAt,
  offsetFor,
  resolveSheetPath,
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
