import { frameAt, loadPet, offsetFor, type AnimationDef } from "./sprite";

const PET_BASE = "/pet";
const CELL_W = 192;
const CELL_H = 208;
const SHEET_W = CELL_W * 8; // 1536px — spritesheet grid is 8 columns
const SHEET_H = CELL_H * 4; // 832px — spritesheet grid is 4 rows

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

playIdle().catch((err) => console.error("failed to load pet:", err));
