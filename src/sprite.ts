export interface AnimationDef {
  name: string;
  row: number;
  frames: number;
  fps: number;
  loop: boolean;
}

export function frameAt(anim: AnimationDef, elapsedMs: number): number {
  const frame = Math.floor((elapsedMs / 1000) * anim.fps);
  return anim.loop ? frame % anim.frames : Math.min(frame, anim.frames - 1);
}

function axisOffset(cellPx: number): string {
  const offset = -cellPx;
  // Avoid "-0px" — JS stringifies negative zero with the minus sign.
  return offset === 0 ? "0px" : `${offset}px`;
}

export function offsetFor(row: number, col: number, cellW = 192, cellH = 208): string {
  return `${axisOffset(col * cellW)} ${axisOffset(row * cellH)}`;
}

export interface Pet {
  anims: AnimationDef[];
  sheet: string;
}

export async function loadPet(baseUrl: string): Promise<Pet> {
  const res = await fetch(`${baseUrl}/pet.json`);
  if (!res.ok) {
    throw new Error(`Failed to load pet.json from ${baseUrl}: ${res.status}`);
  }
  const json = await res.json();
  return { anims: json.animations, sheet: `${baseUrl}/${json.spritesheetPath}` };
}
