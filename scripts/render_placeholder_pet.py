#!/usr/bin/env python3
"""Render a placeholder pixel spritesheet + pet.json + preview.html for "Lynn".

Pure stdlib (zlib + struct for the PNG writer). Idempotent: rerunning
overwrites the outputs in place.

Usage:
    python3 -I scripts/render_placeholder_pet.py            # generate outputs
    python3 -I scripts/render_placeholder_pet.py --ascii R C  # print frame as chars
"""
import argparse
import json
import os
import struct
import zlib

# ---------------------------------------------------------------- constants
GW, GH = 48, 52          # logical grid per frame
SCALE = 4                # pixel scale
COLS, ROWS = 8, 4        # spritesheet layout
ANIMS = [
    {"name": "idle",    "row": 0, "frames": 4, "fps": 3, "loop": True},
    {"name": "working", "row": 1, "frames": 8, "fps": 6, "loop": True},
    {"name": "done",    "row": 2, "frames": 4, "fps": 4, "loop": False},
    {"name": "wave",    "row": 3, "frames": 4, "fps": 5, "loop": False},
]

# palette index -> RGBA
PALETTE = [
    (0, 0, 0, 0),          # 0 . transparent
    (58, 74, 107, 255),    # 1 o outline           #3A4A6B
    (198, 204, 220, 255),  # 2 F fur (silver grey)  #C6CCDC
    (159, 168, 192, 255),  # 3 d fur shade          #9FA8C0
    (233, 237, 245, 255),  # 4 L chest/muzzle light #E9EDF5
    (240, 184, 196, 255),  # 5 p ear inner / nose   #F0B8C4
    (43, 43, 58, 255),     # 6 P eye dot            #2B2B3A
    (255, 255, 255, 255),  # 7 W highlight white
    (248, 200, 200, 255),  # 8 R blush              #F8C8C8
    (242, 185, 59, 255),   # 9 G sparkle gold       #F2B93B
]
CHARS = ".oFdLpPWRG"   # index -> ascii char

O, FUR, DARK, LIGHT, PINK = 1, 2, 3, 4, 5
PUPIL, WHITE, BLUSH, GOLD = 6, 7, 8, 9

# ------------------------------------------------------------- grid helpers
def new_grid():
    return [[0] * GW for _ in range(GH)]


def clone(g):
    return [row[:] for row in g]


def px(g, x, y, c):
    if 0 <= x < GW and 0 <= y < GH:
        g[y][x] = c


def get(g, x, y):
    if 0 <= x < GW and 0 <= y < GH:
        return g[y][x]
    return 0


def hline(g, x0, x1, y, c):
    for x in range(min(x0, x1), max(x0, x1) + 1):
        px(g, x, y, c)


def vline(g, x, y0, y1, c):
    for y in range(min(y0, y1), max(y0, y1) + 1):
        px(g, x, y, c)


def rect(g, x0, y0, x1, y1, c):
    for y in range(y0, y1 + 1):
        hline(g, x0, x1, y, c)


def disc(g, cx, cy, r, c):
    """Filled disc (any pixel whose center is within r of cx,cy)."""
    r2 = (r + 0.5) ** 2
    for y in range(cy - r, cy + r + 1):
        for x in range(cx - r, cx + r + 1):
            if (x - cx) ** 2 + (y - cy) ** 2 <= r2:
                px(g, x, y, c)


def replace_in(g, x0, y0, x1, y1, old, new):
    for y in range(max(0, y0), min(GH, y1 + 1)):
        for x in range(max(0, x0), min(GW, x1 + 1)):
            if g[y][x] == old:
                g[y][x] = new


def shift_region(g, y0, y1, dy, x0=0, x1=GW - 1):
    """Shift grid rows [y0..y1] (within columns x0..x1) vertically by dy."""
    if dy == 0:
        return
    src = clone(g)
    for y in range(y0, y1 + 1):
        sy = y - dy
        for x in range(x0, x1 + 1):
            g[y][x] = src[sy][x] if y0 <= sy <= y1 else 0


def auto_outline(g, silhouette):
    """Set outline color on transparent cells 4-adjacent to silhouette cols."""
    snap = clone(g)
    for y in range(GH):
        for x in range(GW):
            if snap[y][x] != 0:
                continue
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                if get(snap, x + dx, y + dy) in silhouette:
                    g[y][x] = O
                    break

# ------------------------------------------------------------ base frame art
SILHOUETTE = {FUR, DARK, LIGHT, PINK}

EAR_L = (13, 21, 0, 8, 17)    # x0, x1, y_apex, y_base, apex_x
EAR_R = (25, 33, 0, 8, 29)
EYE_Y = 20                    # top row of the 2x3 dot eyes
EYE_LX, EYE_RX = 16, 29       # left column of each eye

TAIL_PATH = ((32, 36), (35, 38), (38, 41), (41, 44), (43, 47))
TAIL_TIP = (44, 50)           # dark tip disc, curled to the lower corner


def triangle(g, x0, x1, y_base, y_apex, apex_x, color):
    """Rounded triangle: base row spans x0..x1, narrowing to apex_x."""
    span = y_base - y_apex
    for i in range(span + 1):
        y = y_base - i
        t = i / span if span else 0
        left = round(x0 + (apex_x - x0) * t)
        right = round(x1 + (apex_x - x1) * t)
        hline(g, left, right, y, color)


def draw_head(g):
    disc(g, 23, 17, 13, FUR)            # round skull  x10..36  y4..30


def draw_ears(g):
    for (x0, x1, ya, yb, ax) in (EAR_L, EAR_R):
        triangle(g, x0, x1, yb, ya, ax, FUR)
        px(g, ax, ya, 0)                # round the tip
        triangle(g, x0 + 2, x1 - 2, yb - 1, ya + 2, ax, PINK)


def draw_body(g):
    rect(g, 17, 29, 29, 40, FUR)        # chest under the chin
    disc(g, 23, 45, 12, FUR)            # round body down to the canvas floor
    disc(g, 23, 38, 5, LIGHT)           # chest patch


def draw_tail(g, tip_dy=0):
    """Tail curls from behind the body to the lower-right corner."""
    for i, (cx, cy) in enumerate(TAIL_PATH):
        disc(g, cx, cy + (tip_dy if i == len(TAIL_PATH) - 1 else 0), 2, FUR)
    tx, ty = TAIL_TIP
    disc(g, tx, ty + tip_dy, 2, DARK)


def draw_paws(g, pressed=None):
    """Two light front paws at the body base; the pressed one sinks 1px."""
    rect(g, 15, 47, 31, 51, FUR)        # reset the paw zone to body fur
    for side, (x0, x1) in (("L", (16, 22)), ("R", (24, 30))):
        top = 48 if side == pressed else 47
        hline(g, x0 - 1, x1 + 1, top, O)             # top edge
        vline(g, x0 - 1, top + 1, 51, O)             # outer side
        vline(g, x1 + 1, top + 1, 51, O)             # inner side
        rect(g, x0, top + 1, x1, 51, LIGHT)
        vline(g, (x0 + x1) // 2, top + 2, 50, O)     # toe split


def draw_face(g):
    for x0 in (EYE_LX, EYE_RX):
        rect(g, x0, EYE_Y, x0 + 1, EYE_Y + 2, PUPIL)  # 2x3 dot eye
        px(g, x0, EYE_Y, WHITE)                       # 1px highlight
    disc(g, 23, 25, 3, LIGHT)                         # muzzle
    hline(g, 22, 24, 23, PINK)                        # small triangle nose
    px(g, 23, 24, PINK)
    hline(g, 22, 24, 25, O)                           # philtrum
    px(g, 21, 26, O)                                  # omega curls
    px(g, 23, 26, O)
    px(g, 25, 26, O)
    hline(g, 13, 14, 23, BLUSH)
    hline(g, 32, 33, 23, BLUSH)


def happy_eyes(g):
    """^^ arcs replacing both dot eyes."""
    for x0 in (EYE_LX, EYE_RX):
        rect(g, x0, EYE_Y, x0 + 1, EYE_Y + 2, FUR)
        px(g, x0, EYE_Y + 1, O)
        px(g, x0 + 1, EYE_Y, O)
        px(g, x0 + 2, EYE_Y + 1, O)


def grin_mouth(g):
    replace_in(g, 20, 24, 26, 27, O, LIGHT)   # wipe the default mouth
    hline(g, 21, 25, 25, O)                   # open grin
    px(g, 21, 26, O)
    px(g, 25, 26, O)
    hline(g, 22, 24, 26, PINK)                # tongue


def make_base(tip_dy=0):
    g = new_grid()
    draw_head(g)
    draw_ears(g)
    draw_body(g)
    draw_paws(g)
    draw_tail(g, tip_dy)
    auto_outline(g, SILHOUETTE)
    draw_face(g)
    return g

# --------------------------------------------------------- animation frames
HEAD_BOTTOM = 30          # last row that belongs to the head group


def head_down(g, n=1):
    shift_region(g, 0, HEAD_BOTTOM, n)


def hop(g, n=2):
    """Whole-body hop: shift the full sprite up, re-outline the new base."""
    shift_region(g, 0, GH - 1, -n)
    auto_outline(g, SILHOUETTE)


def blink(g):
    for x0 in (EYE_LX, EYE_RX):
        rect(g, x0, EYE_Y, x0 + 1, EYE_Y + 2, FUR)
        hline(g, x0, x0 + 1, EYE_Y + 1, O)


def ear_inner_shift(g, which, dy):
    """Move the inner-pink triangle of one ear down by dy."""
    x0, x1, ya, yb, ax = which
    pts = [(x, y) for y in range(ya, yb + 1) for x in range(x0, x1 + 1)
           if get(g, x, y) == PINK]
    for x, y in pts:
        px(g, x, y, FUR)
    for x, y in pts:
        if ya <= y + dy <= yb - 1:
            px(g, x, y + dy, PINK)


def sparkle(g, x, y, color):
    px(g, x, y, color)
    px(g, x - 1, y, color)
    px(g, x + 1, y, color)
    px(g, x, y - 1, color)
    px(g, x, y + 1, color)


def happy_face(g):
    happy_eyes(g)
    grin_mouth(g)


def build_idle():
    frames = [make_base()]
    f1 = clone(frames[0]); head_down(f1); frames.append(f1)   # breathe
    frames.append(make_base(tip_dy=-2))                       # tail-tip flick
    f3 = clone(frames[0]); blink(f3); frames.append(f3)
    return frames


def build_working():
    base = make_base()
    frames = []
    for i in range(8):
        g = clone(base)
        draw_paws(g, "L" if i % 2 == 0 else "R")   # alternate key taps
        if i % 2 == 1:
            head_down(g)                           # 1px typing bob
        if i in (3, 7):
            ear_inner_shift(g, EAR_L, 1)           # ear twitch on f4/f8
            ear_inner_shift(g, EAR_R, 1)
        frames.append(g)
    return frames


def build_done():
    happy = make_base()
    happy_face(happy)
    frames = [clone(happy)]
    f1 = clone(happy)
    hop(f1, 2)
    sparkle(f1, 8, 8, GOLD)
    sparkle(f1, 40, 6, WHITE)
    sparkle(f1, 6, 26, WHITE)
    sparkle(f1, 41, 24, GOLD)
    frames.append(f1)
    frames.append(clone(happy))
    frames.append(clone(happy))
    return frames


def draw_wave_paw(g, x0, y0):
    """4x4 raised paw: outline ring, light fill, toe notch."""
    for dy in range(4):
        for dx in range(4):
            edge = dx in (0, 3) or dy in (0, 3)
            corner = (dx in (0, 3)) and (dy in (0, 3))
            px(g, x0 + dx, y0 + dy, 0 if corner else (O if edge else LIGHT))
    px(g, x0 + 1, y0 + 1, O)                    # toe notch


def build_wave():
    happy = make_base()
    happy_face(happy)
    spots = ((9, 41), (10, 40), (9, 41), (8, 41))   # up, up+right, back, left
    frames = []
    for x, y in spots:
        g = clone(happy)
        draw_wave_paw(g, x, y)
        frames.append(g)
    return frames


# --------------------------------------------------------------- frame table
def build_all():
    return {
        "idle": build_idle(),
        "working": build_working(),
        "done": build_done(),
        "wave": build_wave(),
    }

# ---------------------------------------------------------------- ascii mode
def ascii_frame(g):
    return "\n".join("".join(CHARS[v] for v in row) for row in g)


# --------------------------------------------------------------- PNG writing
def write_png(path, width, height, rgba):
    def chunk(tag, data):
        payload = tag + data
        return struct.pack(">I", len(data)) + payload + \
            struct.pack(">I", zlib.crc32(payload) & 0xFFFFFFFF)

    raw = bytearray()
    stride = width * 4
    for y in range(height):
        raw.append(0)                       # filter: none
        raw += rgba[y * stride:(y + 1) * stride]
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", ihdr)
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


def render_sheet(frames_by_anim):
    sw, sh = GW * SCALE * COLS, GH * SCALE * ROWS
    rgba = bytearray(sw * sh * 4)
    for anim in ANIMS:
        for fi, grid in enumerate(frames_by_anim[anim["name"]]):
            ox = fi * GW * SCALE
            oy = anim["row"] * GH * SCALE
            for y in range(GH):
                row = grid[y]
                for x in range(GW):
                    r, g_, b, a = PALETTE[row[x]]
                    if a == 0:
                        continue
                    for sy in range(SCALE):
                        base = ((oy + y * SCALE + sy) * sw + ox + x * SCALE) * 4
                        for sx in range(SCALE):
                            i = base + sx * 4
                            rgba[i] = r; rgba[i + 1] = g_
                            rgba[i + 2] = b; rgba[i + 3] = a
    return sw, sh, rgba


# ------------------------------------------------------------------ outputs
def pet_json():
    return {
        "id": "lynn-placeholder",
        "displayName": "Lynn",
        "description": "Placeholder pixel pet for the Claude Code desktop widget",
        "spriteVersionNumber": 1,
        "spritesheetPath": "spritesheet.png",
        "cellWidth": GW * SCALE,
        "cellHeight": GH * SCALE,
        "columns": COLS,
        "animations": ANIMS,
    }


PREVIEW_TMPL = """<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>Lynn placeholder pet preview</title>
<style>
  body {{ background: #20242e; color: #dfe6f3; font: 14px/1.5 monospace;
         margin: 24px; }}
  h1 {{ font-size: 18px; }} .row {{ display: flex; gap: 28px; flex-wrap: wrap; }}
  .panel {{ text-align: center; }}
  .cell {{ width: {cw}px; height: {ch}px; image-rendering: pixelated;
    background-image: url("pet/spritesheet.png");
    background-size: {bsw}px {bsh}px;
    background-repeat: no-repeat;
    outline: 1px solid #465; }}
  .cell.checker {{ background-image:
    url("pet/spritesheet.png"),
    repeating-conic-gradient(#2c3140 0% 25%, #232838 0% 50%);
  background-size: {bsw}px {bsh}px, 16px 16px;
  background-repeat: no-repeat, repeat; }}
  .once {{ animation-iteration-count: 1; animation-fill-mode: forwards; }}
  @keyframes play-idle    {{ to {{ background-position: -{iw0}px 0; }} }}
  @keyframes play-working {{ to {{ background-position: -{iw1}px -{rh}px; }} }}
  @keyframes play-done    {{ to {{ background-position: -{iw2}px -{rh2}px; }} }}
  @keyframes play-wave    {{ to {{ background-position: -{iw3}px -{rh3}px; }} }}
  .static-idle {{ background-position: 0 0; }}
  .tag {{ display: inline-block; margin: 6px 0; padding: 1px 8px;
          border: 1px solid #567; border-radius: 10px; color: #bcd; }}
</style>
</head>
<body>
<h1>Lynn &mdash; placeholder pet spritesheet preview (2x)</h1>
<div class="row">
{panels}
</div>
<h2>idle frame 0 (static)</h2>
<div class="row"><div class="panel">
  <div class="cell checker static-idle"></div>
  <div><span class="tag">idle f0 static</span></div>
</div></div>
</body>
</html>
"""


def write_preview(path):
    cw, ch = GW * SCALE * 2, GH * SCALE * 2     # 384 x 416 on-screen
    bsw, bsh = GW * SCALE * COLS * 2, GH * SCALE * ROWS * 2
    rh = GH * SCALE * 2
    iw = [0] * 4
    panels = []
    for i, anim in enumerate(ANIMS):
        r = anim["row"]
        n = anim["frames"]
        dur = n / anim["fps"]
        steps = n if anim["loop"] else n - 1
        # loop: cycle 0..n-1; once: stop and hold on the last frame
        iw[i] = n * cw if anim["loop"] else (n - 1) * cw
        cls = "cell checker" + ("" if anim["loop"] else " once")
        panels.append(
            '<div class="panel">\n'
            '  <div class="{cls}" style="animation-name: play-{name}; '
            'animation-duration: {dur}s; '
            'animation-timing-function: steps({steps}, end); '
            'background-position: 0 -{oy}px;"></div>\n'
            '  <div><span class="tag">{name} &middot; {n}f &middot; {fps}fps '
            '&middot; loop={loop}</span></div>\n'
            '</div>'.format(cls=cls, name=anim["name"], dur=dur,
                            steps=steps, n=n, fps=anim["fps"],
                            loop=str(anim["loop"]).lower(),
                            oy=r * rh))
    html = PREVIEW_TMPL.format(cw=cw, ch=ch, bsw=bsw, bsh=bsh,
                               rh=rh, rh2=2 * rh, rh3=3 * rh,
                               iw0=iw[0], iw1=iw[1], iw2=iw[2], iw3=iw[3],
                               panels="\n".join(panels))
    with open(path, "w", encoding="utf-8") as f:
        f.write(html)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ascii", nargs=2, metavar=("ROW", "COL"),
                    help="print one frame as ascii instead of writing files")
    args = ap.parse_args()
    frames = build_all()
    if args.ascii:
        r, c = int(args.ascii[0]), int(args.ascii[1])
        anim = ANIMS[r]
        print(ascii_frame(frames[anim["name"]][c]))
        return
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    pet_dir = os.path.join(root, "assets", "pet")
    os.makedirs(pet_dir, exist_ok=True)
    sw, sh, rgba = render_sheet(frames)
    write_png(os.path.join(pet_dir, "spritesheet.png"), sw, sh, rgba)
    with open(os.path.join(pet_dir, "pet.json"), "w", encoding="utf-8") as f:
        json.dump(pet_json(), f, indent=2)
        f.write("\n")
    write_preview(os.path.join(root, "assets", "preview.html"))
    print("wrote spritesheet.png (%dx%d), pet.json, preview.html" % (sw, sh))


if __name__ == "__main__":
    main()
