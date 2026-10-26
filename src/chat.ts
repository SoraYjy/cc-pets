import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { decideDoneFallback, type ChatEntry } from "./history";
import { renderMarkdown } from "./markdown";
import { clampOpacity, normalizeStyle, type ThemeStyle } from "./theme";

// Backend chat.rs emits { kind: "init" | "text" | "done", text }.
interface ChatEventPayload {
  kind: "init" | "text" | "done";
  text: string;
}

// The pet window rebroadcasts watcher turn-complete summaries as
// "turn-summary" { sessionId, summary } so finished (external) Claude
// sessions show up here too (DESIGN §5.3). project/durationMs are additive
// context fields (acceptance round 4); older senders may omit them.
interface TurnSummaryPayload {
  sessionId: string;
  summary: string;
  project?: string;
  durationMs?: number | null;
}

const messagesEl = document.getElementById("messages") as HTMLElement;
const inputEl = document.getElementById("input") as HTMLTextAreaElement;
const sendBtn = document.getElementById("send") as HTMLButtonElement;
const closeBtn = document.getElementById("close") as HTMLButtonElement;
const titlebarEl = document.getElementById("titlebar") as HTMLElement;
const settingsToggle = document.getElementById("settings-toggle") as HTMLButtonElement;
const settingsPanel = document.getElementById("settings-panel") as HTMLElement;
const alphaRange = document.getElementById("alpha") as HTMLInputElement;
const alphaValue = document.getElementById("alpha-value") as HTMLElement;
const styleChips = Array.from(document.querySelectorAll<HTMLButtonElement>(".chip"));

let sending = false;
let streamingBubble: HTMLElement | null = null;
let streamingText: Text | null = null; // the growing text node inside it
let toastTimer: number | null = null;

function scrollBottom(): void {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// Persistent "connected" line removed (v1.1 acceptance round 3): session
// state has no UI in the bubble; init events are simply ignored (see the
// chat-event listener).

// Light-dismiss (acceptance round 5, fix round 2): clicking anywhere outside
// the bubble (desktop, other apps, the cat) blurs this window — losing focus
// counts as a close request and goes through the same path as ×/Esc (claude
// process keeps running). The guard is armed from the ACTUAL focus state at
// load: the creation-time focused=true event fires before this page's
// listeners exist, so waiting for a focus change that never came left the
// guard permanently disarmed and light-dismiss dead. Either path arms it.
let hasBeenFocused = false;
void getCurrentWindow()
  .isFocused()
  .then((focused) => {
    if (focused) hasBeenFocused = true;
  })
  .catch(() => {}); // probe failure → rely on the event path only
void getCurrentWindow().onFocusChanged(({ payload: focused }) => {
  if (focused) {
    hasBeenFocused = true;
    return;
  }
  // Both branches leave one breadcrumb so a "not closing" report is readable
  // straight from debug.log.
  logLine(
    `[chat] blur fired, hasBeenFocused=${hasBeenFocused}${hasBeenFocused ? " → close" : " → ignored"}`,
  );
  if (hasBeenFocused) {
    closeChat();
  }
});

// ===== Summary block rendering (acceptance round 5, md since round 6) =====
//
// Task-complete notices render as a block: a title line (✓ 任务完成 · …)
// plus a scroll-capped content area. The body is real markdown rendered by
// renderMarkdown (marked + DOMPurify — innerHTML is fed sanitized output
// only), so full tables/code blocks/lists survive the trip.

// Same formatting rules as main.ts (duplicated: separate bundles, tiny code):
// duration as "42s" / "3m12s", "" when unknown.
function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

// `✓ 任务完成 · project（dur）：summary` — the context segment drops out
// gracefully when project/durationMs are missing (acceptance round 4).
function formatSummaryLine(
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
function splitSummaryLine(text: string): { head: string; body: string } {
  const sep = text.indexOf("：");
  return sep >= 0
    ? { head: text.slice(0, sep), body: text.slice(sep + 1) }
    : { head: text, body: "" };
}

// Swap a bubble's plain text node for rendered markdown — assistant messages
// only, and only at completion/history time (streaming stays plain text so
// partial markdown can't flicker). innerHTML here is exclusively fed
// renderMarkdown output (DOMPurify-sanitized; the XSS line holds).
function renderBubbleMarkdown(bubble: HTMLElement, textNode: Text): void {
  const body = document.createElement("div");
  body.className = "md-body";
  body.innerHTML = renderMarkdown(textNode.data);
  bubble.insertBefore(body, bubble.querySelector(".bubble-ts"));
  textNode.remove();
}

// Block factory shared by the live turn-summary listener and the history
// re-render, so reopen produces the exact same segmented layout.
function buildSummaryBlock(head: string, summary: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "sysline summary summary-block";
  const headEl = document.createElement("div");
  headEl.className = "summary-head";
  headEl.textContent = head;
  el.appendChild(headEl);
  const body = document.createElement("div");
  body.className = "summary-body";
  // Acceptance round 6: the body renders real markdown (DOMPurify-sanitized)
  // inside the scroll-capped wrapper.
  const md = document.createElement("div");
  md.className = "md-body";
  md.innerHTML = renderMarkdown(summary);
  body.appendChild(md);
  el.appendChild(body);
  return el;
}

// Shared bubble factory (extracted so the history re-render and the done
// fallback reuse the exact same user/assistant markup). The message text is
// a leading text node followed by a right-aligned timestamp span — created
// via createTextNode/textContent only, so the XSS surface is unchanged.
// `ts` defaults to now; the history re-render passes the recorded entry.ts.
function makeBubble(
  kind: "user" | "assistant",
  text: string,
  ts?: string,
): { el: HTMLElement; textNode: Text } {
  const el = document.createElement("div");
  el.className = `bubble ${kind}`;
  const textNode = document.createTextNode(text);
  el.appendChild(textNode);
  const stamp = document.createElement("span");
  stamp.className = "bubble-ts";
  stamp.textContent = ts ?? new Date().toLocaleTimeString();
  el.appendChild(stamp);
  return { el, textNode };
}

function userBubble(text: string): void {
  messagesEl.appendChild(makeBubble("user", text).el);
  scrollBottom();
}

// Current turn's assistant bubble; created on first streamed text of the
// turn. Returns the growing TEXT NODE so appends never touch the timestamp
// span (textContent += would wipe it — it replaces all children).
function streamingBubbleFor(): Text {
  if (!streamingText) {
    const made = makeBubble("assistant", "");
    streamingBubble = made.el;
    streamingText = made.textNode;
    messagesEl.appendChild(made.el);
  }
  return streamingText;
}

function addDivider(): void {
  const el = document.createElement("div");
  el.className = "divider";
  messagesEl.appendChild(el);
  scrollBottom();
}

// Typing indicator (v1.1 review fix): avatar + three bouncing dots, shown
// between a sent message and the turn's first streamed text / done. DOM lives
// only in this window — the pet window's chatLog never sees it. Visibility is
// CSS-gated to body.theme-a, so switching themes mid-wait hides it correctly.
let typingIndicator: HTMLElement | null = null;

function showTyping(): void {
  if (typingIndicator) return;
  const wrap = document.createElement("div");
  wrap.className = "typing";
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  const dots = document.createElement("div");
  dots.className = "dots";
  for (let i = 0; i < 3; i++) {
    dots.appendChild(document.createElement("i"));
  }
  wrap.append(avatar, dots);
  messagesEl.appendChild(wrap);
  typingIndicator = wrap;
  scrollBottom();
}

function hideTyping(): void {
  typingIndicator?.remove();
  typingIndicator = null;
}

function toast(text: string): void {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    document.body.appendChild(el);
  }
  el.textContent = text;
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    document.getElementById("toast")?.remove();
    toastTimer = null;
  }, 4000);
}

async function send(): Promise<void> {
  const text = inputEl.value.trim();
  if (!text || sending) return;
  sending = true;
  inputEl.disabled = true;
  sendBtn.disabled = true;
  userBubble(text); // local echo before the round-trip
  showTyping(); // theme-a only (CSS-gated); cleared on first text/done
  // v1.1: report the send to the pet window's history log. Fire-and-forget —
  // a bookkeeping failure must not block the actual send (logged as evidence).
  void emit("chat-user-message", { text }).catch((err: unknown) => {
    console.error("chat-user-message emit failed:", err);
    logLine(`[chat] chat-user-message emit failed: ${String(err)}`);
  });
  inputEl.value = "";
  try {
    await invoke("chat_send", { text });
  } catch (err) {
    toast(`发送失败：${String(err)}`);
  } finally {
    sending = false;
    inputEl.disabled = false;
    sendBtn.disabled = false;
    inputEl.focus();
    scrollBottom();
  }
}

// Enter sends; Shift+Enter inserts a newline.
inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void send();
  }
});
sendBtn.addEventListener("click", () => void send());

void listen<ChatEventPayload>("chat-event", (e) => {
  if (e.payload.kind === "init") {
    // Acceptance round 3: no connection line — session state has no bubble UI.
    return;
  }
  if (e.payload.kind === "text") {
    hideTyping(); // first streamed text of the turn replaces the dots
    streamingBubbleFor().appendData(e.payload.text); // text node: no HTML injection
    scrollBottom();
    return;
  }
  // done → close the turn. The result normally already streamed into an open
  // bubble; with no open bubble and a non-empty done text (pure tool turn:
  // nothing streamed), materialize the text as an assistant bubble instead
  // (v1.1 兜底). The divider is inserted on EVERY done now, opened or not.
  hideTyping(); // done also closes the waiting dots (e.g. pure tool turn)
  const fallback = decideDoneFallback(e.payload.text, streamingBubble !== null);
  if (fallback === "bubble") {
    const made = makeBubble("assistant", e.payload.text);
    renderBubbleMarkdown(made.el, made.textNode);
    messagesEl.appendChild(made.el);
    scrollBottom();
  }
  // The assistant message's time is its completion time: refresh the stamp
  // as the turn closes (fallback bubbles are stamped at creation).
  if (streamingBubble !== null) {
    // Acceptance round 6: the turn is complete — swap the plain streaming
    // text for rendered markdown. The plain→typeset reflow at this instant
    // is expected; incremental md mid-stream would flicker on partial input.
    if (streamingText !== null) {
      renderBubbleMarkdown(streamingBubble, streamingText);
    }
    const stamp = streamingBubble.querySelector(".bubble-ts");
    if (stamp) stamp.textContent = new Date().toLocaleTimeString();
  }
  streamingBubble = null;
  streamingText = null;
  addDivider();
});

// ===== History (v1.1) =====

// The pet window owns the log and pushes it when this window is created (plus
// bounded catch-ups — see main.ts emitChatHistory). Rendering is
// clear-then-redraw, so duplicate deliveries are harmless.
interface ChatHistoryPayload {
  entries: ChatEntry[];
}

function renderHistory(entries: ChatEntry[]): void {
  // Clear-then-redraw, strictly idempotent: the same input renders the same
  // DOM regardless of how many catch-up deliveries carry it (acceptance
  // round 1). Never skip the clear — if a turn is mid-stream, capture its
  // partial text, re-render the log, then rebuild the streaming placeholder
  // so the in-flight turn survives (the next "text" fragment appends to it;
  // done finalizes as usual).
  const streamedText = streamingText !== null ? streamingText.data : null;
  messagesEl.textContent = ""; // clears all children
  streamingBubble = null; // its element was just removed from the DOM
  streamingText = null;
  typingIndicator = null; // its element was just removed from the DOM
  for (const entry of entries) {
    if (entry.role === "system") {
      // ✓ 任务完成 entries render as the same block as live summaries
      // (acceptance round 5): stored text is "head：body" — split by the
      // shared divider and run the body through the shared formatter, so a
      // reopen keeps the segmented layout. Other system lines stay plain
      // centered text.
      if (entry.text.startsWith("✓ 任务完成")) {
        const { head, body } = splitSummaryLine(entry.text);
        messagesEl.appendChild(
          buildSummaryBlock(`${head} @ ${entry.ts}`, body),
        );
      } else {
        const el = document.createElement("div");
        el.className = "sysline";
        el.textContent = `${entry.text} @ ${entry.ts}`;
        messagesEl.appendChild(el);
      }
    } else {
      const made = makeBubble(entry.role, entry.text, entry.ts);
      if (entry.role === "assistant") {
        renderBubbleMarkdown(made.el, made.textNode); // reopen renders md too
      }
      messagesEl.appendChild(made.el);
    }
  }
  if (streamedText !== null) {
    const made = makeBubble("assistant", streamedText);
    messagesEl.appendChild(made.el);
    streamingBubble = made.el;
    streamingText = made.textNode;
  }
  scrollBottom();
}

void listen<ChatHistoryPayload>("chat-history", (e) => {
  renderHistory(e.payload.entries);
});

// Turn summaries go to the top of the message area, newest first — they are
// status notices, not part of the conversation flow.
void listen<TurnSummaryPayload>("turn-summary", (e) => {
  const summary = e.payload.summary ? e.payload.summary : "（无文本摘要）";
  const time = new Date().toLocaleTimeString([], { hour12: false });
  // head = title segment only; the summary lives in the (scroll-capped) body.
  const { head, body } = splitSummaryLine(
    formatSummaryLine(e.payload.project, e.payload.durationMs, summary),
  );
  const el = buildSummaryBlock(`[${time}] ${head}`, body);
  messagesEl.insertBefore(el, messagesEl.firstChild);
  messagesEl.scrollTop = 0;
});

// Keepalive (acceptance round 1 design ruling): closing the bubble window no
// longer stops the claude process — it survives across close/reopen, and the
// next open reuses it via spawn_chat's already-running path, so the
// conversation continues. chat_stop now runs only on app exit
// (src-tauri/src/lib.rs ExitRequested hook); nothing to do on close here.

inputEl.focus();

// 全局错误钩子（round 5）：chat 窗没有 debug line，异常只进控制台等于丢——
// 同步落日志留时间线证据。
function logLine(text: string): void {
  void invoke("append_debug", { line: text }).catch(() => {});
}

window.addEventListener("error", (e) => {
  console.error("chat window error:", e.message);
  logLine(`[chat] window error: ${e.message}`);
});
window.addEventListener("unhandledrejection", (e) => {
  console.error("chat unhandled rejection:", e.reason);
  logLine(`[chat] unhandled rejection: ${String(e.reason)}`);
});

// ===== Settings (v1.1): three themes + window opacity =====

// get_settings payload (src-tauri/src/settings.rs Settings { style, opacity }).
interface SettingsPayload {
  style: string;
  opacity: number;
}

let currentStyle: ThemeStyle = "c";
let currentOpacity = 0.92;

// apply = swap the body theme class + write the CSS alpha variable. The window
// background and every theme rule read the class / --win-alpha live, so this
// one function is the whole "make it so" (normalize also guards hand-edited
// settings.json values).
function applySettings(style: string | undefined, opacity: number): void {
  currentStyle = normalizeStyle(style);
  currentOpacity = clampOpacity(opacity);
  document.body.className = `theme-${currentStyle}`;
  document.documentElement.style.setProperty("--win-alpha", String(currentOpacity));
  alphaRange.value = String(currentOpacity);
  alphaValue.textContent = String(currentOpacity);
  for (const chip of styleChips) {
    chip.classList.toggle("active", chip.dataset.style === currentStyle);
  }
}

// Persist current settings; a failed save keeps the applied look and degrades
// silently to one debug-log line.
function saveSettings(): void {
  invoke("save_settings", { style: currentStyle, opacity: currentOpacity }).catch(
    (err: unknown) => {
      console.error("save_settings failed:", err);
      logLine(`[chat] save_settings failed: ${String(err)}`);
    },
  );
}

settingsToggle.addEventListener("click", () => {
  settingsPanel.hidden = !settingsPanel.hidden;
});

// 风格芯片：点选即 apply（换主题类）+ save（opacity 保持当前值）。
for (const chip of styleChips) {
  chip.addEventListener("click", () => {
    applySettings(chip.dataset.style, currentOpacity);
    saveSettings();
  });
}

// 透明度滑杆：input 即时 apply（只动 --win-alpha，拖动全程平滑），change 才 save。
alphaRange.addEventListener("input", () => {
  currentOpacity = clampOpacity(Number(alphaRange.value));
  document.documentElement.style.setProperty("--win-alpha", String(currentOpacity));
  alphaValue.textContent = String(currentOpacity);
});
alphaRange.addEventListener("change", saveSettings);

// Startup load; read failure → defaults + one debug line (读不出来不挡聊天).
void invoke<SettingsPayload>("get_settings")
  .then((s) => applySettings(s.style, s.opacity))
  .catch((err: unknown) => {
    console.error("get_settings failed, falling back to defaults:", err);
    applySettings("c", 0.92);
    logLine(`[chat] get_settings failed, defaults applied: ${String(err)}`);
  });

// 关闭入口（round 4）：无边框窗没有系统 ×，按钮 / Esc（及轮 5 的失焦即关）
// 都走 close()——close 只关窗；claude 进程保活，收殓由应用退出钩子负责
// （src-tauri/src/lib.rs ExitRequested → chat_stop，轮 1 裁定）。
// round 5：close 失败（含 ACL 拒绝）不再静默，具名落日志。
function closeChat(): void {
  try {
    getCurrentWindow()
      .close()
      .catch((err: unknown) => {
        console.error("chat close() failed:", err);
        logLine(`[chat] close() failed: ${String(err)}`);
      });
  } catch (err) {
    console.error("chat close() threw:", err);
    logLine(`[chat] close() threw: ${String(err)}`);
  }
}

closeBtn.addEventListener("click", closeChat);

// 拖拽（acceptance round 1）：chat 窗无边框，头部空白区是唯一移动入口。
// 左键按下即原生拖拽（照 main.ts 宠物窗的 startDragging 模式）；⚙/× 上
// 的按下不计（按钮自己消费点击）。
titlebarEl.addEventListener("mousedown", (e: MouseEvent) => {
  if (e.button !== 0) return;
  if ((e.target as HTMLElement).closest("button")) return;
  getCurrentWindow()
    .startDragging()
    .catch((err: unknown) => {
      console.error("startDragging failed:", err);
      logLine(`[chat] startDragging failed: ${String(err)}`);
    });
});
document.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Escape") closeChat();
});

// Round-3 probe, acceptance round 2: the load marker no longer renders into
// the visible message area (it was the "empty window, history pops in later"
// artifact) — diagnostics live in debug.log now. A fresh `loaded` line still
// timestamps page (re)creation for the log timeline.
logLine(`[chat] chat window loaded @ ${new Date().toLocaleTimeString()}`);
