// In-memory chat history (v1.1 "A 档"): the pet window owns the log for the
// app's lifetime. Closing the bubble window does not clear it; quitting the
// app does (no persistence). Pure module — no Tauri imports — so it is
// unit-testable under vitest.

export interface ChatEntry {
  role: "user" | "assistant" | "system";
  text: string;
  ts: string;
}

// Appends `item`, then trims from the head while over `cap`, and returns the
// SAME array reference so callers can keep pushing into one array.
export function pushCapped<T>(arr: T[], item: T, cap: number): T[] {
  arr.push(item);
  while (arr.length > cap) {
    arr.shift();
  }
  return arr;
}

// Done-fallback decision (v1.1): a done event with text but no open assistant
// bubble (e.g. a pure tool turn that streamed nothing) materializes the text
// as an assistant bubble; everything else is separator-only.
export function decideDoneFallback(
  doneText: string,
  hasOpenBubble: boolean,
): "bubble" | "separator-only" {
  return doneText !== "" && !hasOpenBubble ? "bubble" : "separator-only";
}
