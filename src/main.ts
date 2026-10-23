import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { isPermissionGranted, sendNotification } from "@tauri-apps/plugin-notification";
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
    // Query-only: never request permission here (unsigned dev builds may
    // silently not deliver — accepted, observed in Task 9).
    isPermissionGranted()
      .then((granted) => {
        if (!granted) return;
        sendNotification({
          title: "任务完成",
          body: e.payload.summary ? e.payload.summary : "查看 Claude Code 终端",
        });
      })
      .catch((err) => console.error("notification failed:", err));
  });
}

// ===== Chat bubble window =====

async function openChatWindow(): Promise<void> {
  const existing = await WebviewWindow.getByLabel(CHAT_LABEL);
  if (existing) {
    await existing
      .setFocus()
      .catch((err: unknown) => console.error("chat setFocus failed:", err));
    return;
  }

  // Preferred spot: centered above the pet with an 8px gap. Clamped into the
  // current monitor; when there is no headroom above, park beside the pet.
  let x: number | undefined;
  let y: number | undefined;
  const petWin = getCurrentWindow();
  const [petPos, petSize, monitor] = await Promise.all([
    petWin.outerPosition().catch(() => null),
    petWin.outerSize().catch(() => null),
    currentMonitor().catch(() => null),
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
  chat.once("tauri://error", (e) => console.error("chat window failed to open:", e.payload));
}

// ===== Click/drag =====

function onClickPet(): void {
  playAnimation("wave");
  void openChatWindow();
  invoke("spawn_chat").catch((err: unknown) => console.error("spawn_chat failed:", err));
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
setupPointerInteractions();
init().catch((err) => console.error("failed to load pet:", err));
