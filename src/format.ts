// Pure formatting helpers shared by the pet window (main.ts) and the chat
// bubble window (chat.ts) — extracted verbatim from both (test-infra L1:
// golden-table regression net). No DOM / theme / event dependencies, so the
// whole module is trivially unit-testable.

// Same formatting rules in both windows (used to be duplicated: separate
// bundles, tiny code): duration as "42s" / "3m12s", "" when unknown.
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

// `✓ 任务完成 · project（dur）：summary` — the context segment drops out
// gracefully when project/durationMs are missing (acceptance round 4).
export function formatSummaryLine(
  project: string | undefined,
  durationMs: number | null | undefined,
  summary: string,
): string {
  const dur = formatDuration(durationMs);
  const ctx = `${project ?? ""}${dur ? `（${dur}）` : ""}`;
  return `✓ 任务完成${ctx ? ` · ${ctx}` : ""}：${summary}`;
}

// The single head/body divider for ✓ 任务完成 lines: split once at the first
// full-width colon. Both the live path and the history re-render go through
// this, so the block head is always title-only and identical across reopen
// (review round 2: the live path used to pass the whole line — summary and
// all — as the head, duplicating it and bypassing the 200px body cap).
export function splitSummaryLine(text: string): { head: string; body: string } {
  const sep = text.indexOf("：");
  return sep >= 0
    ? { head: text.slice(0, sep), body: text.slice(sep + 1) }
    : { head: text, body: "" };
}

// Session-context formatting (acceptance round 4): project = cwd basename.
export function projectOf(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;
}

// The system notification stays short (OS notification center): cap at 200
// chars. The bubble/summary renders the full (watcher-capped 4000) summary
// — acceptance round 6 lifted the old global 200 truncation.
const NOTIFICATION_SUMMARY_MAX = 200;

export function truncateForNotification(text: string): string {
  return text.length > NOTIFICATION_SUMMARY_MAX
    ? `${text.slice(0, NOTIFICATION_SUMMARY_MAX)}…`
    : text;
}
