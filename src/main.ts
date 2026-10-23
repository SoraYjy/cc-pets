import { getCurrentWindow } from "@tauri-apps/api/window";
import { frameAt, loadPet, offsetFor, type AnimationDef } from "./sprite";

const PET_BASE = "/pet";
const CELL_W = 192;
const CELL_H = 208;
const SHEET_W = CELL_W * 8; // 1536px — spritesheet grid is 8 columns
const SHEET_H = CELL_H * 4; // 832px — spritesheet grid is 4 rows

const DRAG_THRESHOLD_PX = 4; // movement beyond this starts a window drag
const CLICK_MAX_MS = 400; // presses longer than this never count as a click

function onClickPet(): void {
  console.log("pet clicked");
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

async function playIdle(): Promise<void> {
  const { anims, sheet } = await loadPet(PET_BASE);

  const el = document.createElement("div");
  el.id = "pet";
  el.style.width = `${CELL_W}px`;
  el.style.height = `${CELL_H}px`;
  el.style.backgroundImage = `url(${sheet})`;
  el.style.backgroundSize = `${SHEET_W}px ${SHEET_H}px`;
  el.style.backgroundRepeat = "no-repeat";
  el.style.imageRendering = "pixelated";
  document.body.appendChild(el);

  const idle = anims.find((a: AnimationDef) => a.name === "idle");
  if (!idle) {
    console.error("idle animation not found in pet.json");
    return;
  }

  let start: number | null = null;
  const tick = (now: number) => {
    if (start === null) start = now;
    const frame = frameAt(idle, now - start);
    el.style.backgroundPosition = offsetFor(idle.row, frame);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

setupPointerInteractions();
playIdle().catch((err) => console.error("failed to load pet:", err));
