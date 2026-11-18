import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import {
  currentMonitor,
  cursorPosition,
  getCurrentWindow,
  PhysicalPosition,
  type Monitor,
} from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { clampPetZoom } from "./theme";
import { clampDrag, grabOffset, type MonitorBounds, type Physical } from "./drag";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import {
  formatDuration,
  projectOf,
  truncateForNotification,
} from "./format";
import { pushCapped, type ChatEntry } from "./history";
import {
  decideCursorIgnore,
  frameAt,
  loadPet,
  offsetFor,
  shouldWriteFrame,
  type AnimationDef,
} from "./sprite";

const PET_BASE = "/pet";
const CELL_W = 192;
const CELL_H = 208;
const SHEET_W = CELL_W * 8; // 1536px — spritesheet grid is 8 columns
const SHEET_H = CELL_H * 4; // 832px — spritesheet grid is 4 rows

// Runtime pet zoom (acceptance-fix-12): the pet window is oversized to
// 288×312 (=1.5× headroom, transparent so no visual cost); the sprite layer
// stays 192×208 and grows via transform: scale() anchored bottom-center —
// feet stay planted on the same floor line, horizontal center never drifts.
// The pixel hit-test mask maps window coords back through the same transform
// (see alphaAt).
const PET_WIN_W = 288;
const PET_WIN_H = 312;
const ELEM_X = (PET_WIN_W - CELL_W) / 2; // 48 — sprite layer offset in window
const ELEM_Y = PET_WIN_H - CELL_H;       // 104
let petZoom = 1.0;

const DRAG_THRESHOLD_PX = 4; // movement beyond this starts a window drag
const CLICK_MAX_MS = 400; // presses longer than this never count as a click

const CHAT_LABEL = "chat";
const CHAT_WIDTH = 340;
const CHAT_HEIGHT = 420;
const CHAT_GAP_PX = 8; // clearance between pet and bubble

// v1.2 Task 4: sessions panel — right-click on the pet toggles it. The window
// lifecycle copies the chat mode (hide/show, never destroyed; created visible;
// closed from inside via ×/Esc or light-dismiss — acceptance-fix-14).
const SESSIONS_LABEL = "sessions";
const SESSIONS_WIDTH = 320;
const SESSIONS_HEIGHT = 380;

// Light-dismiss (acceptance round 5): both close paths — the bubble's own
// blur-close and the pet's toggle-close — stamp chatClosedAt; a pet click
// inside the grace window right after a close is ignored, so the losing
// side of the blur/toggle race cannot instantly reopen the bubble.
const CHAT_REOPEN_GRACE_MS = 350;
let chatClosedAt = 0;

// v1.2 Task 3（通知点击聚焦，启发式）：桌面端插件拿不到通知的原生点击事件——
// 点通知的实际效果是 macOS 激活本应用，pet 窗随之获得焦点。于是「发通知后
// 短时间内 pet 窗 focus=true」就是「用户点了通知」的替身：60s 窗口内 pet 窗
// 聚焦且气泡自该通知起从未显示过 → reveal（复用既有 show 链路）。固有语义：
// 60s 内 Cmd-Tab 切走再切回同样触发（README 已知限制）；未来插件支持原生
// 点击事件时可整体替换。
const NOTIFICATION_FOCUS_WINDOW_MS = 60_000;
let lastNotificationAt = 0;
// 「已显示」闩（边界②）：气泡任一显示路径盖闩、发通知成功时复位——用户已
// 为这条通知开过（又关掉）气泡后，后续激活不得再自动弹。
let bubbleShownSinceNotification = true;

// ===== Debug line =====

// Diagnostic facility (acceptance fix): failure paths that used to be
// console-only — or swallowed entirely — land on a single red line under the
// pet (#debug-line in index.html), so chat-window / notification triage works
// without devtools. Successes flash through too and clear themselves.
let debugClearTimer: ReturnType<typeof setTimeout> | undefined;

function setDebugLine(msg: string, clearAfterMs?: number): void {
  if (debugClearTimer !== undefined) {
    clearTimeout(debugClearTimer);
    debugClearTimer = undefined;
  }
  const el = document.getElementById("debug-line");
  if (el) el.textContent = msg;
  if (clearAfterMs !== undefined) {
    debugClearTimer = setTimeout(() => {
      debugClearTimer = undefined;
      const el = document.getElementById("debug-line");
      if (el) el.textContent = "";
    }, clearAfterMs);
  }
}

// Failure path: console.error + debug line + persisted log (append_debug is
// fire-and-forget; logging failures are silently ignored).
function showDebug(msg: string): void {
  console.error(msg);
  setDebugLine(msg);
  void invoke("append_debug", { line: msg }).catch(() => {});
}

// Breadcrumb (fix round 2): informational step marker on the same debug line,
// no console.error — later crumbs overwrite earlier ones, and success tails
// pass a clearAfter so the line empties itself once everything worked.
// Also mirrored into the persisted log.
function debug(msg: string, clearAfterMs?: number): void {
  setDebugLine(msg, clearAfterMs);
  void invoke("append_debug", { line: msg }).catch(() => {});
}

// Best-effort readable text for arbitrary error values (invoke rejections are
// usually plain strings, JS failures are Error objects).
function errorText(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === "string") return msg;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

// ===== Sprite player =====

// Exactly one rAF chain runs at a time: each play() bumps rafToken so the
// previous chain stops on its next frame. One-shot animations (wave/done)
// fall back to the current session animation (idle/working) when finished.
let petEl: HTMLDivElement | null = null;
let anims: AnimationDef[] = [];
let rafToken = 0;
// The pending rAF handle of the live chain (v1.2 Task 2): kept so the loop can
// be canceled outright when the page hides (visibilitychange pause).
let rafId: number | null = null;
// True while the loop is canceled by a hidden page — the resume path only
// restarts a loop it actually paused (never injects a spurious play pre-init).
let loopPausedByHidden = false;
let sessionAnimName = "idle"; // driven by session-status events
// The animation the live chain is playing — the restart point when the page
// becomes visible again (elapsed re-bases at 0 there).
let currentAnimName = "idle";
// The sprite cell currently on screen (alpha hit testing reads this).
let curFrame = { row: 0, col: 0 };
// v1.2 Task 2 自检计数器：真实 style 写入次数（60s 汇报一次到 debug.log）。
let spriteWriteCount = 0;

function playAnimation(name: string): void {
  const anim = anims.find((a: AnimationDef) => a.name === name);
  if (!anim || !petEl) {
    console.error(`animation "${name}" not found in pet.json`);
    return;
  }
  currentAnimName = name;
  const token = ++rafToken;
  const durationMs = anim.loop ? Infinity : (anim.frames / anim.fps) * 1000;
  let start: number | null = null;
  // 每条链一份判定基准，换动画/换肤（都经 playAnimation）自然重置——陈旧
  // 判定不可能跨链泄漏，首帧必写一次。见 shouldWriteFrame（sprite.ts）。
  let lastWritten: { row: number; col: number } | null = null;
  const tick = (now: number): void => {
    if (!petEl || token !== rafToken) return; // superseded by a newer play
    if (start === null) start = now;
    const elapsed = now - start;
    if (elapsed >= durationMs) {
      playAnimation(sessionAnimName); // one-shot finished → session state
      return;
    }
    const col = frameAt(anim, elapsed);
    const frame = { row: anim.row, col };
    // CPU 优化（v1.2 Task 2）：仅帧号变化才落笔。此前每个 rAF tick（60Hz
    // ≈3600 次/分、120Hz ProMotion ≈7200 次/分）都做一次 CSSOM 字符串解析
    // + 样式失效，而 idle 只有 4 帧（fps 3）——绝大多数写入是恒等重写。
    if (shouldWriteFrame(lastWritten, frame)) {
      petEl.style.backgroundPosition = offsetFor(anim.row, col);
      lastWritten = frame;
      curFrame = frame;
      spriteWriteCount++;
    }
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
}

// ===== Sprite loop pause (v1.2 Task 2, document.hidden) =====

// Hidden → cancel the pending frame: WebKit already stops firing rAF for
// hidden pages, but canceling makes the stop explicit and drops the queued
// callback. Only the sprite loop is touched — event listeners and polling are
// Rust-side (watcher/chat) and never ran in this window's JS anyway.
// Visible → replay the animation the chain was running (currentAnimName):
// playAnimation re-bases start at null, so elapsed counts from 0 and the
// sprite resumes from its first frame instead of jumping across the whole
// hidden gap.
function onVisibilityChange(): void {
  if (document.hidden) {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
      loopPausedByHidden = true;
      debug("sprite loop paused (hidden)", 5000);
    }
  } else if (loopPausedByHidden) {
    loopPausedByHidden = false;
    debug("sprite loop resumed (visible) — elapsed re-based", 5000);
    playAnimation(currentAnimName);
  }
}

function setupSpriteLifecycle(): void {
  document.addEventListener("visibilitychange", onVisibilityChange);
}

// ===== Sprite write telemetry (v1.2 Task 2, debug.log only) =====

// Low-frequency self-check for the frame-change optimization: every 60s the
// actual style-write count lands in debug.log (NOT on the debug line) and the
// counter resets. Expected shape: before = one write per rAF tick (≈3600/min
// at 60Hz, ≈7200/min on 120Hz ProMotion); after = frame changes only
// (fps × 60 — idle ≈180/min, working ≈360/min, near-zero while hidden).
const SPRITE_WRITE_REPORT_INTERVAL_MS = 60_000;

function setupSpriteWriteTelemetry(): void {
  window.setInterval(() => {
    void invoke("append_debug", {
      line: `sprite style writes (60s): ${spriteWriteCount}`,
    }).catch(() => {});
    spriteWriteCount = 0;
  }, SPRITE_WRITE_REPORT_INTERVAL_MS);
}

// ===== Pixel-accurate hit testing (acceptance round 2) =====

// Clicks on transparent pixels should fall through to the desktop — only the
// cat's body is interactive. The spritesheet's alpha channel is the mask: the
// full sheet is decoded once, and each mousemove probes the alpha of the
// sprite cell currently on screen at the cursor position.
const ALPHA_THRESHOLD = 16; // 0–255; below → transparent → ignore mouse

let sheetAlpha: Uint8ClampedArray | null = null; // RGBA of the whole sheet
let alphaMaskUrl: string | null = null; // sheet the mask was decoded from
let ignoringMouse = false;
let dragging = false; // hoisted so the hit-test probe can pin non-ignore
let pointerPressed = false; // mousedown→mouseup 之间：轮询/命中探针禁止翻穿透

async function loadAlphaMask(url: string = `${PET_BASE}/spritesheet.png`): Promise<void> {
  try {
    const res = await fetch(url);
    const bitmap = await createImageBitmap(await res.blob());
    const canvas = document.createElement("canvas");
    canvas.width = SHEET_W;
    canvas.height = SHEET_H;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");
    ctx.drawImage(bitmap, 0, 0);
    sheetAlpha = ctx.getImageData(0, 0, SHEET_W, SHEET_H).data;
    alphaMaskUrl = url;
    startCursorPoll(); // 蒙版就绪，恒定轮询上线（幂等，换肤重解码不会叠加）
  } catch (err) {
    // No mask → hit testing stays off entirely (window behaves as before).
    showDebug(`alpha mask load failed: ${errorText(err)}`);
  }
}

// Logical cursor position → alpha of the on-screen sprite pixel. The sprite
// layer (192×208) sits offset (ELEM_X, ELEM_Y) inside the oversized window
// and is scaled by petZoom around its bottom-center; a window point maps back
// through the inverse transform:
//   sprite = origin + (window − layer offset − origin) / zoom
// with origin = (CELL_W/2, CELL_H) in layer coords. At zoom 1.0 this reduces
// to the legacy (x − ELEM_X, y − ELEM_Y) element mapping — pixel-identical.
function alphaAt(wx: number, wy: number): number {
  if (!sheetAlpha) return 255; // no mask → treat everything as opaque
  const lx = CELL_W / 2 + (wx - ELEM_X - CELL_W / 2) / petZoom;
  const ly = CELL_H + (wy - ELEM_Y - CELL_H) / petZoom;
  const fx = lx / CELL_W;
  const fy = ly / CELL_H;
  if (fx < 0 || fx >= 1 || fy < 0 || fy >= 1) return 0;
  const px = Math.min(SHEET_W - 1, Math.floor((curFrame.col + fx) * CELL_W));
  const py = Math.min(SHEET_H - 1, Math.floor((curFrame.row + fy) * CELL_H));
  return sheetAlpha[(py * SHEET_W + px) * 4 + 3];
}

// ⚙ 大小滑杆 / 启动设置（acceptance-fix-12）：transform: scale() 以
// bottom-center 为原点——脚贴同一地面线、水平中心不漂（合成器路径，无重排）。
// 命中映射（alphaAt）读同一 petZoom，缩放后点击穿透仍贴合猫体。
function applyPetZoom(z: number): void {
  petZoom = clampPetZoom(z);
  if (petEl) {
    petEl.style.transform = `scale(${petZoom})`;
  }
}

// One global-cursor probe → window-logical coords → sprite alpha. 255 when
// the mask isn't loaded yet (poll then keeps the window clickable, same as
// the pre-mask default).
async function probeCursorAlpha(): Promise<number> {
  if (!sheetAlpha) return 255;
  const win = getCurrentWindow();
  const [cursor, origin, sf] = await Promise.all([
    cursorPosition(),
    win.outerPosition(),
    win.scaleFactor(),
  ]);
  return alphaAt((cursor.x - origin.x) / sf, (cursor.y - origin.y) / sf);
}

// 全局光标轮询（恒定运行，蒙版就绪后启动，双向翻转）：macOS 只给 key 窗口
// 投递 mouse-moved，pet 窗失焦后 applyHitTesting 收不到事件，ignore 状态会
// 冻结在「可点击」——整个窗口矩形（含透明区）都吃点击/拖拽/右键（即「可点
// 击区域大于形象」）。轮询补上失焦态：透明 → 置穿透（新增）；不透明 → 翻回
// 可点（既有行为，ignored 时 webview 收不到任何事件、唯有全局轮询能救）。
let cursorPollTimer: number | null = null;

function startCursorPoll(): void {
  if (cursorPollTimer !== null) return;
  cursorPollTimer = window.setInterval(() => {
    void (async () => {
      const busy = pointerPressed || dragging;
      const ignore = decideCursorIgnore(await probeCursorAlpha(), busy, ALPHA_THRESHOLD);
      setIgnoreMouse(ignore, "poll");
    })().catch((err: unknown) => {
      // Fail open: any probe failure returns the window to clickable.
      console.error("cursor poll failed:", err);
      setIgnoreMouse(false, "poll-error");
    });
  }, 100);
}

function setIgnoreMouse(
  ignore: boolean,
  source: "move" | "poll" | "poll-error" | "drag" = "move",
): void {
  if (ignoringMouse === ignore) return; // only flip on state change
  ignoringMouse = ignore;
  // 诊断钉：每次翻转落日志，验收时可确认失焦态的翻转确实来自 poll。
  void invoke("append_debug", { line: `hit-test: ignore=${ignore} via ${source}` }).catch(
    () => {},
  );
  getCurrentWindow()
    .setIgnoreCursorEvents(ignore)
    .catch((err: unknown) => {
      // Fail open: permission/IPC failure must not leave the pet unclickable.
      console.error("setIgnoreCursorEvents failed:", err);
      ignoringMouse = false;
    });
}

// forward:true keeps mouse-MOVE events arriving while ignored, so the probe
// can flip back to non-ignore as soon as the cursor is over the cat again.
// While dragging, pin non-ignore (a drag must never lose its window).
function applyHitTesting(e: MouseEvent): void {
  if (!sheetAlpha) return;
  // 手势进行中钉住可点：拖拽绝不能丢窗口；按下中翻穿透会吃掉 mouseup。
  if (pointerPressed || dragging) {
    setIgnoreMouse(false, "drag");
    return;
  }
  setIgnoreMouse(
    decideCursorIgnore(alphaAt(e.clientX, e.clientY), false, ALPHA_THRESHOLD),
    "move",
  );
}

// ===== Backend events =====

// watcher.rs emits session-status { working } / turn-complete { sessionId, cwd, summary }.
interface SessionStatusPayload {
  working: boolean;
}

interface TurnCompletePayload {
  sessionId: string;
  cwd: string;
  summary: string;
  // Session context (acceptance round 4, additive fields): the registry
  // entry's name and the turn_duration row's durationMs (null when absent).
  name: string;
  durationMs: number | null;
}

// v1.2 多皮肤：chat 窗的 ⚙ 面板点选皮肤芯片后全局广播（chat.ts emit），
// 本窗监听后重新 loadPet 并重启精灵动画，换肤即时生效、无需重启。
interface SkinChangedPayload {
  skinId: string;
}

// v1.2 Task 4: watcher 每 tick 对 alive 列表整体 emit 的会话快照（多会话
// 视图面板的数据源；pet 自有 chat 进程沿用 self_pids 过滤、不在其中）。
interface SessionRow {
  sessionId: string;
  cwd: string;
  name: string;
  status: string;
  updatedAtMs: number;
  // v1.3 Task 1：最近工具活动，恒在场、无值 null（watcher.rs 同款契约，
  // sessions.ts 按 string|null 消费——本窗只转发快照，类型保持一致）。
  activity: string | null;
}

interface SessionsSnapshotPayload {
  sessions: SessionRow[];
}

// 最新一份快照（v1.2 Task 4）：面板本身在 sessions 窗，pet 窗只存一份数据，
// 用于新开面板时的补发——窗口 created 派发时新页面 listen 往往尚未注册，
// 首批补发被安全丢弃，front-loaded 重发兜住（与 chat-history 同机制）。
let latestSessions: SessionsSnapshotPayload | null = null;

// Session-context formatting (acceptance round 4) — projectOf /
// formatDuration / truncateForNotification live in format.ts (test-infra L1
// extraction), pure helpers shared with chat.ts.

function setupListeners(): void {
  void listen<SessionStatusPayload>("session-status", (e) => {
    sessionAnimName = e.payload.working ? "working" : "idle";
    playAnimation(sessionAnimName);
  });

  // ⚙ 大小滑杆（acceptance-fix-12）：chat 窗 input 即时 emit，pet 实时缩放
  // 并同步命中映射（alphaAt 读同一 petZoom）。
  void listen<{ zoom: number }>("pet-zoom-changed", (e) => {
    applyPetZoom(clampPetZoom(e.payload.zoom));
  });

  void listen<TurnCompletePayload>("turn-complete", (e) => {
    // Acceptance round 1: notification evidence chain — the listener entry
    // and each notification branch leave one persisted breadcrumb, so a
    // silent no-notification has a timeline (debug.log) to diff against.
    debug(
      `turn-complete received: sid=${e.payload.sessionId} summary=${e.payload.summary}`,
    );
    playAnimation("done");
    const project = projectOf(e.payload.cwd);
    const dur = formatDuration(e.payload.durationMs);
    const ctx = dur ? `${project}（${dur}）` : project;
    // DESIGN §5.3: the bubble window also shows the result summary. Global
    // broadcast — the chat window (if open) picks it up as a system line.
    // project/durationMs are additive context fields (acceptance round 4).
    void emit("turn-summary", {
      sessionId: e.payload.sessionId,
      summary: e.payload.summary,
      project,
      durationMs: e.payload.durationMs,
    }).catch((err: unknown) => console.error("turn-summary emit failed:", err));
    // v1.1: mirror the finished turn into the history log (same ✓ wording the
    // chat window's summary line uses, so reopen keeps the session context).
    recordEntry(
      "system",
      `✓ 任务完成 · ${ctx}：${e.payload.summary ? e.payload.summary : "（无文本摘要）"}`,
    );
    // macOS gates notifications behind a one-time system authorization:
    // query first, then request when missing. The first turn-complete after
    // install therefore pops the system dialog — expected (acceptance fix:
    // this used to be query-only and silently skipped on denied permission).
    void (async () => {
      let granted = await isPermissionGranted();
      debug(`notification permission: ${granted ? "granted" : "not granted"}`);
      if (!granted) {
        granted = (await requestPermission()) === "granted";
        debug(
          `notification permission request: ${granted ? "granted" : "denied"}`,
        );
      }
      if (granted) {
        sendNotification({
          title: `任务完成 · ${ctx}`,
          body: e.payload.summary
            ? truncateForNotification(e.payload.summary)
            : "查看 Claude Code 终端",
        });
        // v1.2 Task 3: 发送成功 → 盖时刻戳（启发式聚焦的时间锚）并复位
        // 「已显示」闩；此刻气泡若正开着，摘要已随 turn-summary 上屏——
        // 视为已显示过，后续激活不再自动弹。
        lastNotificationAt = Date.now();
        bubbleShownSinceNotification = false;
        debug(`notification sent at ${lastNotificationAt}`);
        try {
          const open = await WebviewWindow.getByLabel(CHAT_LABEL);
          if (open && (await open.isVisible().catch(() => false))) {
            bubbleShownSinceNotification = true;
          }
        } catch {
          // 气泡窗从未创建过 → 无需补闩
        }
      } else {
        debug("notification skipped: permission not granted");
      }
    })().catch((err: unknown) => showDebug(`notification failed: ${errorText(err)}`));
  });

  // v1.2 多皮肤：settings 面板换肤 → 重新 loadPet（pet.json 重取，新导入的
  // 皮肤无需重启即可见）+ 换背景图 + 重启精灵动画 + 重载 alpha 命中蒙版。
  void listen<SkinChangedPayload>("skin-changed", (e) => {
    debug(`skin-changed: ${e.payload.skinId}`, 5000);
    mountPet(e.payload.skinId).catch((err: unknown) =>
      showDebug(`skin switch failed: ${errorText(err)}`),
    );
  });

  // v1.2 Task 4: 每 tick 的会话快照只落「最新一份」（见 latestSessions），
  // 渲染是 sessions 窗自己的事；本窗监听仅为新开面板补发数据。
  void listen<SessionsSnapshotPayload>("sessions-snapshot", (e) => {
    latestSessions = e.payload;
  });

  // v1.2 Task 3: pet 窗聚焦 = 应用被激活（点通知 / Cmd-Tab 切回 / Dock 点击
  // 都走这里）——启发式把「60s 内有未消费的通知」当成弹气泡的许可。
  void getCurrentWindow().onFocusChanged(({ payload: focused }) => {
    // v1.3 Task 2 失焦保险丝：自绘拖拽依赖 mousemove 事件流（AppKit 只投递
    // 给 key 窗口）——拖拽中意外失焦（Spotlight/别的应用抢焦点）时事件流会
    // 断，手势状态不能卡死在 dragging，立即收尾。
    if (!focused) {
      if (dragging) endSelfDrawnDrag();
      // 失焦后 mouseup 永远不会到达——按下态一并清掉，手势钉不能卡死。
      pointerPressed = false;
      return;
    }
    if (Date.now() - lastNotificationAt >= NOTIFICATION_FOCUS_WINDOW_MS) return;
    if (bubbleShownSinceNotification) return;
    revealChatForNotification().catch((err: unknown) =>
      showDebug(`notification-focus failed: ${errorText(err)}`),
    );
  });
}

// ===== Chat history log (v1.1, A 档) =====

// The pet window owns the in-memory conversation log so it survives bubble
// window close/reopen; quitting the app clears it. Recording points: the chat
// window reports its own sends via "chat-user-message"; the backend
// "chat-event" stream and watcher turn summaries are mirrored here.
const CHAT_LOG_CAP = 200;

interface ChatUserMessagePayload {
  text: string;
}

// Same wire shape chat.rs emits (chat.ts declares its own copy).
interface ChatEventPayload {
  kind: "init" | "text" | "done";
  text: string;
}

const chatLog: ChatEntry[] = [];
let pendingAssistant = ""; // streamed "text" fragments of the current turn

function recordEntry(role: ChatEntry["role"], text: string): void {
  pushCapped(
    chatLog,
    { role, text, ts: new Date().toLocaleTimeString() },
    CHAT_LOG_CAP,
  );
}

function setupChatLog(): void {
  // ① the chat window reports each send (it renders its own local echo).
  void listen<ChatUserMessagePayload>("chat-user-message", (e) => {
    recordEntry("user", e.payload.text);
  });

  // ② mirror the chat-event stream: accumulate "text" fragments, finalize on
  // "done" — accumulated stream wins; when it is empty fall back to done.text
  // (a pure tool turn streams nothing but carries the result). "init" is a
  // system entry.
  // ③ clear-screen（acceptance-fix-10）：chat 窗已自行清空 DOM，这里同步
  // 清空持久日志使两边一致。claude 进程/会话上下文不动（「重开会话」走
  // chat_restart 命令，不经此事件）。在途回合的流式片段（pendingAssistant）
  // 保留，随该回合 done 正常落一条 assistant；resetStream（fix-11）由重开
  // 路径置真——旧进程被杀后 done 永不到达，残留片段必须复位，否则会黏进
  // 新会话首个回合的账目。
  void listen<{ resetStream?: boolean }>("chat-clear-history", (e) => {
    chatLog.length = 0;
    if (e.payload?.resetStream) {
      pendingAssistant = "";
    }
  });

  void listen<ChatEventPayload>("chat-event", (e) => {
    if (e.payload.kind === "init") {
      // "会话已连接" is connection state, not conversation content — and the
      // backend emits one init per QUERY (process start + every chat_send),
      // so recording it here made the persistent log accumulate duplicate
      // connection lines that re-rendered on every reopen (acceptance round
      // 1). The live connected line is the chat window's own concern
      // (showConnected updates in place).
      return;
    }
    if (e.payload.kind === "text") {
      pendingAssistant += e.payload.text;
      return;
    }
    if (pendingAssistant !== "") {
      recordEntry("assistant", pendingAssistant);
    } else if (e.payload.text !== "") {
      recordEntry("assistant", e.payload.text);
    }
    pendingAssistant = "";
  });
}

// ③ Push the log into a freshly created chat window. Timing: the api dispatch
// of `tauri://created` fires when the create command RESOLVES — the webview
// exists but its page has not booted yet, so the chat window's
// listen("chat-history") is not registered and a single emit would be dropped
// into an empty page context. The chat side renders clear-then-redraw
// (idempotent), so repeated catch-up re-emits are harmless duplicates. The
// schedule is front-loaded (acceptance round 2): five pushes at
// 100/250/500/1000/2000ms so the history appears within ~250ms of opening;
// deliveries that land before the page listens are safely dropped.
function emitChatHistory(): void {
  const push = (): void => {
    emit("chat-history", { entries: [...chatLog] }).catch((err: unknown) =>
      console.error("chat-history emit failed:", err),
    );
  };
  push();
  for (const delayMs of [100, 250, 500, 1000, 2000]) {
    setTimeout(push, delayMs);
  }
}

// ===== Chat bubble window =====

// `new WebviewWindow` reports its outcome via `tauri://created` /
// `tauri://error`. In the installed @tauri-apps/api these two names are
// "local" events: the constructor dispatches them ONLY to handlers registered
// on the instance, and if none is registered the outcome is dropped silently —
// the swallowed-failure defect from acceptance. So the instance listeners are
// registered immediately after construction (their registration is
// synchronous, before the async IPC can settle). Attribution uses a
// creation-in-flight flag because `tauri://created` carries no payload and
// `tauri://error` carries the raw error — there is no `payload.label` to
// filter on. The global listeners below are belt-and-braces for any broadcast
// variant of these events; the flag dedupes against the instance listeners.
let chatCreateInFlight = false;

// Serialize open attempts (acceptance round 6 bug): a rapid double pet click
// issued two concurrent create attempts before either getByLabel could see
// the other's window — two webviews booted under the one "chat" label (log:
// two "chat window loaded" lines + two spawned pids), after which close()
// could not address the visible one: light-dismiss looked like "content
// cleared but won't close" and × was dead. Chained attempts re-run the full
// openChatWindow body (label check + in-flight skip) after the previous
// constructor settles, so only one webview can ever come into existence.
let chatOpenChain: Promise<void> = Promise.resolve();

function openChatWindowSerialized(): Promise<void> {
  const run = chatOpenChain.then(openChatWindow, openChatWindow);
  chatOpenChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function onChatWindowCreated(): void {
  if (!chatCreateInFlight) return;
  chatCreateInFlight = false;
  setDebugLine("chat window created", 5000);
  markBubbleShown(); // v1.2 Task 3: 气泡已上屏
  emitChatHistory(); // v1.1: only the creation path pushes (setFocus path skips)
  // Pet stays above the bubble (acceptance round 2): two alwaysOnTop windows
  // stack by creation order, so re-assert the pet's level whenever the chat
  // window (re)appears.
  reassertPetOnTop();
}

// See onChatWindowCreated — re-applying alwaysOnTop re-stacks the pet above
// the chat window. (Effect is for the user to verify; recorded in the report.)
function reassertPetOnTop(): void {
  getCurrentWindow()
    .setAlwaysOnTop(true)
    .catch((err: unknown) => showDebug(`setAlwaysOnTop failed: ${errorText(err)}`));
}

function onChatWindowError(payload: unknown): void {
  if (!chatCreateInFlight) return;
  chatCreateInFlight = false;
  showDebug(`chat window error: ${errorText(payload)}`);
}

function setupChatWindowListeners(): void {
  void listen("tauri://created", () => onChatWindowCreated());
  void listen("tauri://error", (e) => onChatWindowError(e.payload));
}

// Geometry probe shared by the chat bubble and the sessions panel (v1.2
// Task 4: extracted verbatim from openChatWindow so both windows place
// themselves the same way): top-left corner for a w×h window centered above
// the pet with an 8px gap — no headroom above → to the pet's right; right
// overflows → to the pet's left; final clamp into the monitor. All geometry
// is computed in LOGICAL pixels: outerPosition/outerSize/monitor metrics come
// back in physical pixels while the constructor options are logical — round 1
// mixed the two and the bubble landed half off-screen. Each probe reports its
// own failure — a silent `catch(() => null)` would leave the caller hanging
// with no visible trace; on failure the coordinate stays undefined and the
// OS picks the placement.
async function positionNearPet(
  width: number,
  height: number,
): Promise<{ x?: number; y?: number }> {
  let x: number | undefined;
  let y: number | undefined;
  const petWin = getCurrentWindow();
  const [mon, petPos, petSize, probeSf] = await Promise.all([
    currentMonitor().catch((err: unknown) => {
      showDebug(`currentMonitor failed: ${errorText(err)}`);
      return null;
    }),
    petWin.outerPosition().catch((err: unknown) => {
      showDebug(`outerPosition failed: ${errorText(err)}`);
      return null;
    }),
    petWin.outerSize().catch((err: unknown) => {
      showDebug(`outerSize failed: ${errorText(err)}`);
      return null;
    }),
    // Acceptance-fix-9: probed in parallel instead of a serial follow-up await.
    petWin.scaleFactor().catch((err: unknown) => {
      showDebug(`scaleFactor failed: ${errorText(err)}`);
      return 1;
    }),
  ]);
  const sf = mon?.scaleFactor ?? probeSf ?? 1;
  if (petPos && petSize) {
    const petL = {
      x: petPos.x / sf,
      y: petPos.y / sf,
      w: petSize.width / sf,
      h: petSize.height / sf,
    };
    // Sprite-aware vertical anchor (final-review 必修 1): the pet window is
    // oversized (288×312) and the sprite layer scales bottom-center, so the
    // visible head top is NOT the window top:
    //   head = petTop + ELEM_Y + CELL_H × (1 − petZoom)
    // (zoom 1.0 → head at +104, 0.5 → +208, 1.5 → +0 = the window top).
    // Bubbles/panels sit 8px above that head line; at zoom 1.5 this
    // reproduces the legacy window-top anchoring exactly.
    const headTop = petL.y + ELEM_Y + CELL_H * (1 - clampPetZoom(petZoom));
    x = Math.round(petL.x + (petL.w - width) / 2);
    y = Math.round(headTop - CHAT_GAP_PX - height);
    if (mon) {
      const monL = {
        x: mon.position.x / sf,
        y: mon.position.y / sf,
        w: mon.size.width / sf,
        h: mon.size.height / sf,
      };
      if (y < monL.y) {
        // no headroom above → try to the right of the pet; the bubble top
        // stays on the head line (side fallback keeps the same anchor)
        x = Math.round(petL.x + petL.w + CHAT_GAP_PX);
        y = Math.round(headTop);
        if (x + width > monL.x + monL.w) {
          // right overflows → try to the left of the pet
          x = Math.round(petL.x - width - CHAT_GAP_PX);
        }
      }
      // final clamp into the monitor; without a monitor skip it entirely.
      // y 下界用可见区顶（workArea = 菜单栏下缘，物理 → 逻辑换算同 monL），
      // 不用完整 bounds 顶：侧向 fallback 后 headTop<0 可达，钳回完整顶会
      // 让气泡顶条压进菜单栏区（~24 逻辑 px）。字段语义与 drag.ts（v1.3
      // Task 2）的 workArea 用法一致。水平与底部钳制不动（dock 行为未变）。
      const workAreaTopLogical = mon.workArea.position.y / sf;
      x = Math.min(Math.max(x, monL.x), monL.x + monL.w - width);
      y = Math.min(Math.max(y, workAreaTopLogical), monL.y + monL.h - height);
    }
  }
  return { x, y };
}

async function openChatWindow(): Promise<void> {
  debug("opening chat window…");

  let existing: WebviewWindow | null = null;
  try {
    existing = await WebviewWindow.getByLabel(CHAT_LABEL);
  } catch (err) {
    // Keep going: the create attempt below will surface its own outcome.
    showDebug(`getByLabel failed: ${errorText(err)}`);
  }
  if (existing) {
    // Serialized-chain re-entry (click raced a create): the bubble exists —
    // reveal + focus it instead of creating a duplicate label.
    debug("chat exists → show/focus", 5000);
    markBubbleShown(); // v1.2 Task 3: 气泡已上屏
    await existing
      .unminimize()
      .catch((err: unknown) => showDebug(`chat unminimize failed: ${errorText(err)}`));
    await existing
      .show()
      .catch((err: unknown) => showDebug(`chat show failed: ${errorText(err)}`));
    await existing
      .setFocus()
      .catch((err: unknown) => showDebug(`chat setFocus failed: ${errorText(err)}`));
    reassertPetOnTop(); // pet must stay above the focused bubble
    return;
  }
  // Second line of defense against the double-create race (see
  // openChatWindowSerialized): an earlier create whose outcome event hasn't
  // landed yet must not be doubled up.
  if (chatCreateInFlight) {
    debug("create already in flight → skip", 5000);
    return;
  }
  debug("creating chat window…");

  // Preferred spot: centered above the pet with an 8px gap (shared probe —
  // see positionNearPet; v1.2 Task 4 extracted it for the sessions panel).
  const { x, y } = await positionNearPet(CHAT_WIDTH, CHAT_HEIGHT);

  // Outcome listeners are in place around the constructor (see above): the
  // instance handlers catch the api's local dispatch, the global handlers any
  // broadcast variant. Either way the outcome surfaces on the debug line.
  chatCreateInFlight = true;
  const chat = new WebviewWindow(CHAT_LABEL, {
    url: "chat.html",
    x,
    y,
    width: CHAT_WIDTH,
    height: CHAT_HEIGHT,
    decorations: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    // round 4: survive macOS Space switches — pet window gets the same via
    // tauri.conf.json (WindowConfig.visibleOnAllWorkspaces)
    visibleOnAllWorkspaces: true,
    // macOS: deliver the first click to the webview when the app is inactive
    // instead of swallowing it for app activation — one click opens the bubble
    // (WindowConfig.acceptFirstMouse → WryWebView.acceptsFirstMouse:).
    acceptFirstMouse: true,
  });
  void chat.once("tauri://created", () => onChatWindowCreated());
  void chat.once("tauri://error", (e) => onChatWindowError(e.payload));
  // Hide lifecycle (acceptance-fix-9): stamp the last time the chat went away
  // from THIS side too — every chat blur lands here, so the pet's toggle can
  // tell "hidden by this very click's blur" (within grace → stay hidden) from
  // "hidden earlier" (→ show). The destroyed stamp stays as the fallback for
  // system-initiated teardown.
  void chat.onFocusChanged(({ payload: focused }) => {
    if (!focused) chatClosedAt = Date.now();
  });
  void chat.once("tauri://destroyed", () => {
    chatClosedAt = Date.now();
  });
  // If neither event ever lands, the trail stops here — that absence is the
  // diagnostic signal (e.g. the IPC never settled).
  debug("constructor returned, waiting created/error…");
}

// ===== Click/drag =====

// Toggle semantics (acceptance round 5): with light-dismiss, focusing the
// bubble on pet click would fight the blur-close (click → blur → close →
// reopen). An open bubble is now closed by the click; a closed one opens.
async function onClickPet(): Promise<void> {
  debug("pet clicked");
  playAnimation("wave");
  let existing: WebviewWindow | null = null;
  try {
    existing = await WebviewWindow.getByLabel(CHAT_LABEL);
  } catch (err) {
    // Keep going: fall through to the open path below.
    showDebug(`getByLabel failed: ${errorText(err)}`);
  }
  if (existing) {
    // Hide/show lifecycle (acceptance-fix-9): the webview is never destroyed,
    // so toggle = hidden ? show : hide — no page reload either way.
    const visible = await existing.isVisible().catch(() => true);
    if (visible) {
      debug("chat visible → hide (toggle)", 5000);
      chatClosedAt = Date.now();
      await existing
        .hide()
        .catch((err: unknown) => showDebug(`chat hide failed: ${errorText(err)}`));
      return;
    }
    if (Date.now() - chatClosedAt < CHAT_REOPEN_GRACE_MS) {
      // The blur self-hide beat this click to it — the toggle already
      // happened via the blur path; do not instantly re-show.
      debug("chat just hid (blur race) → stay hidden", 5000);
      return;
    }
    debug("chat hidden → show", 5000);
    markBubbleShown(); // v1.2 Task 3: 气泡已上屏
    await existing
      .unminimize()
      .catch((err: unknown) => showDebug(`chat unminimize failed: ${errorText(err)}`));
    await existing
      .show()
      .catch((err: unknown) => showDebug(`chat show failed: ${errorText(err)}`));
    await existing
      .setFocus()
      .catch((err: unknown) => showDebug(`chat setFocus failed: ${errorText(err)}`));
    reassertPetOnTop();
    return;
  }
  if (Date.now() - chatClosedAt < CHAT_REOPEN_GRACE_MS) {
    // The blur self-hide beat this click to it — do not instantly re-show.
    debug("chat just hid → skip reopen (grace)", 5000);
    return;
  }
  openChatWindowSerialized().catch((err: unknown) =>
    showDebug(`openChatWindow failed: ${errorText(err)}`),
  );
  // spawn_chat resolves with the child pid (chat.rs: Ok(pid.to_string())).
  invoke<string>("spawn_chat")
    .then((pid) => debug(`spawn_chat ok: ${pid}`, 5000))
    .catch((err: unknown) => showDebug(`spawn_chat failed: ${errorText(err)}`));
}

// v1.2 Task 3：通知聚焦的 reveal——只作用于「已存在且隐藏」的气泡窗，show
// 链路（unminimize → show → setFocus → reassertPetOnTop）与点猫的 show 路径
// 完全一致。窗不存在时不动（不替用户凭空创建会话窗 / spawn 进程），留 debug
// 轨迹；可见性探测失败按可见处理（fail-quiet，宁可不弹不乱弹）。
async function revealChatForNotification(): Promise<void> {
  let existing: WebviewWindow | null = null;
  try {
    existing = await WebviewWindow.getByLabel(CHAT_LABEL);
  } catch (err) {
    showDebug(`notification-focus getByLabel failed: ${errorText(err)}`);
    return;
  }
  if (!existing) {
    debug("notification-focus: no chat window → skip");
    return;
  }
  const visible = await existing.isVisible().catch(() => true);
  if (visible) return; // 边界①：气泡已显示 → no-op
  debug("notification-focus reveal", 5000);
  markBubbleShown();
  await existing
    .unminimize()
    .catch((err: unknown) => showDebug(`chat unminimize failed: ${errorText(err)}`));
  await existing
    .show()
    .catch((err: unknown) => showDebug(`chat show failed: ${errorText(err)}`));
  await existing
    .setFocus()
    .catch((err: unknown) => showDebug(`chat setFocus failed: ${errorText(err)}`));
  reassertPetOnTop();
}

// v1.2 Task 3：气泡任一显示路径（创建 / 点猫 show / 通知 reveal）都要盖闩，
// 通知后 60s 内的再次激活才不会重复弹。
function markBubbleShown(): void {
  bubbleShownSinceNotification = true;
}

// ===== Sessions panel window (v1.2 Task 4) =====

// Right-click on the pet toggles the sessions panel. Lifecycle copies the
// chat mode (acceptance-fix-9): the webview is created visible and never
// destroyed — toggle = hidden ? show : hide, no page reload either way. The
// panel closes itself via ×/Esc or light-dismiss (acceptance-fix-14: armed
// blur → hidePanel), and the 350ms toggle grace below absorbs the race where
// that blur self-hide lands before this side's visibility probe.

// 轻量兜底（chat 窗 round-6 连点双开 bug 的同款最小防线）：两次快速右键不
// 得在同一个 "sessions" label 下启动两个 webview。不照搬 chat 的整条串行
// 链——面板无 spawn/进程耦合，in-flight 旗标足够盖住创建竞态。
let sessionsCreateInFlight = false;
// 面板失焦时刻镜像（必修 2）：sessions 的 light-dismiss（fix-14）会自己
// hide——「面板可见且持焦时右键猫」的竞态里，失焦 hidePanel 的 IPC 可能先
// 于 toggle 的 isVisible 探测落盘（探测得 false → 走 show → 右键收起变成
// 重新弹出）。pet 侧镜像盖 sessionsClosedAt，hidden 分支加同款 350ms 宽限
//（共用 chat 的 CHAT_REOPEN_GRACE_MS 常量），输方不得立即 re-show。
let sessionsClosedAt = 0;

// Fresh-panel data line: the pet window re-pushes its stored snapshot to a
// newly created panel. created 派发时新页面的 listen 尚未注册——front-loaded
// 补发（同 emitChatHistory 的 100/250/500/1000/2000ms 节拍）桥接这个空窗，
// 早到的投递被安全丢弃；面板 clear-then-redraw，重复投递无害。没有快照
// （应用刚起、首 tick 未到）则跳过——轮询器 ≤2s 后自然接管。
function emitSessionsSnapshotCatchUp(): void {
  if (!latestSessions) return;
  const push = (): void => {
    void emit("sessions-snapshot", latestSessions).catch((err: unknown) =>
      console.error("sessions-snapshot re-emit failed:", err),
    );
  };
  push();
  for (const delayMs of [100, 250, 500, 1000, 2000]) {
    setTimeout(push, delayMs);
  }
}

async function toggleSessionsWindow(): Promise<void> {
  let existing: WebviewWindow | null = null;
  try {
    existing = await WebviewWindow.getByLabel(SESSIONS_LABEL);
  } catch (err) {
    // Keep going: fall through to the open path below.
    showDebug(`sessions getByLabel failed: ${errorText(err)}`);
  }
  if (existing) {
    // Hide/show lifecycle: visibility probe failure counts as hidden — the
    // toggle then shows (worst case a redundant show, never a stuck panel).
    const visible = await existing.isVisible().catch(() => false);
    if (visible) {
      debug("sessions visible → hide (toggle)", 5000);
      sessionsClosedAt = Date.now();
      await existing
        .hide()
        .catch((err: unknown) => showDebug(`sessions hide failed: ${errorText(err)}`));
      return;
    }
    if (Date.now() - sessionsClosedAt < CHAT_REOPEN_GRACE_MS) {
      // The blur self-hide beat this right-click to it — the toggle already
      // happened via the light-dismiss path; do not instantly re-show.
      debug("sessions just hid (blur race) → stay hidden", 5000);
      return;
    }
    debug("sessions hidden → show", 5000);
    await existing
      .unminimize()
      .catch((err: unknown) => showDebug(`sessions unminimize failed: ${errorText(err)}`));
    await existing
      .show()
      .catch((err: unknown) => showDebug(`sessions show failed: ${errorText(err)}`));
    await existing
      .setFocus()
      .catch((err: unknown) => showDebug(`sessions setFocus failed: ${errorText(err)}`));
    reassertPetOnTop();
    return;
  }
  if (sessionsCreateInFlight) {
    debug("sessions create already in flight → skip", 5000);
    return;
  }
  debug("creating sessions window…");
  sessionsCreateInFlight = true;
  const { x, y } = await positionNearPet(SESSIONS_WIDTH, SESSIONS_HEIGHT);
  // Same constructor options as the chat bubble (alwaysOnTop / skipTaskbar /
  // visibleOnAllWorkspaces / acceptFirstMouse); created visible by default.
  const sessions = new WebviewWindow(SESSIONS_LABEL, {
    url: "sessions.html",
    x,
    y,
    width: SESSIONS_WIDTH,
    height: SESSIONS_HEIGHT,
    decorations: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    visibleOnAllWorkspaces: true,
    acceptFirstMouse: true,
  });
  // Instance outcome handlers (see the chat block: these two are "local"
  // events dispatched only to handlers registered on the instance; without
  // them a failed create is swallowed silently).
  void sessions.once("tauri://created", () => {
    sessionsCreateInFlight = false;
    setDebugLine("sessions window created", 5000);
    emitSessionsSnapshotCatchUp();
    // Two alwaysOnTop windows stack by creation order — re-assert the pet's
    // level so the cat stays above the panel (same as the chat window).
    reassertPetOnTop();
  });
  void sessions.once("tauri://error", (e) => {
    sessionsCreateInFlight = false;
    showDebug(`sessions window error: ${errorText(e.payload)}`);
  });
  // Blur mirror (必修 2): every panel blur stamps sessionsClosedAt so the
  // toggle's grace can tell "hidden by this very right-click's blur" from
  // "hidden earlier". Same mechanism as the chat window's chatClosedAt.
  void sessions.onFocusChanged(({ payload: focused }) => {
    if (!focused) sessionsClosedAt = Date.now();
  });
}

// v1.2 Task 4: 右键呼出/收起面板。与左键互不干扰的结构性保证：左键的
// click/drag 状态机在 setupPointerInteractions 里对 mousedown/mouseup 都有
// `e.button === 0` 门——右键按下根本不会进入该状态机；contextmenu 是独立
// 事件（macOS WebKit 仅 button 2 触发），两条通路无共享可变状态。唯一例外
// 是左键拖拽进行中——此时右键保持惰性（不 preventDefault 之外的任何动作），
// 两个手势互不劫持。
function setupSessionsToggle(): void {
  document.addEventListener("contextmenu", (e: MouseEvent) => {
    e.preventDefault(); // 桌宠不弹系统右键菜单
    if (dragging) return; // 左键拖拽进行中：右键不做事
    // 必修 3：右键呼面板同样是「用户在与宠交互」——通知后 60s 的聚焦启发
    // 式不该再自动弹气泡（否则呼面板会连带弹出聊天）。先盖闩再 toggle：
    // contextmenu 是同步 DOM 事件，几乎必然先于异步的 focus IPC 落地。
    bubbleShownSinceNotification = true;
    toggleSessionsWindow().catch((err: unknown) =>
      showDebug(`toggleSessionsWindow failed: ${errorText(err)}`),
    );
  });
}

// 全局错误钩子（round 5）：未捕获异常/拒绝以前只进控制台、静默丢失——
// 现在也上 debug line 并落日志，× 关闭失灵这类问题才留得下时间线证据。
function setupGlobalErrorHooks(): void {
  window.addEventListener("error", (e) => {
    showDebug(`window error: ${e.message}`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    showDebug(`unhandled rejection: ${errorText(e.reason)}`);
  });
}

// ===== Self-drawn drag (v1.3 Task 2) =====

// startDragging（原生窗口拖拽）已移除，改为自绘：mousemove 越阈值后每帧
// cursorPosition() → pos = cursor + grabOffset → clampDrag → setPosition。
// 好处：钳制逻辑归我们管（猫可以贴住菜单栏下缘、永远留屏内 ≥48px），
// 而原生 startDragging 把几何全交给 OS、管不到。

// 事件连续性依据：AppKit 把 mouse-moved/dragged 投递给 key 窗口、即使光标
// 越出窗口边界——拖拽中 pet 窗必为 key，事件流不会断。保险丝：onFocusChanged
// 在拖拽中失焦 → 立即结束拖拽（见 setupListeners），防止事件流意外中断时
// 手势状态卡死（rAF 永远跟光标走）。
const DRAG_VISIBLE_MARGIN_PX = 48; // 猫离屏前至少保留的可见像素（左/右/底）
const MONITOR_BOUNDS_REFRESH_MS = 500; // 拖拽中显示器可见区的刷新周期（跨屏）
const MENUBAR_FALLBACK_LOGICAL_PX = 24; // workArea 缺失时的菜单栏常高兜底

let dragGrabOffset: Physical | null = null; // mousedown 时一次性（物理 px）
// 窗口外框物理尺寸：tauri.conf 的 288×312 是逻辑 px，Retina 屏上物理外框
// 是它的 scaleFactor 倍——钳制输入必须同单位，开拖时用 outerSize() 实测。
let dragWinSize: { width: number; height: number } | null = null;
let dragBounds: MonitorBounds | null = null; // mousedown 取一次，拖拽中定期刷新
let lastBoundsRefreshAt = 0;
let dragRafId: number | null = null;
// 帧去重（v1.2 Task 2 精灵帧去重同思路）：按住不动时目标位置不变，
// 不再每帧空转一次 setPosition IPC（60Hz ≈ 3600 次/分的恒等写）。
let dragLastApplied: Physical | null = null;
// 抓取竞态令牌：取回 cursorPosition/outerPosition 前用户可能已松手甚至再次
// 按下——陈旧请求的结果不得写进新一轮拖拽的状态。
let dragToken = 0;

// currentMonitor() → 拖拽钳制用的可见区矩形（物理 px）。主路 workArea =
// NSScreen.visibleFrame（菜单栏下缘为顶；tauri-runtime-wry 的 MonitorExt
// 在 macOS 上正是这么算的）。workArea 缺失/退化时按简报裁决回退：完整
// bounds − 菜单栏常高（~24 逻辑 px × scaleFactor）。currentMonitor() 返回
// null（无法探测）→ 巨大矩形等价于不钳：宁可不钳，也不把猫锁进错误区域。
function monitorVisibleBounds(mon: Monitor | null): MonitorBounds {
  if (mon) {
    const wa = mon.workArea as
      | { position?: Physical; size?: { width: number; height: number } }
      | undefined;
    if (wa?.position && wa.size && wa.size.width > 0 && wa.size.height > 0) {
      return {
        x: wa.position.x,
        y: wa.position.y,
        width: wa.size.width,
        height: wa.size.height,
      };
    }
    const top = Math.round(MENUBAR_FALLBACK_LOGICAL_PX * mon.scaleFactor);
    return {
      x: mon.position.x,
      y: mon.position.y + top,
      width: mon.size.width,
      height: Math.max(1, mon.size.height - top),
    };
  }
  return { x: -10_000_000, y: -10_000_000, width: 20_000_000, height: 20_000_000 };
}

// 每帧一次：rAF 合并 mousemove。self-pacing——本帧 setPosition 落盘后才排
// 下一帧，IPC 不堆叠；快速拖动丢帧可接受（简报档位），窗口不丢。
function dragTick(): void {
  if (!dragging) {
    dragRafId = null;
    return;
  }
  void (async () => {
    // 可见区每 ~500ms 刷新：跨屏拖动时猫跟着新屏的 workArea/菜单栏走
    if (Date.now() - lastBoundsRefreshAt >= MONITOR_BOUNDS_REFRESH_MS) {
      lastBoundsRefreshAt = Date.now();
      const mon = await currentMonitor().catch(() => null);
      if (dragging) dragBounds = monitorVisibleBounds(mon);
    }
    if (dragGrabOffset && dragWinSize && dragBounds) {
      const cursor = await cursorPosition();
      if (!dragging) return;
      // 刚性拖拽不变量：origin_new = cursor_new − (cursor₀ − origin₀)，
      // 抓取点相对屏幕不动——公式是「减」，加号会让首帧瞬移 2×grabOffset。
      const target = clampDrag(
        { x: cursor.x - dragGrabOffset.x, y: cursor.y - dragGrabOffset.y },
        dragWinSize.width,
        dragWinSize.height,
        dragBounds,
        DRAG_VISIBLE_MARGIN_PX,
      );
      if (
        !dragLastApplied ||
        dragLastApplied.x !== target.x ||
        dragLastApplied.y !== target.y
      ) {
        await getCurrentWindow().setPosition(new PhysicalPosition(target.x, target.y));
        dragLastApplied = target; // 落账在成功之后：reject 不记，瞬态失败不丢帧
      }
    }
  })()
    .catch((err: unknown) => console.error("drag frame failed:", err))
    .finally(() => {
      if (dragging) {
        dragRafId = requestAnimationFrame(dragTick);
      } else {
        dragRafId = null;
      }
    });
}

function ensureDragLoop(): void {
  if (dragRafId === null) {
    dragRafId = requestAnimationFrame(dragTick);
  }
}

// 越阈值（dist > 4）时进入自绘拖拽。同步置 dragging = true：命中探针的
// 手势钉（applyHitTesting 在 pointerPressed||dragging 时不穿透）当场生效，
// 且同一按下周期不会重复进入。抓取偏移异步补齐，取回前的帧直接跳过落窗。
function beginSelfDrawnDrag(): void {
  if (dragging) return;
  dragging = true;
  const token = ++dragToken;
  const win = getCurrentWindow();
  // 竞态取舍（报告已注明）：cursorPosition 与 outerPosition 异步取回前
  // 光标可能已移动——以「取回时刻」的差值为准，从取回那一刻起抓取点跟随
  // 光标（窗位 = 光标 − 抓取偏移），不试图回放按下瞬间的几何。
  void (async () => {
    const [cursor, origin, size] = await Promise.all([
      cursorPosition(),
      win.outerPosition(),
      win.outerSize(),
    ]);
    if (!dragging || token !== dragToken) return;
    dragGrabOffset = grabOffset(cursor, origin);
    dragWinSize = { width: size.width, height: size.height };
  })().catch((err: unknown) => {
    // 抓取失败 → 拖拽作废回安全态：宁可拖不动，不可手势卡死
    console.error("drag begin failed:", err);
    if (token === dragToken) endSelfDrawnDrag();
  });
  dragBounds = null;
  dragWinSize = null;
  dragLastApplied = null; // 与 end 对称：新拖拽的帧去重从零开始
  lastBoundsRefreshAt = 0;
  ensureDragLoop();
}

function endSelfDrawnDrag(): void {
  dragging = false;
  dragGrabOffset = null;
  dragWinSize = null;
  dragBounds = null;
  dragLastApplied = null;
  if (dragRafId !== null) {
    cancelAnimationFrame(dragRafId);
    dragRafId = null;
  }
}

// Attach pointer-based drag/click detection to the whole document.
// mousedown records origin; mousemove past the threshold enters the
// self-drawn drag (fired exactly once per press); mouseup that never dragged
// and stays within thresholds counts as a click on the pet.
function setupPointerInteractions(): void {
  let x0 = 0;
  let y0 = 0;
  let t0 = 0;

  document.addEventListener("mousedown", (e: MouseEvent) => {
    if (e.button !== 0) return;
    pointerPressed = true;
    dragging = false;
    x0 = e.clientX;
    y0 = e.clientY;
    t0 = performance.now();
  });

  document.addEventListener("mousemove", (e: MouseEvent) => {
    applyHitTesting(e); // alpha probe runs on every move (see hit-testing block)
    if (!pointerPressed || dragging) return;
    const dist = Math.hypot(e.clientX - x0, e.clientY - y0);
    if (dist > DRAG_THRESHOLD_PX) {
      beginSelfDrawnDrag(); // v1.3 Task 2: 自绘拖拽取代 startDragging
    }
  });

  document.addEventListener("mouseup", (e: MouseEvent) => {
    if (!pointerPressed) return;
    pointerPressed = false;
    if (!dragging && e.button === 0) {
      const dist = Math.hypot(e.clientX - x0, e.clientY - y0);
      const dt = performance.now() - t0;
      if (dist <= DRAG_THRESHOLD_PX && dt < CLICK_MAX_MS) {
        onClickPet().catch((err: unknown) =>
          showDebug(`onClickPet failed: ${errorText(err)}`),
        );
      }
    }
    endSelfDrawnDrag(); // 停 rAF + 清拖拽态（click 判定零改动）
  });
}

// Load pet.json + settings once, then mount with the configured skin.
async function init(): Promise<void> {
  // petSkin 来自 settings（load 侧已把空/空白归一化 "default"）；读取失败
  // 不挡挂载——退默认皮肤（resolveSheetPath 三级回退到根 spritesheetPath）。
  const settings = await invoke<{ petSkin?: string; pet_zoom?: number }>("get_settings").catch(
    (err: unknown) => {
      console.error("get_settings failed, using default skin:", err);
      return null;
    },
  );
  // Pet zoom comes from the same settings blob; set the state BEFORE mount
  // so the freshly created element is born at the persisted scale.
  applyPetZoom(settings?.pet_zoom ?? 1.0);
  await mountPet(settings?.petSkin);
}

// (Re)load the spritesheet for petSkin and restart the sprite animation.
// Startup and every skin-changed pass through here: pet.json is re-fetched
// so a freshly imported skin (import script) needs no app restart, and
// resolveSheetPath falls back to the default skin when the id is unknown.
async function mountPet(petSkin?: string): Promise<void> {
  const { anims: loaded, sheet } = await loadPet(PET_BASE, petSkin);
  anims = loaded;

  if (!petEl) {
    const el = document.createElement("div");
    el.id = "pet";
    el.style.width = `${CELL_W}px`;
    el.style.height = `${CELL_H}px`;
    // Acceptance-fix-12: the window is oversized (288×312); the sprite layer
    // is anchored bottom-center so transform: scale(petZoom) grows it upward
    // from the same floor line without drifting horizontally.
    el.style.left = `${ELEM_X}px`;
    el.style.top = `${ELEM_Y}px`;
    el.style.transformOrigin = "center bottom";
    el.style.transform = `scale(${petZoom})`;
    el.style.backgroundSize = `${SHEET_W}px ${SHEET_H}px`;
    el.style.backgroundRepeat = "no-repeat";
    el.style.imageRendering = "pixelated";
    document.body.appendChild(el);
    petEl = el;
  }
  petEl.style.backgroundImage = `url(${sheet})`;

  // 皮肤切换后蒙版跟手：仅当 sheet 实际变了才重解码（启动路径与底部的
  // 独立 loadAlphaMask() 同 URL 时不会二次 fetch）。
  if (alphaMaskUrl !== sheet) {
    void loadAlphaMask(sheet);
  }

  playAnimation(sessionAnimName); // 重启精灵动画（换肤即时生效）
}

setupGlobalErrorHooks();
setupListeners();
setupChatLog();
setupChatWindowListeners();
setupPointerInteractions();
setupSessionsToggle(); // v1.2 Task 4: 右键猫 → toggle 会话面板
setupSpriteLifecycle(); // v1.2 Task 2: hidden → pause rAF, visible → resume at elapsed 0
setupSpriteWriteTelemetry(); // v1.2 Task 2: 60s write-count self-check → debug.log
// 独立的 loadAlphaMask() 启动调用已并入 mountPet：蒙版跟随实际挂载的
// spritesheet（含换肤后的新图），pet.json 读不出时蒙版本就无处可用。
init().catch((err) => showDebug(`failed to load pet: ${errorText(err)}`));
