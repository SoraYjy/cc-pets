import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
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

// Failure path: console.error + debug line.
function showDebug(msg: string): void {
  console.error(msg);
  setDebugLine(msg);
}

// Breadcrumb (fix round 2): informational step marker on the same debug line,
// no console.error — later crumbs overwrite earlier ones, and success tails
// pass a clearAfter so the line empties itself once everything worked.
function debug(msg: string, clearAfterMs?: number): void {
  setDebugLine(msg, clearAfterMs);
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
    petEl.style.backgroundPosition = offsetFor(anim.row, frameAt(anim, elapsed));
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
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
}

function setupListeners(): void {
  void listen<SessionStatusPayload>("session-status", (e) => {
    sessionAnimName = e.payload.working ? "working" : "idle";
    playAnimation(sessionAnimName);
  });

  void listen<TurnCompletePayload>("turn-complete", (e) => {
    playAnimation("done");
    // DESIGN §5.3: the bubble window also shows the result summary. Global
    // broadcast — the chat window (if open) picks it up as a system line.
    void emit("turn-summary", {
      sessionId: e.payload.sessionId,
      summary: e.payload.summary,
    }).catch((err: unknown) => console.error("turn-summary emit failed:", err));
    // macOS gates notifications behind a one-time system authorization:
    // query first, then request when missing. The first turn-complete after
    // install therefore pops the system dialog — expected (acceptance fix:
    // this used to be query-only and silently skipped on denied permission).
    void (async () => {
      let granted = await isPermissionGranted();
      if (!granted) {
        granted = (await requestPermission()) === "granted";
      }
      if (granted) {
        sendNotification({
          title: "任务完成",
          body: e.payload.summary ? e.payload.summary : "查看 Claude Code 终端",
        });
      } else {
        showDebug("通知权限未授予");
      }
    })().catch((err: unknown) => showDebug(`notification failed: ${errorText(err)}`));
  });
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

function onChatWindowCreated(): void {
  if (!chatCreateInFlight) return;
  chatCreateInFlight = false;
  setDebugLine("chat window created", 5000);
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
    debug("chat exists", 5000);
    await existing
      .setFocus()
      .catch((err: unknown) => showDebug(`chat setFocus failed: ${errorText(err)}`));
    return;
  }
  debug("creating chat window…");

  // Preferred spot: centered above the pet with an 8px gap. Clamped into the
  // current monitor; when there is no headroom above, park beside the pet.
  // Each probe reports its own failure — a silent `catch(() => null)` here
  // would leave the chain hanging with no visible trace.
  let x: number | undefined;
  let y: number | undefined;
  const petWin = getCurrentWindow();
  const [petPos, petSize, monitor] = await Promise.all([
    petWin.outerPosition().catch((err: unknown) => {
      showDebug(`outerPosition failed: ${errorText(err)}`);
      return null;
    }),
    petWin.outerSize().catch((err: unknown) => {
      showDebug(`outerSize failed: ${errorText(err)}`);
      return null;
    }),
    currentMonitor().catch((err: unknown) => {
      showDebug(`currentMonitor failed: ${errorText(err)}`);
      return null;
    }),
  ]);
  if (petPos && petSize && monitor) {
    const mon = monitor.position;
    const size = monitor.size;
    x = petPos.x + Math.round((petSize.width - CHAT_WIDTH) / 2);
    y = petPos.y - CHAT_GAP_PX - CHAT_HEIGHT;
    if (y < mon.y) {
      // no headroom above → place to the right of the pet
      x = petPos.x + petSize.width + CHAT_GAP_PX;
      y = petPos.y;
    }
    x = Math.min(Math.max(x, mon.x), mon.x + size.width - CHAT_WIDTH);
    y = Math.min(Math.max(y, mon.y), mon.y + size.height - CHAT_HEIGHT);
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
  });
  void chat.once("tauri://created", () => onChatWindowCreated());
  void chat.once("tauri://error", (e) => onChatWindowError(e.payload));
  // If neither event ever lands, the trail stops here — that absence is the
  // diagnostic signal (e.g. the IPC never settled).
  debug("constructor returned, waiting created/error…");
}

// ===== Click/drag =====

function onClickPet(): void {
  try {
    debug("pet clicked");
    playAnimation("wave");
    openChatWindow().catch((err: unknown) =>
      showDebug(`openChatWindow failed: ${errorText(err)}`),
    );
    // spawn_chat resolves with the child pid (chat.rs: Ok(pid.to_string())).
    invoke<string>("spawn_chat")
      .then((pid) => debug(`spawn_chat ok: ${pid}`, 5000))
      .catch((err: unknown) => showDebug(`spawn_chat failed: ${errorText(err)}`));
  } catch (err) {
    showDebug(`onClickPet failed: ${errorText(err)}`);
  }
}

// Attach pointer-based drag/click detection to the whole document.
// mousedown records origin; mousemove past the threshold hands off to the
// native window drag (fired exactly once per press); mouseup that never
// dragged and stays within thresholds counts as a click on the pet.
function setupPointerInteractions(): void {
  let pressed = false;
  let dragging = false;
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
        onClickPet();
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

setupListeners();
setupChatWindowListeners();
setupPointerInteractions();
init().catch((err) => showDebug(`failed to load pet: ${errorText(err)}`));
