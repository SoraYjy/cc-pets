// @vitest-environment jsdom
// Test-infra L2: golden rendering + XSS attack samples for renderMarkdown
// (src/markdown.ts, marked + DOMPurify). The XSS line is load-bearing: chat
// windows feed innerHTML exclusively with this function's output, so any
// sanitizer regression surfaces here first.
//
// jsdom note: DOMPurify auto-detects the global `window` at import time, and
// under the per-file jsdom directive one exists before the import graph runs
// — no manual window injection needed (verified: sanitize() strips below).
import { describe, expect, it } from "vitest";

import { renderMarkdown } from "./markdown";

describe("renderMarkdown — golden rendering", () => {
  // Each case: markdown in → the output HTML must contain the key structure
  // (contains-assertions keep the golden resilient to marked's whitespace
  // choices while still pinning the load-bearing element).
  const cases: Array<{ name: string; md: string; expectHtml: RegExp }> = [
    {
      name: "gfm_table_renders_table",
      md: "| a | b |\n| --- | --- |\n| 1 | 2 |\n",
      expectHtml: /<table>[\s\S]*<th>a<\/th>[\s\S]*<td>1<\/td>/,
    },
    {
      name: "fenced_code_renders_pre_code",
      md: "```ts\nconst x = 1;\n```",
      expectHtml: /<pre><code[^>]*>const x = 1;/,
    },
    {
      name: "bold_renders_strong",
      md: "这是**粗体**文本",
      expectHtml: /<strong>粗体<\/strong>/,
    },
    {
      name: "list_renders_ul_li",
      md: "- 第一项\n- 第二项\n",
      expectHtml: /<ul>\s*<li>第一项<\/li>\s*<li>第二项<\/li>\s*<\/ul>/,
    },
    {
      name: "heading_renders_h1",
      md: "# 标题",
      expectHtml: /<h1>标题<\/h1>/,
    },
    {
      name: "plain_text_passes_through",
      md: "普通一行文字",
      expectHtml: /普通一行文字/,
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const html = renderMarkdown(c.md);
      expect(html).toMatch(c.expectHtml);
    });
  }
});

describe("renderMarkdown — XSS samples stripped", () => {
  // Three canonical attack classes the v1.1 XSS ruling covers: script tags,
  // event-handler attributes, javascript: URLs.
  const attacks: Array<{ name: string; md: string; forbidden: RegExp }> = [
    {
      name: "script_tag_stripped",
      md: "<script>alert(1)</script>",
      forbidden: /<script/i,
    },
    {
      name: "onerror_attribute_stripped",
      md: '<img src=x onerror="alert(1)">',
      forbidden: /onerror/i,
    },
    {
      name: "javascript_href_stripped",
      md: "[x](javascript:alert(1))",
      forbidden: /javascript:/i,
    },
  ];

  for (const a of attacks) {
    it(a.name, () => {
      const html = renderMarkdown(a.md);
      expect(html).not.toMatch(a.forbidden);
    });
  }

  it("mixed_attack_inside_markdown_still_stripped", () => {
    const html = renderMarkdown(
      "正常开头\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1))\n",
    );
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/onerror/i);
    expect(html).not.toMatch(/javascript:/i);
    expect(html).toMatch(/正常开头/); // benign content survives
  });
});
