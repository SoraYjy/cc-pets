// Markdown → sanitized HTML for assistant-authored content only (v1.1
// acceptance round 6). innerHTML is ONLY ever fed this function's output:
// DOMPurify's default allow-list keeps the standard formatting tags
// (headings/lists/tables/code/links…) and strips scripts, event handlers
// and javascript: URLs. User messages and all other dynamic text stay
// textContent-only — the XSS surface does not grow.
import DOMPurify from "dompurify";
import { marked } from "marked";

export function renderMarkdown(text: string): string {
  // marked v18: parse is synchronous unless `async: true` — pin `async: false`
  // so the string overload is selected and no Promise can slip into
  // innerHTML. GFM gives tables/strikethrough/task lists; breaks renders
  // single newlines as <br> (chat-style line flow).
  const html = marked.parse(text, { gfm: true, breaks: true, async: false });
  return DOMPurify.sanitize(html);
}
