#!/usr/bin/env python3
"""Import the model-generated cat grid image as the official Lynn spritesheet.

Source: a 2048x2048 JPEG holding an 8x4 grid (light blue-gray hairlines on a
near-white background, no alpha):
    row 0: 4 frames + 4 empty   (idle)
    row 1: 8 frames             (working)
    row 2: 4 frames + 4 empty   (done)
    row 3: 4 frames + 4 empty   (wave)

Pipeline:
  1. convert the source JPEG to PNG with macOS `sips` into a /tmp work dir
  2. detect the grid lines (scan for thin low-luminance lines per column/row;
     fall back to an even 8x4 split if detection does not yield 9/5 lines)
  3. cut each cell with a 2% inner inset to drop the border hairlines
  4. per cell: flood fill from all four edges with a tolerance that eats both
     the near-white background and the light blue-gray lines; only the outer
     connected region is cleared, so white fur enclosed by the cat's outline
     (chest patch) survives.  Output is RGBA.
  5. normalize: compute every used frame's bbox, pick ONE global scale = the
     largest scale at which all used frames fit into 184x200 (never per-frame
     fitting), then bottom-center every frame onto the baseline (content
     bottom edge at y=204, horizontal center at x=96 of the 192x208 cell).
     In-frame relative positions are preserved, so the jumped cat of row 2
     keeps its detached shadow as its content bottom edge.
  6. compose the 1536x832 RGBA sheet (unused cells fully transparent) and
     write spritesheet.png + pet.json.  pet.json keeps `animations` and the
     geometry fields as-is; only `id`/`description` change and
     `spriteVersionNumber` is bumped when the PNG content actually changes.

The PNG writer is reused from scripts/render_placeholder_pet.py, loaded via
importlib (that module is guarded by `if __name__ == "__main__"`, so loading
it has no side effects; this script never *runs* it).  Decoding uses Pillow
when available and otherwise falls back to the stdlib PNG decoder below
(zlib + all five filters unfiltering, 8-bit RGB/RGBA and friends).

Usage:
    python3 -I scripts/import_generated_sheet.py               # default skin
    python3 -I scripts/import_generated_sheet.py --skin <id>   # skin slot
    python3 -I scripts/import_generated_sheet.py --compose-rows r1.png,r2.png,r3.png,r4.png \
        --skin <id> --row-counts 4,8,4,4                       # row-strip compose

--compose-rows: the model cannot keep tall ears inside an 8x4 grid cell
(row boundaries cut through ear tips), so poses are generated as four row
strips instead (white background, no grid lines, poses separated by blank
space; declared pose counts default to 4,8,4,4).  Each strip is independently
flood-cleared (same white->alpha treatment as the grid path), then split into
poses at fully blank column runs (a run only counts as a separator when it is
at least 3% of the strip's width; narrower gaps stay inside a pose).  A split
count mismatch against --row-counts aborts with the per-segment width
distribution.  All poses across all four strips share ONE global scale (the
largest at which every pose fits the 184x200 content box, never upscaling)
and are placed bottom-center into their row's cells in split order; leftover
cells stay fully transparent.  --skin registers the composed sheet as a skin
exactly like the grid path (pet.json skins history preserved).

--skin <id> imports the same grid as a skin instead: the sheet lands in
assets/pet/skins/<id>/spritesheet.png and the skin is registered in pet.json's
"skins" map (displayName defaults to <id>, hand-edit to rename).  The root
spritesheet.png and spriteVersionNumber stay untouched.  All skins share one
grid spec (animations argument is unchanged), so pet.json's animations serve
every skin.
"""
import argparse
import hashlib
import importlib.util
import json
import os
import struct
import subprocess
import sys
import zlib
from collections import deque

# loading render_placeholder_pet.py via importlib must not drop __pycache__
sys.dont_write_bytecode = True

# ------------------------------------------------------------------ inputs
SRC_JPEG = "/Users/sora/Downloads/test-cat.jpg"     # read-only source of truth
WORK_DIR = "/tmp/lynn-sheet-import"                 # all scratch output goes here
CONVERTED_PNG = os.path.join(WORK_DIR, "test-cat.png")

# ----------------------------------------------------------------- outputs
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RENDER_SCRIPT = os.path.join(ROOT, "scripts", "render_placeholder_pet.py")
PET_DIR = os.path.join(ROOT, "assets", "pet")
SHEET_PATH = os.path.join(PET_DIR, "spritesheet.png")
PET_JSON_PATH = os.path.join(PET_DIR, "pet.json")
SKINS_DIR = os.path.join(PET_DIR, "skins")   # per-skin sheets: skins/<id>/…

# --------------------------------------------------------------- constants
COLS, ROWS = 8, 4
CELL_W, CELL_H = 192, 208          # spritesheet geometry (see docs/ART.md)
SHEET_W, SHEET_H = CELL_W * COLS, CELL_H * ROWS   # 1536 x 832
CONTENT_W, CONTENT_H = 184, 200    # max content box inside a cell
CENTER_X = 96                      # horizontal content center within a cell
BASELINE_Y = 204                   # content bottom edge within a cell
INSET_FRAC = 0.02                  # inner inset per cell edge (cuts hairlines)
LUM_DARK = 235                     # "darker than background" luminance bound
LINE_FRAC = 0.55                   # min dark-pixel fraction for a grid line
LINE_MAX_W = 8                     # a grid line cluster is thin; content is not
T_FLOOD = 110                      # manhattan tol: eats bg (~0-30) + lines (~92-100),
                                   # spares the jump shadow core (~120)
T_SPECK = 140                      # fringe cleanup bound
SPECK_NEIGH = 3                    # transparent 4-neighbors that kill a fringe px

def log(msg):
    print(msg, flush=True)

# ------------------------------------------------------- step 1: sips -> PNG
def convert_to_png(src, out_path=CONVERTED_PNG):
    os.makedirs(WORK_DIR, exist_ok=True)
    r = subprocess.run(
        ["sips", "-s", "format", "png", src, "--out", out_path],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if r.returncode != 0 or not os.path.exists(out_path):
        raise RuntimeError("sips conversion failed: "
                           + r.stderr.decode("utf-8", "replace").strip())

# ----------------------------------------------- step 2b: stdlib PNG decode
def decode_png_stdlib(path):
    """Decode 8-bit non-interlaced PNG (gray / RGB / palette / gray+A / RGBA)."""
    with open(path, "rb") as f:
        data = f.read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG file: %s" % path)
    pos, ihdr, idat, plte, trns = 8, None, bytearray(), None, None
    while pos + 8 <= len(data):
        (length,) = struct.unpack(">I", data[pos:pos + 4])
        tag = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + length]
        pos += 12 + length
        if tag == b"IHDR":
            ihdr = struct.unpack(">IIBBBBB", body)
        elif tag == b"IDAT":
            idat += body
        elif tag == b"PLTE":
            plte = body
        elif tag == b"tRNS":
            trns = body
        elif tag == b"IEND":
            break
    if ihdr is None:
        raise ValueError("PNG missing IHDR")
    w, h, depth, ctype, comp, filt, inter = ihdr
    if depth != 8 or comp != 0 or filt != 0 or inter != 0:
        raise ValueError("unsupported PNG (depth=%d comp=%d filt=%d inter=%d)"
                         % (depth, comp, filt, inter))
    if ctype not in (0, 2, 3, 4, 6):
        raise ValueError("unsupported color type %d" % ctype)
    ch = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[ctype]
    raw = zlib.decompress(bytes(idat))
    stride = w * ch
    recon = bytearray(h * stride)
    prev = bytes(stride)
    p = 0
    for y in range(h):
        ftype = raw[p]
        p += 1
        line = bytearray(raw[p:p + stride])
        p += stride
        if ftype == 1:                                   # Sub
            for i in range(ch, stride):
                line[i] = (line[i] + line[i - ch]) & 0xFF
        elif ftype == 2:                                 # Up
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif ftype == 3:                                 # Average
            for i in range(stride):
                a = line[i - ch] if i >= ch else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xFF
        elif ftype == 4:                                 # Paeth
            for i in range(stride):
                a = line[i - ch] if i >= ch else 0
                b = prev[i]
                c = prev[i - ch] if i >= ch else 0
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        elif ftype != 0:
            raise ValueError("bad filter type %d" % ftype)
        recon[y * stride:(y + 1) * stride] = line
        prev = line
    if ctype == 6:
        return recon, w, h
    out = bytearray(w * h * 4)
    if ctype == 2:
        for i in range(w * h):
            out[4 * i:4 * i + 3] = recon[3 * i:3 * i + 3]
            out[4 * i + 3] = 255
    elif ctype == 0:
        for i in range(w * h):
            out[4 * i] = out[4 * i + 1] = out[4 * i + 2] = recon[i]
            out[4 * i + 3] = 255
    elif ctype == 4:
        for i in range(w * h):
            out[4 * i] = out[4 * i + 1] = out[4 * i + 2] = recon[2 * i]
            out[4 * i + 3] = recon[2 * i + 1]
    else:                                                # palette
        if plte is None:
            raise ValueError("palette PNG without PLTE chunk")
        n = len(plte) // 3
        for i in range(w * h):
            idx = recon[i]
            if idx >= n:
                raise ValueError("palette index out of range")
            out[4 * i:4 * i + 3] = plte[3 * idx:3 * idx + 3]
            out[4 * i + 3] = trns[idx] if (trns and idx < len(trns)) else 255
    return out, w, h

def decode_rgba(path):
    """Decode to (flat RGBA bytearray, w, h). Pillow if present, stdlib else."""
    try:
        from PIL import Image                            # optional speed-up
    except ImportError:
        return decode_png_stdlib(path)
    with Image.open(path) as im:
        rgba = im.convert("RGBA")
        return bytearray(rgba.tobytes()), rgba.width, rgba.height

# ------------------------------------------------------- step 2: grid detect
def _line_centers(frac, thresh, max_width):
    cand = [i for i, v in enumerate(frac) if v > thresh]
    groups = []
    for i in cand:
        if groups and i - groups[-1][-1] <= 2:
            groups[-1].append(i)
        else:
            groups.append([i])
    return [sum(g) / len(g) for g in groups if len(g) <= max_width]

def _spacings_ok(lines, expect_n):
    if len(lines) != expect_n:
        return False
    gaps = [lines[i + 1] - lines[i] for i in range(len(lines) - 1)]
    mean = sum(gaps) / len(gaps)
    return all(abs(g - mean) <= 0.15 * mean for g in gaps)

def detect_grid(rgba, W, H):
    """Return (col_lines, row_lines, mode). Lines are int coordinates."""
    colfrac = []
    for x in range(W):
        cnt = tot = 0
        for y in range(0, H, 7):
            i = (y * W + x) * 4
            if (299 * rgba[i] + 587 * rgba[i + 1] + 114 * rgba[i + 2]) < 235000:
                cnt += 1
            tot += 1
        colfrac.append(cnt / tot)
    rowfrac = []
    for y in range(H):
        cnt = tot = 0
        for x in range(0, W, 7):
            i = (y * W + x) * 4
            if (299 * rgba[i] + 587 * rgba[i + 1] + 114 * rgba[i + 2]) < 235000:
                cnt += 1
            tot += 1
        rowfrac.append(cnt / tot)
    col_lines = _line_centers(colfrac, LINE_FRAC, LINE_MAX_W)
    row_lines = _line_centers(rowfrac, LINE_FRAC, LINE_MAX_W)
    if _spacings_ok(col_lines, COLS + 1) and _spacings_ok(row_lines, ROWS + 1):
        return ([round(v) for v in col_lines],
                [round(v) for v in row_lines], "detected")
    return ([round(W * c / COLS) for c in range(COLS + 1)],
            [round(H * r / ROWS) for r in range(ROWS + 1)], "even-split fallback")

# ------------------------------------------- steps 3+4: cells, flood, bbox
def cell_boxes(col_lines, row_lines):
    """Inclusive-exclusive inset boxes for all COLS*ROWS cells."""
    boxes = []
    for r in range(ROWS):
        for c in range(COLS):
            x0, x1 = col_lines[c], col_lines[c + 1]
            y0, y1 = row_lines[r], row_lines[r + 1]
            ix = max(1, int(round((x1 - x0) * INSET_FRAC)))
            iy = max(1, int(round((y1 - y0) * INSET_FRAC)))
            boxes.append((x0 + ix, y0 + iy, x1 - ix, y1 - iy))
    return boxes

def bg_ref(rgba, W, box):
    x0, y0, x1, y1 = box
    acc = [0, 0, 0]
    for cx, cy in ((x0, y0), (x1 - 1, y0), (x0, y1 - 1), (x1 - 1, y1 - 1)):
        i = (cy * W + cx) * 4
        acc[0] += rgba[i]; acc[1] += rgba[i + 1]; acc[2] += rgba[i + 2]
    return (acc[0] // 4, acc[1] // 4, acc[2] // 4)

def flood_clear(rgba, W, box, bg, tol):
    """Clear the bg-connected (edge-seeded) region of one cell. Enclosed
    pixels (white chest fur inside the closed outline) are never reached."""
    x0, y0, x1, y1 = box
    w, h = x1 - x0, y1 - y0
    br, bgg, bb = bg

    def is_bg(x, y):
        i = (y * W + x) * 4
        return (abs(rgba[i] - br) + abs(rgba[i + 1] - bgg)
                + abs(rgba[i + 2] - bb)) <= tol

    visited = bytearray(w * h)
    dq = deque()
    for x in range(x0, x1):
        for y in (y0, y1 - 1):
            k = (y - y0) * w + (x - x0)
            if not visited[k] and is_bg(x, y):
                visited[k] = 1
                dq.append(k)
    for y in range(y0 + 1, y1 - 1):
        for x in (x0, x1 - 1):
            k = (y - y0) * w + (x - x0)
            if not visited[k] and is_bg(x, y):
                visited[k] = 1
                dq.append(k)
    while dq:
        k = dq.popleft()
        x = x0 + k % w
        y = y0 + k // w
        rgba[(y * W + x) * 4 + 3] = 0
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if x0 <= nx < x1 and y0 <= ny < y1:
                nk = (ny - y0) * w + (nx - x0)
                if not visited[nk] and is_bg(nx, ny):
                    visited[nk] = 1
                    dq.append(nk)
    return visited

def speck_pass(rgba, W, box, bg, t, need_neighbors):
    """One cleanup pass: drop fringe pixels (close to bg, mostly surrounded
    by transparency) left over from hairline halos / JPEG mosquito noise."""
    x0, y0, x1, y1 = box
    br, bgg, bb = bg
    deaths = []
    for y in range(y0, y1):
        for x in range(x0, x1):
            i = (y * W + x) * 4
            if rgba[i + 3] == 0:
                continue
            if abs(rgba[i] - br) + abs(rgba[i + 1] - bgg) \
                    + abs(rgba[i + 2] - bb) > t:
                continue
            ntrans = 0
            if x > x0 and rgba[i - 4 + 3] == 0:
                ntrans += 1
            if x < x1 - 1 and rgba[i + 4 + 3] == 0:
                ntrans += 1
            if y > y0 and rgba[i - W * 4 + 3] == 0:
                ntrans += 1
            if y < y1 - 1 and rgba[i + W * 4 + 3] == 0:
                ntrans += 1
            if ntrans >= need_neighbors:
                deaths.append(i)
    for i in deaths:
        rgba[i + 3] = 0

def cell_bbox(rgba, W, box):
    x0, y0, x1, y1 = box
    minx = miny = 10 ** 9
    maxx = maxy = -1
    cnt = 0
    for y in range(y0, y1):
        base = y * W
        for x in range(x0, x1):
            if rgba[(base + x) * 4 + 3]:
                cnt += 1
                if x < minx: minx = x
                if x > maxx: maxx = x
                if y < miny: miny = y
                if y > maxy: maxy = y
    if cnt == 0:
        return None
    return (minx, miny, maxx, maxy, cnt)

# ------------------------------------------------------ step 5: resampling
def resize_region(src, W, sx0, sy0, sw, sh, dw, dh):
    """Area-average downscale of src[sx0:sx0+sw, sy0:sy0+sh] with premultiplied
    alpha; binary output alpha (opaque at >=50% coverage). Deterministic."""
    out = bytearray(dw * dh * 4)
    for j in range(dh):
        fy0 = j * sh / dh
        fy1 = (j + 1) * sh / dh
        iy0 = int(fy0)
        iy1 = min(sh, int(fy1) + 1 if fy1 > int(fy1) else int(fy1))
        if iy1 <= iy0:
            iy1 = iy0 + 1
        for i2 in range(dw):
            fx0 = i2 * sw / dw
            fx1 = (i2 + 1) * sw / dw
            ix0 = int(fx0)
            ix1 = min(sw, int(fx1) + 1 if fx1 > int(fx1) else int(fx1))
            if ix1 <= ix0:
                ix1 = ix0 + 1
            sa = sr = sg = sb = wsum = 0.0
            for yy in range(iy0, iy1):
                wy = min(fy1, yy + 1) - max(fy0, yy)
                if wy <= 0:
                    continue
                row = (sy0 + yy) * W + sx0
                for xx in range(ix0, ix1):
                    wx = min(fx1, xx + 1) - max(fx0, xx)
                    if wx <= 0:
                        continue
                    wgt = wx * wy
                    wsum += wgt
                    di = (row + xx) * 4
                    a = src[di + 3]
                    sa += a * wgt
                    if a:
                        sr += src[di] * a * wgt
                        sg += src[di + 1] * a * wgt
                        sb += src[di + 2] * a * wgt
            if wsum and sa >= 127.5 * wsum:
                oi = (j * dw + i2) * 4
                out[oi] = min(255, int(sr / sa + 0.5))
                out[oi + 1] = min(255, int(sg / sa + 0.5))
                out[oi + 2] = min(255, int(sb / sa + 0.5))
                out[oi + 3] = 255
    return out

# --------------------------------------------------- PNG writer (reused)
def load_png_writer():
    """Load scripts/render_placeholder_pet.py via importlib and reuse its
    stdlib write_png().  The module is __main__-guarded, so this import is
    side-effect free; we never execute (or run) that script."""
    spec = importlib.util.spec_from_file_location("render_placeholder_pet",
                                                  RENDER_SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load %s" % RENDER_SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    if not hasattr(mod, "write_png"):
        raise RuntimeError("render_placeholder_pet.write_png not found")
    return mod.write_png

# ------------------------------------------------------------------ pet.json
def build_pet_json(png_bytes, old_png, skin_id=None):
    """Update id/description (and bump spriteVersionNumber when the PNG
    content actually changed) while leaving animations and geometry as-is.

    With skin_id set, the run targets a skin slot instead: the skin is
    registered into pet.json's "skins" map (existing entries are preserved —
    this script stays pet.json's single writer and rewrites the whole file,
    skins history included).  displayName starts as the id; hand-edit to
    rename.  The root sheet was not touched, so spriteVersionNumber does not
    move (it tracks the default skin's content only)."""
    if not os.path.exists(PET_JSON_PATH):
        raise SystemExit("missing %s -- animations must be preserved from it"
                         % PET_JSON_PATH)
    with open(PET_JSON_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)
    data["id"] = "lynn"
    data["displayName"] = "Lynn"
    data["description"] = ("Lynn official spritesheet, imported from the "
                           "generated cat grid image by "
                           "scripts/import_generated_sheet.py")
    if skin_id is not None:
        skins = data.get("skins")
        if not isinstance(skins, dict):
            skins = {}
        skins[skin_id] = {
            "spritesheetPath": "skins/%s/spritesheet.png" % skin_id,
            "displayName": skin_id,
        }
        data["skins"] = skins
        changed = False  # default sheet untouched → no version bump
    else:
        changed = old_png != png_bytes
        if changed:
            data["spriteVersionNumber"] = int(data.get("spriteVersionNumber", 1)) + 1
    # animations / cellWidth / cellHeight / columns / spritesheetPath: untouched
    return data, changed

# ------------------------------------------------ compose-rows mode (v1.2)
def column_profile(rgba, W, H):
    """Opaque-pixel count per column (after the strip's flood/speck pass)."""
    cols = [0] * W
    for y in range(H):
        base = y * W
        for x in range(W):
            if rgba[(base + x) * 4 + 3]:
                cols[x] += 1
    return cols

def split_segments(cols, W, min_gap):
    """Split a strip's columns into content segments (inclusive-exclusive).
    A blank run only separates poses once it reaches `min_gap` columns;
    narrower runs stay inside a pose.  Leading/trailing blanks are ignored,
    and a segment still open at the strip's end closes there — a trailing
    blank run can never reach the threshold past the last column, so without
    this the LAST pose would be silently dropped whenever its trailing
    whitespace is narrower than min_gap."""
    segs = []
    in_content = False
    x0 = 0
    gap_start = None
    for x in range(W + 1):
        blank = x == W or cols[x] == 0
        if not blank:
            if not in_content:
                in_content = True
                x0 = x
            gap_start = None
            continue
        if not in_content:
            continue
        if gap_start is None:
            gap_start = x
        if x - gap_start >= min_gap:
            segs.append((x0, gap_start))
            in_content = False
            gap_start = None
    if in_content:
        segs.append((x0, gap_start if gap_start is not None else W))
    return segs

def process_strip(path, tag):
    """Decode one row strip, run the full white->alpha treatment on the whole
    image (no grid lines exist), and split it into pose segments."""
    out_png = os.path.join(WORK_DIR, "compose-%s.png" % tag)
    convert_to_png(path, out_png)
    rgba, W, H = decode_rgba(out_png)
    log("      decoded %dx%d RGBA" % (W, H))
    box = (0, 0, W, H)
    bg = bg_ref(rgba, W, box)
    flood_clear(rgba, W, box, bg, T_FLOOD)
    speck_pass(rgba, W, box, bg, T_SPECK, SPECK_NEIGH)
    min_gap = max(1, int(round(W * 0.03)))
    segs = split_segments(column_profile(rgba, W, H), W, min_gap)
    return {
        "path": path,
        "rgba": rgba,
        "W": W,
        "H": H,
        "min_gap": min_gap,
        "segs": segs,
        "bboxes": [cell_bbox(rgba, W, (x0, 0, x1, H)) for (x0, x1) in segs],
    }

def run_compose(args, skin_id):
    paths = [p.strip() for p in args.compose_rows.split(",") if p.strip()]
    if len(paths) != ROWS:
        raise SystemExit("--compose-rows needs exactly %d comma-separated "
                         "row-strip paths, got %d" % (ROWS, len(paths)))
    try:
        counts = [int(v) for v in args.row_counts.split(",")]
    except ValueError:
        raise SystemExit("invalid --row-counts: %r (expected four integers)"
                         % args.row_counts)
    if len(counts) != ROWS:
        raise SystemExit("--row-counts needs exactly %d comma-separated "
                         "values, got %d" % (ROWS, len(counts)))
    for i, n in enumerate(counts):
        if not 1 <= n <= COLS:
            raise SystemExit("--row-counts value %d for row %d out of range "
                             "(1..%d)" % (n, i + 1, COLS))
    for p in paths:
        if not os.path.exists(p):
            raise SystemExit("row strip not found: %s" % p)

    log("== Lynn compose-rows import =="
        + ("  (skin: %s)" % skin_id if skin_id else ""))

    rows = []
    for i, p in enumerate(paths):
        log("[strip %d/%d] %s" % (i + 1, ROWS, p))
        info = process_strip(p, "r%d" % (i + 1))
        log("      min blank-gap %dpx -> %d segments (declared %d)"
            % (info["min_gap"], len(info["segs"]), counts[i]))
        if len(info["segs"]) != counts[i]:
            widths = "; ".join("cols %d-%d (%dpx wide)"
                               % (x0, x1 - 1, x1 - x0)
                               for (x0, x1) in info["segs"]) or "none"
            raise SystemExit(
                "row %d split mismatch: declared %d poses, blank-column split "
                "found %d (separator threshold %dpx). Segments: %s. Widen the "
                "blank gaps between poses or fix --row-counts."
                % (i + 1, counts[i], len(info["segs"]), info["min_gap"],
                   widths))
        rows.append(info)

    log("global scale to fit %dx%d ..." % (CONTENT_W, CONTENT_H))
    scale = 1.0
    for info in rows:
        for (minx, miny, maxx, maxy, _) in info["bboxes"]:
            bw, bh = maxx - minx + 1, maxy - miny + 1
            scale = min(scale, CONTENT_W / bw, CONTENT_H / bh)
    log("      global scale factor: %.6f" % scale)

    log("compositing %dx%d sheet ..." % (SHEET_W, SHEET_H))
    sheet = bytearray(SHEET_W * SHEET_H * 4)
    placed = []
    for r, info in enumerate(rows):
        for c, (minx, miny, maxx, maxy, _) in enumerate(info["bboxes"]):
            bw, bh = maxx - minx + 1, maxy - miny + 1
            dw = max(1, int(round(bw * scale)))
            dh = max(1, int(round(bh * scale)))
            ox = c * CELL_W + (CENTER_X - dw // 2)
            oy = r * CELL_H + (BASELINE_Y - dh)
            frame = resize_region(info["rgba"], info["W"],
                                  minx, miny, bw, bh, dw, dh)
            for y in range(dh):
                sbase = y * dw * 4
                dbase = ((oy + y) * SHEET_W + ox) * 4
                sheet[dbase:dbase + dw * 4] = frame[sbase:sbase + dw * 4]
            placed.append((r, c, bw, bh, dw, dh,
                           ox - c * CELL_W, oy - r * CELL_H))
    for r, info in enumerate(rows):
        if len(info["bboxes"]) < COLS:
            log("  r%d cells c%d..c%d EMPTY (left fully transparent)"
                % (r, len(info["bboxes"]), COLS - 1))

    log("writing outputs ...")
    write_png = load_png_writer()
    target_sheet = (os.path.join(SKINS_DIR, skin_id, "spritesheet.png")
                    if skin_id else SHEET_PATH)
    os.makedirs(os.path.dirname(target_sheet), exist_ok=True)
    old_png = None
    if skin_id is None and os.path.exists(SHEET_PATH):
        with open(SHEET_PATH, "rb") as f:
            old_png = f.read()
    write_png(target_sheet, SHEET_W, SHEET_H, sheet)
    with open(target_sheet, "rb") as f:
        png_bytes = f.read()
    pet, changed = build_pet_json(png_bytes, old_png, skin_id)
    with open(PET_JSON_PATH, "w", encoding="utf-8") as f:
        json.dump(pet, f, indent=2)
        f.write("\n")

    log("")
    log("per-cell report (cell: source bbox w*h, scaled w*h at in-cell "
        "offset, opaque px):")
    for (r, c, bw, bh, dw, dh, lx, ly) in placed:
        cnt = 0
        for y in range(r * CELL_H, (r + 1) * CELL_H):
            base = y * SHEET_W
            for x in range(c * CELL_W, (c + 1) * CELL_W):
                if sheet[(base + x) * 4 + 3]:
                    cnt += 1
        log("  r%dc%-2d used   src %3dx%-3d -> %3dx%-3d at (%3d,%3d)  "
            "opaque %5d" % (r, c, bw, bh, dw, dh, lx, ly, cnt))
    log("")
    log("pet.json spritesheetPath=%s cell=%dx%d columns=%d id=%s version=%d%s"
        % (pet["spritesheetPath"], pet["cellWidth"], pet["cellHeight"],
           pet["columns"], pet["id"], pet["spriteVersionNumber"],
           " (bumped)" if changed else " (unchanged)"))
    if skin_id is not None:
        log("skin %r registered: spritesheetPath=%s displayName=%s (skins: %s)"
            % (skin_id, pet["skins"][skin_id]["spritesheetPath"],
               pet["skins"][skin_id]["displayName"],
               ", ".join(sorted(pet["skins"]))))
    log("sheet md5: %s" % hashlib.md5(png_bytes).hexdigest())
    with open(PET_JSON_PATH, "rb") as f:
        log("pet.json md5: %s" % hashlib.md5(f.read()).hexdigest())
    log("done.")

# --------------------------------------------------------------------- main
def parse_args(argv=None):
    ap = argparse.ArgumentParser(
        description="Import a generated 8x4 grid image as a Lynn spritesheet.")
    ap.add_argument("--skin", metavar="<id>", default=None,
                    help="import as skin <id>: write assets/pet/skins/<id>/"
                         "spritesheet.png and register it in pet.json's "
                         "skins map (without it: overwrite the default root "
                         "spritesheet.png, unchanged legacy behavior)")
    ap.add_argument("--src", metavar="<path>", default=SRC_JPEG,
                    help="source grid image (default: %s)" % SRC_JPEG)
    ap.add_argument("--compose-rows",
                    metavar="<r1>,<r2>,<r3>,<r4>", default=None,
                    help="compose mode: four row-strip images (white "
                         "background, no grid, poses separated by blank "
                         "space); each is flood-cleared and split on blank "
                         "columns, then all poses share one global scale and "
                         "are laid out bottom-center into the 8x4 grid in "
                         "split order (leftover cells stay transparent)")
    ap.add_argument("--row-counts", metavar="<n1>,<n2>,<n3>,<n4>",
                    default="4,8,4,4",
                    help="declared pose count per row strip (default: "
                         "4,8,4,4); a split mismatch aborts with the "
                         "per-segment width distribution")
    return ap.parse_args(argv)


def main():
    args = parse_args()
    skin_id = None
    if args.skin is not None:
        skin_id = args.skin.strip()
        if not skin_id or "/" in skin_id or skin_id in (".", ".."):
            raise SystemExit("invalid --skin id: %r (must be a plain "
                             "directory name)" % args.skin)
    if args.compose_rows:
        run_compose(args, skin_id)
        return
    src = args.src
    if not os.path.exists(src):
        raise SystemExit("source image not found: %s" % src)
    target_sheet = (os.path.join(SKINS_DIR, skin_id, "spritesheet.png")
                    if skin_id else SHEET_PATH)
    log("== Lynn generated-sheet import =="
        + ("  (skin: %s)" % skin_id if skin_id else ""))

    log("[1/6] sips: %s -> %s" % (src, CONVERTED_PNG))
    convert_to_png(src)
    rgba, W, H = decode_rgba(CONVERTED_PNG)
    log("      decoded %dx%d RGBA" % (W, H))

    log("[2/6] detecting grid lines ...")
    col_lines, row_lines, mode = detect_grid(rgba, W, H)
    log("      mode: %s" % mode)
    log("      col lines: %s" % col_lines)
    log("      row lines: %s" % row_lines)

    boxes = cell_boxes(col_lines, row_lines)
    log("[3/6] cut %d cells (inset %.0f%%), flood-filling background ..."
        % (len(boxes), INSET_FRAC * 100))
    bboxes = []
    for idx, box in enumerate(boxes):
        bg = bg_ref(rgba, W, box)
        flood_clear(rgba, W, box, bg, T_FLOOD)
        speck_pass(rgba, W, box, bg, T_SPECK, SPECK_NEIGH)
        bb = cell_bbox(rgba, W, box)
        bboxes.append(bb)
    used = [(i, b) for i, b in enumerate(bboxes) if b]
    log("      used cells: %d, empty cells: %d" % (len(used), 32 - len(used)))

    log("[4/6] global scale to fit %dx%d ..." % (CONTENT_W, CONTENT_H))
    scale = 1.0
    for _, (minx, miny, maxx, maxy, _) in used:
        bw, bh = maxx - minx + 1, maxy - miny + 1
        scale = min(scale, CONTENT_W / bw, CONTENT_H / bh)
    log("      global scale factor: %.6f" % scale)

    log("[5/6] compositing %dx%d sheet ..." % (SHEET_W, SHEET_H))
    sheet = bytearray(SHEET_W * SHEET_H * 4)
    placed = []
    for idx, (minx, miny, maxx, maxy, _) in used:
        r, c = divmod(idx, COLS)
        bw, bh = maxx - minx + 1, maxy - miny + 1
        dw = max(1, int(round(bw * scale)))
        dh = max(1, int(round(bh * scale)))
        ox = c * CELL_W + (CENTER_X - dw // 2)
        oy = r * CELL_H + (BASELINE_Y - dh)
        frame = resize_region(rgba, W, minx, miny, bw, bh, dw, dh)
        for y in range(dh):
            sbase = y * dw * 4
            dbase = ((oy + y) * SHEET_W + ox) * 4
            sheet[dbase:dbase + dw * 4] = frame[sbase:sbase + dw * 4]
        placed.append((idx, r, c, bw, bh, dw, dh, ox, oy,
                       ox - c * CELL_W, oy - r * CELL_H))

    log("[6/6] writing outputs ...")
    write_png = load_png_writer()
    os.makedirs(os.path.dirname(target_sheet), exist_ok=True)
    old_png = None
    # Skin mode never bumps spriteVersionNumber (it tracks the default root
    # sheet), so the old/new comparison only makes sense in default mode.
    if skin_id is None and os.path.exists(SHEET_PATH):
        with open(SHEET_PATH, "rb") as f:
            old_png = f.read()
    write_png(target_sheet, SHEET_W, SHEET_H, sheet)
    with open(target_sheet, "rb") as f:
        png_bytes = f.read()
    pet, changed = build_pet_json(png_bytes, old_png, skin_id)
    with open(PET_JSON_PATH, "w", encoding="utf-8") as f:
        json.dump(pet, f, indent=2)
        f.write("\n")

    # ------------------------------------------------------------- report
    log("")
    log("per-cell report (cell: status, source bbox w*h, scaled w*h at "
        "sheet offset, opaque px):")
    for (idx, r, c, bw, bh, dw, dh, ox, oy, lx, ly) in placed:
        cnt = 0
        for y in range(r * CELL_H, (r + 1) * CELL_H):
            base = y * SHEET_W
            for x in range(c * CELL_W, (c + 1) * CELL_W):
                if sheet[(base + x) * 4 + 3]:
                    cnt += 1
        log("  r%dc%-2d used   bbox %3dx%-3d -> %3dx%-3d at (%3d,%3d)  "
            "opaque %5d" % (r, c, bw, bh, dw, dh, lx, ly, cnt))
    for idx, bb in enumerate(bboxes):
        if not bb:
            r, c = divmod(idx, COLS)
            log("  r%dc%-2d EMPTY  (fully transparent)" % (r, c))
    log("")
    log("pet.json spritesheetPath=%s cell=%dx%d columns=%d id=%s version=%d%s"
        % (pet["spritesheetPath"], pet["cellWidth"], pet["cellHeight"],
           pet["columns"], pet["id"], pet["spriteVersionNumber"],
           " (bumped)" if changed else " (unchanged)"))
    if skin_id is not None:
        log("skin %r registered: spritesheetPath=%s displayName=%s (skins: %s)"
            % (skin_id, pet["skins"][skin_id]["spritesheetPath"],
               pet["skins"][skin_id]["displayName"],
               ", ".join(sorted(pet["skins"]))))
        log("skin sheet: %s md5: %s"
            % (os.path.relpath(target_sheet, ROOT),
               hashlib.md5(png_bytes).hexdigest()))
    else:
        log("spritesheet.png md5: %s"
            % hashlib.md5(png_bytes).hexdigest())
    with open(PET_JSON_PATH, "rb") as f:
        log("pet.json         md5: %s"
            % hashlib.md5(f.read()).hexdigest())
    log("done.")

if __name__ == "__main__":
    main()
