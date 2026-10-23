import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

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

function userBubble(text: string): void {
  const el = document.createElement("div");
  el.className = "bubble user";
  el.textContent = text;
  messagesEl.appendChild(el);
  scrollBottom();
}

// Current turn's assistant bubble; created on first streamed text of the turn.
function streamingBubbleFor(): HTMLElement {
  if (!streamingBubble) {
    const el = document.createElement("div");
    el.className = "bubble assistant";
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
    systemLine("会话已连接");
    return;
  }
  if (e.payload.kind === "text") {
    const bubble = streamingBubbleFor();
    bubble.textContent += e.payload.text; // textContent: no HTML injection
    scrollBottom();
    return;
  }
  // done → close the current assistant bubble, separate the next turn.
  // (The result text itself was already streamed via "text" events.)
  if (streamingBubble) {
    streamingBubble = null;
    addDivider();
  }
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
