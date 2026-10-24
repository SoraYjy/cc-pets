import { describe, expect, it } from "vitest";

import { decideDoneFallback, pushCapped } from "./history";

describe("pushCapped", () => {
  it("test_push_capped_trims_oldest", () => {
    const arr: string[] = [];
    pushCapped(arr, "a", 3);
    pushCapped(arr, "b", 3);
    pushCapped(arr, "c", 3);
    const ret = pushCapped(arr, "d", 3);
    expect(arr).toEqual(["b", "c", "d"]);
    // 契约：返回同一数组引用（原地 push+shift）
    expect(ret).toBe(arr);
  });

  it("test_push_capped_under_cap_keeps_all", () => {
    const arr: string[] = [];
    pushCapped(arr, "x", 5);
    pushCapped(arr, "y", 5);
    expect(arr).toEqual(["x", "y"]);
  });
});

describe("decideDoneFallback", () => {
  it("test_done_fallback_decision", () => {
    expect(decideDoneFallback("文本", false)).toBe("bubble");
    expect(decideDoneFallback("", false)).toBe("separator-only");
    expect(decideDoneFallback("文本", true)).toBe("separator-only");
  });
});
