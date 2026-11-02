import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { currentMonitor, cursorPosition, getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
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
import { frameAt, loadPet, offsetFor, type AnimationDef } from "./sprite";

const PET_BASE = "/pet";
const CELL_W = 192;
const CELL_H = 208;
const SHEET_W = CELL_W * 8; // 1536px — spritesheet grid is 8 columns
const SHEET_H = CELL_H * 4; // 832px — spritesheet grid is 4 rows

const DRAG_THRESHOLD_PX = 4; // movement beyond this starts a window drag
const CLICK_MAX_MS = 400; // presses longer than this never count as a click

const CHAT_LABEL = "chat";
const CHAT_WIDTH = 340;
const CHAT_HEIGHT = 420;
const CHAT_GAP_PX = 8; // clearance between pet and bubble

// Light-dismiss (acceptance round 5): both close paths — the bubble's own
// blur-close and the pet's toggle-close — stamp chatClosedAt; a pet click
// inside the grace window right after a close is ignored, so the losing
// side of the blur/toggle race cannot instantly reopen the bubble.
const CHAT_REOPEN_GRACE_MS = 350;
let chatClosedAt = 0;

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
let sessionAnimName = "idle"; // driven by session-status events
// The sprite cell currently on screen (alpha hit testing reads this).
let curFrame = { row: 0, col: 0 };

function playAnimation(name: string): void {
  const anim = anims.find((a: AnimationDef) => a.name === name);
  if (!anim || !petEl) {
    console.error(`animation "${name}" not found in pet.json`);
    return;
  }
  const token = ++rafToken;
  const durationMs = anim.loop ? Infinity : (anim.frames / anim.fps) * 1000;
  let start: number | null = null;
  const tick = (now: number): void => {
    if (!petEl || token !== rafToken) return; // superseded by a newer play
    if (start === null) start = now;
    const elapsed = now - start;
    if (elapsed >= durationMs) {
      playAnimation(sessionAnimName); // one-shot finished → session state
      return;
    }
    const col = frameAt(anim, elapsed);
    petEl.style.backgroundPosition = offsetFor(anim.row, col);
    curFrame = { row: anim.row, col };
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ===== Pixel-accurate hit testing (acceptance round 2) =====

// Clicks on transparent pixels should fall through to the desktop — only the
// cat's body is interactive. The spritesheet's alpha channel is the mask: the
// full sheet is decoded once, and each mousemove probes the alpha of the
// sprite cell currently on screen at the cursor position.
const ALPHA_THRESHOLD = 16; // 0–255; below → transparent → ignore mouse

let sheetAlpha: Uint8ClampedArray | null = null; // RGBA of the whole sheet
let ignoringMouse = false;
let dragging = false; // hoisted so the hit-test probe can pin non-ignore

async function loadAlphaMask(): Promise<void> {
  try {
    const res = await fetch(`${PET_BASE}/spritesheet.png`);
    const bitmap = await createImageBitmap(await res.blob());
    const canvas = document.createElement("canvas");
    canvas.width = SHEET_W;
    canvas.height = SHEET_H;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");
    ctx.drawImage(bitmap, 0, 0);
    sheetAlpha = ctx.getImageData(0, 0, SHEET_W, SHEET_H).data;
  } catch (err) {
    // No mask → hit testing stays off entirely (window behaves as before).
    showDebug(`alpha mask load failed: ${errorText(err)}`);
  }
}

// Logical cursor position → alpha of the on-screen sprite pixel. The pet
// element spans the whole 192×208 window, so client coords are element
// coords; the fractional position maps into the current cell of the sheet.
function alphaAt(x: number, y: number): number {
  if (!sheetAlpha) return 255; // no mask → treat everything as opaque
  const fx = x / CELL_W;
  const fy = y / CELL_H;
  if (fx < 0 || fx >= 1 || fy < 0 || fy >= 1) return 0;
  const px = Math.min(SHEET_W - 1, Math.floor((curFrame.col + fx) * CELL_W));
  const py = Math.min(SHEET_H - 1, Math.floor((curFrame.row + fy) * CELL_H));
  return sheetAlpha[(py * SHEET_W + px) * 4 + 3];
}

let ignorePollTimer: number | null = null;

function stopIgnorePoll(): void {
  if (ignorePollTimer !== null) {
    clearInterval(ignorePollTimer);
    ignorePollTimer = null;
  }
}

// While ignored the webview receives NO events (tauri v2's
// setIgnoreCursorEvents has no forward option), so a low-frequency poll
// watches the global cursor and flips back to non-ignore as soon as it
// re-enters the cat's opaque pixels.
function startIgnorePoll(): void {
  if (ignorePollTimer !== null) return;
  const win = getCurrentWindow();
  ignorePollTimer = window.setInterval(() => {
    if (!ignoringMouse) {
      stopIgnorePoll();
      return;
    }
    void (async () => {
      const [cursor, origin, sf] = await Promise.all([
        cursorPosition(),
        win.outerPosition(),
        win.scaleFactor(),
      ]);
      const lx = (cursor.x - origin.x) / sf;
      const ly = (cursor.y - origin.y) / sf;
      if (ignoringMouse && alphaAt(lx, ly) >= ALPHA_THRESHOLD) {
        setIgnoreMouse(false);
      }
    })().catch((err: unknown) => {
      // Fail open: any probe failure returns the window to clickable.
      console.error("ignore poll failed:", err);
      setIgnoreMouse(false);
    });
  }, 100);
}

function setIgnoreMouse(ignore: boolean): void {
  if (ignoringMouse === ignore) return; // only flip on state change
  ignoringMouse = ignore;
  if (ignore) startIgnorePoll();
  else stopIgnorePoll();
  getCurrentWindow()
    .setIgnoreCursorEvents(ignore)
    .catch((err: unknown) => {
      // Fail open: permission/IPC failure must not leave the pet unclickable.
      console.error("setIgnoreCursorEvents failed:", err);
      ignoringMouse = false;
      stopIgnorePoll();
    });
}

// forward:true keeps mouse-MOVE events arriving while ignored, so the probe
// can flip back to non-ignore as soon as the cursor is over the cat again.
// While dragging, pin non-ignore (a drag must never lose its window).
function applyHitTesting(e: MouseEvent): void {
  if (!sheetAlpha) return;
  if (dragging) {
    setIgnoreMouse(false);
    return;
  }
  setIgnoreMouse(alphaAt(e.clientX, e.clientY) < ALPHA_THRESHOLD);
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

// Session-context formatting (acceptance round 4) — projectOf /
// formatDuration / truncateForNotification live in format.ts (test-infra L1
// extraction), pure helpers shared with chat.ts.

function setupListeners(): void {
  void listen<SessionStatusPayload>("session-status", (e) => {
    sessionAnimName = e.payload.working ? "working" : "idle";
    playAnimation(sessionAnimName);
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
        debug("notification sent");
      } else {
        debug("notification skipped: permission not granted");
      }
    })().catch((err: unknown) => showDebug(`notification failed: ${errorText(err)}`));
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
  // 保留，随该回合 done 正常落一条 assistant。
  void listen("chat-clear-history", () => {
    chatLog.length = 0;
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

  // Preferred spot: centered above the pet with an 8px gap. All geometry is
  // computed in LOGICAL pixels: outerPosition/outerSize/monitor metrics come
  // back in physical pixels while the constructor options are logical —
  // round 1 mixed the two and the bubble landed half off-screen.
  // Each probe reports its own failure — a silent `catch(() => null)` here
  // would leave the chain hanging with no visible trace.
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
    x = Math.round(petL.x + (petL.w - CHAT_WIDTH) / 2);
    y = Math.round(petL.y - CHAT_GAP_PX - CHAT_HEIGHT);
    if (mon) {
      const monL = {
        x: mon.position.x / sf,
        y: mon.position.y / sf,
        w: mon.size.width / sf,
        h: mon.size.height / sf,
      };
      if (y < monL.y) {
        // no headroom above → try to the right of the pet
        x = Math.round(petL.x + petL.w + CHAT_GAP_PX);
        y = Math.round(petL.y);
        if (x + CHAT_WIDTH > monL.x + monL.w) {
          // right overflows → try to the left of the pet
          x = Math.round(petL.x - CHAT_WIDTH - CHAT_GAP_PX);
        }
      }
      // final clamp into the monitor; without a monitor skip it entirely
      x = Math.min(Math.max(x, monL.x), monL.x + monL.w - CHAT_WIDTH);
      y = Math.min(Math.max(y, monL.y), monL.y + monL.h - CHAT_HEIGHT);
    }
  }

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

// Attach pointer-based drag/click detection to the whole document.
// mousedown records origin; mousemove past the threshold hands off to the
// native window drag (fired exactly once per press); mouseup that never
// dragged and stays within thresholds counts as a click on the pet.
function setupPointerInteractions(): void {
  let pressed = false;
  let x0 = 0;
  let y0 = 0;
  let t0 = 0;

  document.addEventListener("mousedown", (e: MouseEvent) => {
    if (e.button !== 0) return;
    pressed = true;
    dragging = false;
    x0 = e.clientX;
    y0 = e.clientY;
    t0 = performance.now();
  });

  document.addEventListener("mousemove", (e: MouseEvent) => {
    applyHitTesting(e); // alpha probe runs on every move (see hit-testing block)
    if (!pressed || dragging) return;
    const dist = Math.hypot(e.clientX - x0, e.clientY - y0);
    if (dist > DRAG_THRESHOLD_PX) {
      dragging = true;
      getCurrentWindow()
        .startDragging()
        .catch((err) => console.error("startDragging failed:", err));
    }
  });

  document.addEventListener("mouseup", (e: MouseEvent) => {
    if (!pressed) return;
    pressed = false;
    if (!dragging && e.button === 0) {
      const dist = Math.hypot(e.clientX - x0, e.clientY - y0);
      const dt = performance.now() - t0;
      if (dist <= DRAG_THRESHOLD_PX && dt < CLICK_MAX_MS) {
        onClickPet().catch((err: unknown) =>
          showDebug(`onClickPet failed: ${errorText(err)}`),
        );
      }
    }
    dragging = false;
  });
}

async function init(): Promise<void> {
  const { anims: loaded, sheet } = await loadPet(PET_BASE);
  anims = loaded;

  const el = document.createElement("div");
  el.id = "pet";
  el.style.width = `${CELL_W}px`;
  el.style.height = `${CELL_H}px`;
  el.style.backgroundImage = `url(${sheet})`;
  el.style.backgroundSize = `${SHEET_W}px ${SHEET_H}px`;
  el.style.backgroundRepeat = "no-repeat";
  el.style.imageRendering = "pixelated";
  document.body.appendChild(el);
  petEl = el;

  playAnimation(sessionAnimName);
}

setupGlobalErrorHooks();
setupListeners();
setupChatLog();
setupChatWindowListeners();
setupPointerInteractions();
init().catch((err) => showDebug(`failed to load pet: ${errorText(err)}`));
void loadAlphaMask(); // independent of pet.json; failure keeps old behavior
