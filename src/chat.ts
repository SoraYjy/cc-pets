import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { decideDoneFallback, type ChatEntry } from "./history";
import { clampOpacity, normalizeStyle, type ThemeStyle } from "./theme";

// Backend chat.rs emits { kind: "init" | "text" | "done", text }.
interface ChatEventPayload {
  kind: "init" | "text" | "done";
  text: string;
}

// The pet window rebroadcasts watcher turn-complete summaries as
// "turn-summary" { sessionId, summary } so finished (external) Claude
// sessions show up here too (DESIGN §5.3).
interface TurnSummaryPayload {
  sessionId: string;
  summary: string;
}

const messagesEl = document.getElementById("messages") as HTMLElement;
const inputEl = document.getElementById("input") as HTMLTextAreaElement;
const sendBtn = document.getElementById("send") as HTMLButtonElement;
const closeBtn = document.getElementById("close") as HTMLButtonElement;
const settingsToggle = document.getElementById("settings-toggle") as HTMLButtonElement;
const settingsPanel = document.getElementById("settings-panel") as HTMLElement;
const alphaRange = document.getElementById("alpha") as HTMLInputElement;
const alphaValue = document.getElementById("alpha-value") as HTMLElement;
const styleChips = Array.from(document.querySelectorAll<HTMLButtonElement>(".chip"));

let sending = false;
let streamingBubble: HTMLElement | null = null;
let toastTimer: number | null = null;

function scrollBottom(): void {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function systemLine(text: string): void {
  const el = document.createElement("div");
  el.className = "sysline";
  el.textContent = text;
  messagesEl.appendChild(el);
  scrollBottom();
}

// Persistent "connected" line: repeated init events update the timestamp in
// place instead of stacking one line per init (round 3 dedupe).
let connectedLine: HTMLElement | null = null;

function showConnected(): void {
  const time = new Date().toLocaleTimeString();
  if (connectedLine && connectedLine.isConnected) {
    connectedLine.textContent = `会话已连接 @ ${time}`;
    return;
  }
  connectedLine = document.createElement("div");
  connectedLine.className = "sysline";
  connectedLine.textContent = `会话已连接 @ ${time}`;
  messagesEl.appendChild(connectedLine);
  scrollBottom();
}

// Turn summaries go to the top of the message area, newest first — they are
// status notices, not part of the conversation flow.
function summaryLine(text: string): void {
  const time = new Date().toLocaleTimeString([], { hour12: false });
  const el = document.createElement("div");
  el.className = "sysline summary";
  el.textContent = `[${time}] ${text}`;
  messagesEl.insertBefore(el, messagesEl.firstChild);
  messagesEl.scrollTop = 0;
}

// Shared bubble factory (extracted so the history re-render and the done
// fallback reuse the exact same user/assistant markup). textContent only.
function makeBubble(kind: "user" | "assistant", text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = `bubble ${kind}`;
  el.textContent = text;
  return el;
}

function userBubble(text: string): void {
  messagesEl.appendChild(makeBubble("user", text));
  scrollBottom();
}

// Current turn's assistant bubble; created on first streamed text of the turn.
function streamingBubbleFor(): HTMLElement {
  if (!streamingBubble) {
    const el = makeBubble("assistant", "");
    messagesEl.appendChild(el);
    streamingBubble = el;
  }
  return streamingBubble;
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
    showConnected();
    return;
  }
  if (e.payload.kind === "text") {
    hideTyping(); // first streamed text of the turn replaces the dots
    const bubble = streamingBubbleFor();
    bubble.textContent += e.payload.text; // textContent: no HTML injection
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
    messagesEl.appendChild(makeBubble("assistant", e.payload.text));
    scrollBottom();
  }
  streamingBubble = null;
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
  // Guard (Task 3 deferred fix): a catch-up delivery landing mid-stream must
  // not clear-and-redraw over an in-flight streaming bubble — the next
  // catch-up (full log) re-renders once the turn is done, so skip instead.
  if (streamingBubble !== null) return;
  messagesEl.textContent = ""; // clears all children
  streamingBubble = null; // its element was just removed from the DOM
  typingIndicator = null; // its element was just removed from the DOM
  connectedLine = null; // stale reference; the next init makes a fresh line
  for (const entry of entries) {
    if (entry.role === "system") {
      const el = document.createElement("div");
      el.className = "sysline";
      el.textContent = `${entry.text} @ ${entry.ts}`;
      messagesEl.appendChild(el);
    } else {
      messagesEl.appendChild(makeBubble(entry.role, entry.text));
    }
  }
  scrollBottom();
}

void listen<ChatHistoryPayload>("chat-history", (e) => {
  renderHistory(e.payload.entries);
});

void listen<TurnSummaryPayload>("turn-summary", (e) => {
  const summary = e.payload.summary ? e.payload.summary : "（无文本摘要）";
  summaryLine(`✓ 任务完成：${summary}`);
});

// Stop the claude process when the window closes; fire-and-forget, then let
// the close proceed (no preventDefault).
void getCurrentWindow().onCloseRequested(() => {
  invoke("chat_stop").catch(() => {});
});

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

// 关闭入口（round 4）：无边框窗没有系统 ×，按钮 / Esc 都走 close()——
// close() 触发上面的 onCloseRequested → chat_stop，链路保持不变。
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
document.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Escape") closeChat();
});

// Round-3 probe: if the message list ever clears and a NEW loaded line shows
// up, the window/page was re-created (all JS state reset — investigate the
// re-creation source next); a cleared list WITHOUT a new loaded line means
// the wipe happened inside this page's JS state instead.
systemLine(`chat window loaded @ ${new Date().toLocaleTimeString()}`);
