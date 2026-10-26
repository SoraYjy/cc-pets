// Test-infra L1: golden tables for the extracted pure formatting helpers
// (src/format.ts). Each bug class fixed across acceptance rounds 1-7 keeps a
// regression pin here; new cases append to the table, never bypass it.
import { describe, expect, it } from "vitest";

import {
  formatDuration,
  formatSummaryLine,
  projectOf,
  splitSummaryLine,
  truncateForNotification,
} from "./format";

describe("splitSummaryLine (golden)", () => {
  // head/body split at the FIRST full-width colon only; later colons stay in
  // the body (round 6/7 summaries contain full-width punctuation of their own).
  const cases: Array<{
    name: string;
    text: string;
    head: string;
    body: string;
  }> = [
    {
      name: "summary_contains_fullwidth_colon_body_keeps_later_colons",
      text: "✓ 任务完成 · widget（42s）：重构完成：包括子模块",
      head: "✓ 任务完成 · widget（42s）",
      body: "重构完成：包括子模块",
    },
    {
      name: "ctx_contains_fullwidth_colon_head_truncated_content_not_lost",
      // A project name itself carrying a full-width colon: the head cuts at
      // the first colon, the rest survives in the body — nothing is dropped.
      text: "✓ 任务完成 · my：proj：内容",
      head: "✓ 任务完成 · my",
      body: "proj：内容",
    },
    {
      name: "no_colon_head_is_full_text_body_empty",
      text: "✓ 任务完成 · widget（42s）",
      head: "✓ 任务完成 · widget（42s）",
      body: "",
    },
    {
      name: "empty_string",
      text: "",
      head: "",
      body: "",
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(splitSummaryLine(c.text)).toEqual({ head: c.head, body: c.body });
    });
  }
});

describe("formatDuration (golden)", () => {
  // NaN: documented implementation semantics — NaN survives every arithmetic
  // branch and falls through to the template ("NaNmNaNs"). durationMs comes
  // from the watcher as u64|null so this never fires in production; pinned
  // as golden so a future guard change is a conscious decision, not an
  // accident. (Task brief expected ""; implementation says "NaNmNaNs" —
  // extraction is verbatim, logic change out of scope.)
  const cases: Array<{
    name: string;
    ms: number | null | undefined;
    want: string;
  }> = [
    { name: "null_empty", ms: null, want: "" },
    { name: "undefined_empty", ms: undefined, want: "" },
    { name: "zero_is_0s", ms: 0, want: "0s" },
    { name: "under_a_minute", ms: 42000, want: "42s" },
    { name: "rounded_to_next_second", ms: 42500, want: "43s" },
    { name: "exactly_one_minute", ms: 60000, want: "1m0s" },
    { name: "59999ms_rounds_to_1m0s", ms: 59999, want: "1m0s" },
    { name: "mixed_minutes_seconds", ms: 192000, want: "3m12s" },
    { name: "nan_falls_through_to_template", ms: NaN, want: "NaNmNaNs" },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(formatDuration(c.ms)).toBe(c.want);
    });
  }
});

describe("formatSummaryLine (golden)", () => {
  const cases: Array<{
    name: string;
    project: string | undefined;
    durationMs: number | null | undefined;
    summary: string;
    want: string;
  }> = [
    {
      name: "full_ctx",
      project: "widget",
      durationMs: 42000,
      summary: "摘要",
      want: "✓ 任务完成 · widget（42s）：摘要",
    },
    {
      name: "no_project_no_duration",
      project: undefined,
      durationMs: null,
      summary: "摘要",
      want: "✓ 任务完成：摘要",
    },
    {
      name: "project_only",
      project: "widget",
      durationMs: undefined,
      summary: "摘要",
      want: "✓ 任务完成 · widget：摘要",
    },
    {
      // Implementation semantics: ctx is `${project ?? ""}（dur）` — a
      // duration without a project keeps the bare parentheses. Pinned as-is
      // (extraction is verbatim; cosmetic change is out of scope).
      name: "duration_only",
      project: undefined,
      durationMs: 192000,
      summary: "摘要",
      want: "✓ 任务完成 · （3m12s）：摘要",
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(formatSummaryLine(c.project, c.durationMs, c.summary)).toBe(c.want);
    });
  }
});

describe("projectOf (golden)", () => {
  const cases: Array<{ name: string; cwd: string; want: string }> = [
    {
      name: "unix_path_basename",
      cwd: "/Users/sora/WorkSpace/Sora/widget",
      want: "widget",
    },
    {
      name: "windows_path_basename",
      cwd: "C:\\Users\\x\\proj",
      want: "proj",
    },
    {
      name: "trailing_slash_dropped",
      cwd: "/Users/sora/widget/",
      want: "widget",
    },
    {
      name: "trailing_backslash_dropped",
      cwd: "C:\\Users\\x\\proj\\",
      want: "proj",
    },
    { name: "empty_string_empty", cwd: "", want: "" },
    {
      // Implementation semantics: every segment of "/" is empty, so the
      // fallback `?? cwd` returns the input itself. Pinned as-is.
      name: "root_only_returns_input",
      cwd: "/",
      want: "/",
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(projectOf(c.cwd)).toBe(c.want);
    });
  }
});

describe("truncateForNotification (golden)", () => {
  const cases: Array<{ name: string; text: string; want: string }> = [
    {
      name: "over_200_chars_truncated_with_ellipsis",
      text: "字".repeat(201),
      want: "字".repeat(200) + "…",
    },
    {
      name: "exactly_200_chars_untouched",
      text: "字".repeat(200),
      want: "字".repeat(200),
    },
    { name: "short_text_verbatim", text: "搞定", want: "搞定" },
    { name: "empty_string_verbatim", text: "", want: "" },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(truncateForNotification(c.text)).toBe(c.want);
    });
  }
});
