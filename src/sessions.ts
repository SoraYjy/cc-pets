// Sessions panel (v1.2 Task 4): pure display of the watcher's
// sessions-snapshot stream — one row per live Claude Code session (status
// dot + project + session name + relative activity time). No input. Closes
// via ×/Esc and light-dismiss (失焦即收, acceptance-fix-14 — same hide
// lifecycle and arming scheme as the chat bubble) and is toggled by
// right-clicking the pet (main.ts).

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { projectOf } from "./format";

// Same wire shape watcher.rs emits (the pet window re-emits its stored copy
// as a creation catch-up with the identical shape).
interface SessionRow {
  sessionId: string;
  cwd: string;
  name: string;
  status: string;
  updatedAtMs: number;
}

interface SessionsSnapshotPayload {
  sessions: SessionRow[];
}

const listEl = document.getElementById("session-list") as HTMLElement;
const closeBtn = document.getElementById("close") as HTMLButtonElement;

// Latest snapshot; re-rendered by the snapshot listener AND by a 1s local
// tick (the relative "3s 前" column ages even between poller ticks).
let latest: SessionsSnapshotPayload | null = null;

// Display order: busy first, then project name, then session name (the
// payload order is read_dir order — explicitly not stable, per the contract).
function compareRows(a: SessionRow, b: SessionRow): number {
  const busyOf = (r: SessionRow): number => (r.status === "busy" ? 0 : 1);
  return (
    busyOf(a) - busyOf(b) ||
    projectOf(a.cwd).localeCompare(projectOf(b.cwd)) ||
    a.name.localeCompare(b.name) ||
    a.sessionId.localeCompare(b.sessionId)
  );
}

// Age of the last registry heartbeat, coarse-grained on purpose: the
// panel is a glance surface, seconds precision below a minute is enough.
function relativeAge(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s 前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m 前`;
  return `${Math.floor(m / 60)}h 前`;
}

// Clear-then-redraw, strictly idempotent: duplicate snapshot deliveries
// (poller broadcast + pet catch-up re-emits) render the same DOM.
function render(): void {
  const rows = [...(latest?.sessions ?? [])].sort(compareRows);
  listEl.textContent = ""; // clears all children
  if (rows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "没有运行中的会话";
    listEl.appendChild(empty);
    return;
  }
  for (const row of rows) {
    const el = document.createElement("div");
    el.className = "row";
    // Names/cwd come from the session registry files (external data) —
    // built via createElement/textContent only, no innerHTML anywhere.
    el.title = `${row.name} · ${row.cwd}`;
    const dot = document.createElement("span");
    dot.className = `dot ${row.status === "busy" ? "busy" : "idle"}`;
    const meta = document.createElement("div");
    meta.className = "meta";
    const project = document.createElement("span");
    project.className = "project";
    project.textContent = projectOf(row.cwd);
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = row.name;
    meta.append(project, name);
    const ago = document.createElement("span");
    ago.className = "ago";
    ago.textContent = relativeAge(row.updatedAtMs);
    el.append(dot, meta, ago);
    listEl.appendChild(el);
  }
}

void listen<SessionsSnapshotPayload>("sessions-snapshot", (e) => {
  latest = e.payload;
  render();
});
// Relative-time aging between ticks; skipped while hidden (same CPU
// discipline as the sprite loop's document.hidden gate).
window.setInterval(() => {
  if (document.hidden) return;
  render();
}, 1000);

// ===== Close entries (chat 同款)：× / Esc → hide，窗口不销毁 =====
function logLine(text: string): void {
  void invoke("append_debug", { line: text }).catch(() => {});
}

function hidePanel(): void {
  getCurrentWindow()
    .hide()
    .catch((err: unknown) => {
      console.error("sessions hide() failed:", err);
      logLine(`[sessions] hide() failed: ${String(err)}`);
    });
}

closeBtn.addEventListener("click", hidePanel);
document.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Escape") hidePanel();
});

// ===== Light-dismiss（acceptance-fix-14）：点面板外任意区域即收起 =====
//
// 与聊天窗同一套成熟实现（chat 轮 b0e10f8）：守卫必须在加载时用 isFocused
// 主动武装——创建期 focused=true 事件先于监听注册、注定错过，只等后续
// focus 事件武装会永远等不到（点猫/点聊天窗/点桌面夺焦即收起；Esc/× 路径
// 不变；面板 hide 后再右键猫照常 show）。失焦分支留 append_debug 一行，
// 「没收到/没收起」的判读可直接读 debug.log。
let armed = false;
void getCurrentWindow()
  .isFocused()
  .then((focused) => {
    if (focused) armed = true;
  })
  .catch(() => {}); // 探测失败 → 仅依赖事件路
void getCurrentWindow().onFocusChanged(({ payload: focused }) => {
  if (focused) {
    armed = true;
    return;
  }
  logLine(`[sessions] blur fired, armed=${armed}${armed ? " → hide" : " → ignored"}`);
  if (armed) {
    hidePanel();
  }
});

// Diagnostics: exceptions that used to be console-only land in debug.log
// (same rationale as the chat window's hooks — no debug line in this window).
window.addEventListener("error", (e) => {
  console.error("sessions window error:", e.message);
  logLine(`[sessions] window error: ${e.message}`);
});
window.addEventListener("unhandledrejection", (e) => {
  console.error("sessions unhandled rejection:", e.reason);
  logLine(`[sessions] unhandled rejection: ${String(e.reason)}`);
});

logLine(`[sessions] sessions window loaded @ ${new Date().toLocaleTimeString()}`);
