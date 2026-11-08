"""Finalise a transparent-background run cycle into 256x256 sprites.

This is the counterpart to tools/key-sprite.py for frames generated with
`gen-pet-frames.mjs --transparent`. Keying a rendered black field by threshold
has to guess where her white dress ends and a white background cloud begins;
asking the gateway for `background=transparent` removes the guess, and what is
left is three mechanical jobs:

1. **Sanitise the matte.** The gateway pads the field with alpha 1 rather than 0
   — roughly a third of the canvas — and can leave a few detached alpha blobs.
   Both are dropped: only the figure's own component survives, plus details
   within a few pixels of it, which is how a hairline break in the line art
   shows up. (The previous run frames shipped with up to 39 detached components
   of coloured debris; that is the "背景不纯，有很多杂色" a review reported.)
2. **Resize once, premultiplied.** Transparent pixels carry RGB 0, so a plain
   resize bleeds black into the rim. The RGB is treated as un-premultiplied (the
   PNG convention) and divided back out after the resize.
3. **Place on rigid landmarks.** The model is asked for the full body
   "centered", so it recentres the whole figure including whichever limb is
   extended — which slides the body sideways by up to 5% of her height from
   frame to frame. Each frame is therefore placed by its head, and every frame
   of this cycle has a foot down, so they all share one sole line. The transform
   is computed once for the scene; this step adds no jitter of its own.

Usage:
  finalize-run.py <raw-dir> <out-dir> [--size 256] [--masters dir] [--sheet review.png]

Writes <out-dir>/run-1..6.png, ready to copy into pet-app/public/frames/.
Check the result with tools/verify-run-cycle.py.
"""
import os
import sys
from collections import deque

import numpy as np
from PIL import Image, ImageDraw

RAW_DIR = sys.argv[1]
OUT_DIR = sys.argv[2]


def flag(name, default=None):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


SIZE = int(flag('--size', 256))
SHEET = flag('--sheet')
MASTERS = flag('--masters')

ALPHA_FLOOR = 8      # the gateway's padding is alpha 1; real rim pixels start far above
BLACK_LEVEL = 22     # the art's darkest colour is a blue-tinted navy, never black
GLUE_PX = 5          # a detail this close to the figure is part of her
TARGET_H = SIZE * 0.93
BOTTOM_MARGIN = 6
GROUND_EPS = 0.04    # a sole this close to the scene's lowest sole is on the ground


def label8(mask):
    """8-connected labelling. Returns (labels, sizes, components as arrays)."""
    h, w = mask.shape
    lab = np.zeros((h, w), np.int32)
    sizes = [0]
    comps = []
    ys, xs = np.nonzero(mask)
    n = 0
    for sy, sx in zip(ys, xs):
        if lab[sy, sx]:
            continue
        n += 1
        q = deque([(sy, sx)])
        lab[sy, sx] = n
        pts = []
        while q:
            y, x = q.popleft()
            pts.append((y, x))
            for dy in (-1, 0, 1):
                ny = y + dy
                if ny < 0 or ny >= h:
                    continue
                for dx in (-1, 0, 1):
                    nx = x + dx
                    if nx < 0 or nx >= w or lab[ny, nx] or not mask[ny, nx]:
                        continue
                    lab[ny, nx] = n
                    q.append((ny, nx))
        sizes.append(len(pts))
        comps.append(np.array(pts))
    return lab, sizes, comps


def dilate(mask, radius):
    out = mask.copy()
    for _ in range(radius):
        g = out.copy()
        g[1:, :] |= out[:-1, :]
        g[:-1, :] |= out[1:, :]
        g[:, 1:] |= out[:, :-1]
        g[:, :-1] |= out[:, 1:]
        out = g
    return out


def keep_figure(rgb, alpha, glue_px):
    """Drop alpha dust, the black field, and every detached component.

    The gateway sometimes returns the background as a *cloudy alpha ramp* over
    RGB 0 rather than a clean cut-out: on one frame here, 549,580 pixels sat at
    alpha 9-249, 95.6% of them at RGB <= 12, while the artwork never went below
    max(RGB) 26 — the darkest colour the art uses is a blue-tinted navy. So
    "black in RGB" is background whatever the alpha says, and that is what
    removes the cloud. The component pass then clears whatever is left over.
    """
    rgb_max = rgb.max(axis=2)
    alpha = np.where(alpha <= ALPHA_FLOOR, 0.0, alpha)
    cloud = int(((alpha > 0) & (rgb_max <= BLACK_LEVEL)).sum())
    alpha = np.where(rgb_max <= BLACK_LEVEL, 0.0, alpha)

    lab, sizes, _ = label8(alpha > 0)
    if len(sizes) <= 1:
        return alpha, cloud, 0, 0
    main = int(np.argmax(sizes[1:])) + 1
    core = lab == main
    glue = dilate(core, glue_px)
    dropped_n = 0
    dropped_px = 0
    for i in range(1, len(sizes)):
        if i == main:
            continue
        sel = lab == i
        if not (glue & sel).any():
            alpha = np.where(sel, 0.0, alpha)
            dropped_n += 1
            dropped_px += sizes[i]
    return alpha, cloud, dropped_n, dropped_px


names = sorted(f for f in os.listdir(RAW_DIR) if f.startswith('run-') and f.endswith('.png'))
if not names:
    raise SystemExit(f'no run-*.png in {RAW_DIR}')

print(f'finalising {len(names)} frame(s)   target figure height {TARGET_H:.0f}px of {SIZE}')

clean = {}
for n in names:
    a = np.asarray(Image.open(os.path.join(RAW_DIR, n)).convert('RGBA')).astype(np.float32)
    dust = int(((a[..., 3] > 0) & (a[..., 3] <= ALPHA_FLOOR)).sum())
    a[..., 3], cloud, dn, dp = keep_figure(a[..., :3], a[..., 3], GLUE_PX)
    clean[n] = a
    print(f'  {n}: padding (alpha<={ALPHA_FLOOR}) {dust:7d} px dropped   '
          f'black-field cloud {cloud:7d} px dropped   '
          f'detached {dn:3d} comp / {dp:6d} px dropped   kept {int((a[...,3] > 0).sum()):7d} px')

if MASTERS:
    os.makedirs(MASTERS, exist_ok=True)
    for n in names:
        Image.fromarray(np.clip(clean[n], 0, 255).round().astype(np.uint8), 'RGBA').save(
            os.path.join(MASTERS, n))
    print(f'  cleaned full-resolution masters -> {MASTERS}')

# --- measurements ---
meas = {}
for n in names:
    m = clean[n][..., 3] > 128
    ys, xs = np.nonzero(m)
    top, bot = int(ys.min()), int(ys.max())
    H = bot - top
    band = np.zeros_like(m)
    band[int(top + H * 0.40):int(top + H * 0.50)] = m[int(top + H * 0.40):int(top + H * 0.50)]
    meas[n] = dict(top=top, bot=bot, H=H, head_cx=float(xs[ys < top + H * 0.10].mean()))

# --- one shared scale, and a per-frame translation onto rigid landmarks ---
scale = TARGET_H / float(np.median([meas[n]['H'] for n in names]))
soles = {n: meas[n]['bot'] for n in names}
median_sole = float(np.median(list(soles.values())))
airborne = 0.04 * float(np.median([meas[n]['H'] for n in names]))
grounded = {n for n, y in soles.items() if y >= median_sole - airborne}
ground = min(soles[n] for n in grounded)
base_dy = SIZE - BOTTOM_MARGIN - ground * scale

shift = {}
for n in names:
    dx = int(round(SIZE / 2 - meas[n]['head_cx'] * scale))
    dy = int(round(base_dy - (soles[n] - ground) * scale)) if n in grounded else int(round(base_dy))
    shift[n] = (dx, dy)

print(f'\n  figure height: {[meas[n]["H"] for n in names]}  spread='
      f'{max(meas[n]["H"] for n in names) - min(meas[n]["H"] for n in names)} px')
print(f'  shared scale={scale:.4f}   on the ground: {len(grounded)}/{len(names)}')
print('  per-frame placement: ' + ', '.join(f'{n[4:5]}=({shift[n][0]:+d},{shift[n][1]:+d})' for n in names))


def resize_frame(a, scale, dx, dy, size):
    al = a[..., 3:4] / 255.0
    src_rgb = a[..., :3] * al
    src_a = a[..., 3]
    tw = max(1, int(round(a.shape[1] * scale)))
    th = max(1, int(round(a.shape[0] * scale)))

    def rs(ch):
        return np.asarray(Image.fromarray(ch.astype(np.float32), mode='F').resize((tw, th), Image.LANCZOS))

    rgb = np.stack([rs(src_rgb[..., i]) for i in range(3)], axis=2)
    A = np.clip(rs(src_a), 0, 255)
    rgb = np.clip(rgb / np.maximum(A / 255.0, 1e-6)[..., None], 0, 255)

    canvas = np.zeros((size, size, 4), np.float32)
    x0, y0 = max(0, dx), max(0, dy)
    sx0, sy0 = max(0, -dx), max(0, -dy)
    cw = min(tw - sx0, size - x0)
    ch = min(th - sy0, size - y0)
    if cw > 0 and ch > 0:
        canvas[y0:y0 + ch, x0:x0 + cw, :3] = rgb[sy0:sy0 + ch, sx0:sx0 + cw]
        canvas[y0:y0 + ch, x0:x0 + cw, 3] = A[sy0:sy0 + ch, sx0:sx0 + cw]
    return canvas


os.makedirs(OUT_DIR, exist_ok=True)
tiles = []
for n in names:
    dx, dy = shift[n]
    out = np.clip(resize_frame(clean[n], scale, dx, dy, SIZE), 0, 255).round().astype(np.uint8)
    # last guard: nothing detached may survive at output resolution either
    al = out[..., 3]
    lab, sizes, _ = label8(al > 0)
    if len(sizes) > 1:
        main = int(np.argmax(sizes[1:])) + 1
        glue = dilate(lab == main, 2)
        for i in range(1, len(sizes)):
            sel = lab == i
            if i != main and not (glue & sel).any():
                al[sel] = 0
        out[..., 3] = al
    Image.fromarray(out, 'RGBA').save(os.path.join(OUT_DIR, n))
    a8 = out[..., 3]
    ys, xs = np.nonzero(a8 > 8)
    print(f'  wrote {n}: opaque={int((a8 > 8).sum()):6d}  partial={int(((a8 > 0) & (a8 < 250)).sum()):5d}  '
          f'bbox=x[{xs.min()},{xs.max()}] y[{ys.min()},{ys.max()}]')
    tiles.append(out)

if SHEET:
    sheet = Image.new('RGB', (3 * SIZE + 4 * 6, 2 * SIZE + 3 * 6), (25, 25, 25))
    for i, t in enumerate(tiles):
        a = t.astype(np.float32)
        m = a[..., 3:4] / 255.0
        bg = np.zeros((SIZE, SIZE, 3), np.float32)
        bg[..., 0] = 255
        bg[..., 2] = 255
        im = Image.fromarray((a[..., :3] * m + bg * (1 - m)).astype(np.uint8))
        ImageDraw.Draw(im).text((4, 3), names[i].replace('.png', ''), fill=(0, 0, 0))
        sheet.paste(im, (6 + (i % 3) * (SIZE + 6), 6 + (i // 3) * (SIZE + 6)))
    sheet.save(SHEET)
    print(f'  review sheet -> {SHEET}')
print('\ndone')
