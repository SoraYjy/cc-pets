import { describe, expect, it } from "vitest";

import { frameAt, offsetFor, type AnimationDef } from "./sprite";

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
