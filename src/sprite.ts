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

// 帧去重判定（v1.2 Task 2 CPU 优化，纯函数）：prev 为 null 表示本链尚未写
// 过任何样式（playAnimation 新闭包的起点，换动画/换肤即重置），必须首写；
// row 或 col 任一变化才需要再写。rAF tick 用它把「每 tick 一次 style 写」
// 降为「每帧变化一次」。
export function shouldWriteFrame(
  prev: { row: number; col: number } | null,
  next: { row: number; col: number },
): boolean {
  return prev === null || prev.row !== next.row || prev.col !== next.col;
}

// 命中判定（纯函数，验收修复「可点击区域大于形象」）：busy（按下/拖拽进行
// 中）恒 false——手势中途翻穿透会吃掉后续 mouseup/拖不动窗口；其余按 alpha
// 与阈值判定，低于阈值的透明像素 → 穿透。
export function decideCursorIgnore(
  alpha: number,
  busy: boolean,
  threshold: number,
): boolean {
  return busy ? false : alpha < threshold;
}

// 皮肤内「真实猫头」顶部留白（「拉不到顶」实修）：精灵格顶到该皮肤实际
// 不透明像素的最小距离（cell 像素、zoom=1 口径），跨全部帧取最小——钳制
// 线贴真实猫头而非格顶，皮肤内留白不再吃掉贴顶高度。全透明数据 → 0。
export function cellTopWhitespace(
  data: Uint8ClampedArray | Uint8Array,
  sheetW: number,
  cellH: number,
  threshold: number,
): number {
  let minOffset = Infinity;
  const rows = Math.floor(data.length / 4 / sheetW);
  for (let y = 0; y < rows; y++) {
    const base = y * sheetW * 4;
    let opaque = false;
    for (let x = 0; x < sheetW; x++) {
      if (data[base + x * 4 + 3] >= threshold) {
        opaque = true;
        break;
      }
    }
    if (opaque) {
      const off = y % cellH;
      if (off < minOffset) minOffset = off;
    }
  }
  return minOffset === Infinity ? 0 : minOffset;
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

// pet.json 的 skins 映射条目（v1.2 多皮肤）。所有皮肤共用同一网格规格，
// 只有 spritesheet 图不同。
export interface SkinDef {
  spritesheetPath: string;
  displayName: string;
}

// 皮肤解析（纯函数，v1.2）：skins[petSkin] → skins.default → 根
// spritesheetPath 三级回退。petSkin 不在 skins 集（手改 settings.json / 皮肤
// 被删）或为空 → 回 default；连 skins 映射都没有（旧版单皮肤）→ 回根路径。
export function resolveSheetPath(
  skins: Record<string, SkinDef> | undefined,
  rootPath: string | undefined,
  petSkin: string | undefined,
): string {
  const fromSkin = petSkin ? skins?.[petSkin]?.spritesheetPath : undefined;
  if (fromSkin) return fromSkin;
  const fromDefault = skins?.default?.spritesheetPath;
  if (fromDefault) return fromDefault;
  return rootPath ?? "spritesheet.png";
}

export async function loadPet(baseUrl: string, petSkin?: string): Promise<Pet> {
  const res = await fetch(`${baseUrl}/pet.json`);
  if (!res.ok) {
    throw new Error(`Failed to load pet.json from ${baseUrl}: ${res.status}`);
  }
  const json = await res.json();
  return {
    anims: json.animations,
    sheet: `${baseUrl}/${resolveSheetPath(json.skins, json.spritesheetPath, petSkin)}`,
  };
}
