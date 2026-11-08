"""Key the generated pet art into a transparent sprite of the requested size.

Two improvements over tools/prepare-pet-image.ps1:

1. Two thresholds instead of one. That script rules a pixel background when
   max(R,G,B) <= 70 and floods inward from the border, so a dark-but-solid part
   of the character whose own line art touches the background — shoes, dark
   ribbon — becomes a channel for the fill and gets eaten hollow. The generated
   background here is essentially pure black, so the flood fill uses a strict
   level (BG_LEVEL) while feathering keeps the original, looser level.

2. Background pockets the character's hair closes off are unreachable from the
   border and survived as opaque blotches in the original pipeline. They are
   identified by colour: a pocket's core is pure black, whereas the darkest
   colour the artwork itself uses is a blue-tinted navy.

Usage: key-sprite.py <raw.png> <out.png> [size] [bg_level] [feather_level]
"""
import sys
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image

ART = Path(__file__).resolve().parent.parent / ".ref" / "art"
RAW = sys.argv[1] if len(sys.argv) > 1 else str(ART / "source.png")
OUT = sys.argv[2] if len(sys.argv) > 2 else str(ART / "pet-512-clean.png")
SIZE = int(sys.argv[3]) if len(sys.argv) > 3 else 512
BG_LEVEL = int(sys.argv[4]) if len(sys.argv) > 4 else 15       # flood fill: "this is background"
FEATHER_LEVEL = int(sys.argv[5]) if len(sys.argv) > 5 else 70  # rim feathering reference
POCKET_LEVEL = 25                                              # enclosed component mean max(RGB)

img = Image.open(RAW).convert("RGB")
arr = np.asarray(img).astype(np.int32)
height, width, _ = arr.shape
brightness = arr.max(axis=2)

ring = np.concatenate([
    brightness[0, :], brightness[-1, :], brightness[:, 0], brightness[:, -1],
])
print(f"input {width}x{height}")
print(f"  border ring brightness: mean={ring.mean():.2f} p99={np.percentile(ring, 99):.0f} "
      f"p99.9={np.percentile(ring, 99.9):.0f} max={ring.max()}")
print(f"  levels: bg<={BG_LEVEL} feather<={FEATHER_LEVEL} pocket_mean<={POCKET_LEVEL}")

dark = brightness <= FEATHER_LEVEL   # wide mask: candidate artwork-or-background
bg = brightness <= BG_LEVEL          # strict mask: definitely background

# --- background reachable from the border, flooded over the STRICT mask only
reachable = np.zeros_like(bg)
queue = deque()
for x in range(width):
    for y in (0, height - 1):
        if bg[y, x] and not reachable[y, x]:
            reachable[y, x] = True
            queue.append((y, x))
for y in range(height):
    for x in (0, width - 1):
        if bg[y, x] and not reachable[y, x]:
            reachable[y, x] = True
            queue.append((y, x))
while queue:
    y, x = queue.popleft()
    for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
        if 0 <= ny < height and 0 <= nx < width and bg[ny, nx] and not reachable[ny, nx]:
            reachable[ny, nx] = True
            queue.append((ny, nx))

# --- enclosed dark components: background pockets or real artwork?
enclosed = dark & ~reachable
removed = reachable.copy()
labels = np.zeros_like(enclosed)
dropped = kept = dropped_px = kept_px = 0
ys, xs = np.nonzero(enclosed)
for seed_y, seed_x in zip(ys, xs):
    if labels[seed_y, seed_x]:
        continue
    component = []
    queue = deque([(seed_y, seed_x)])
    labels[seed_y, seed_x] = 1
    while queue:
        y, x = queue.popleft()
        component.append((y, x))
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                ny, nx = y + dy, x + dx
                if 0 <= ny < height and 0 <= nx < width and enclosed[ny, nx] and not labels[ny, nx]:
                    labels[ny, nx] = 1
                    queue.append((ny, nx))
    coords = np.array(component)
    if brightness[coords[:, 0], coords[:, 1]].mean() <= POCKET_LEVEL:
        removed[coords[:, 0], coords[:, 1]] = True
        dropped += 1
        dropped_px += len(component)
    else:
        kept += 1
        kept_px += len(component)

print(f"  reachable background {int(reachable.sum())} px")
print(f"  enclosed components {dropped + kept}: dropped {dropped} ({dropped_px} px) as pockets, kept {kept} ({kept_px} px) as artwork")

# --- alpha: transparent background, feathered rim (original luminance rule)
touches_removed = np.zeros_like(removed)
for dy in (-1, 0, 1):
    for dx in (-1, 0, 1):
        if dy == 0 and dx == 0:
            continue
        shifted = np.zeros_like(removed)
        ys_from = slice(max(0, -dy), height - max(0, dy))
        xs_from = slice(max(0, -dx), width - max(0, dx))
        ys_to = slice(max(0, dy), height - max(0, -dy))
        xs_to = slice(max(0, dx), width - max(0, -dx))
        shifted[ys_to, xs_to] = removed[ys_from, xs_from]
        touches_removed |= shifted

luminance = (arr[:, :, 0] * 299 + arr[:, :, 1] * 587 + arr[:, :, 2] * 114) // 1000
feather = np.clip(luminance * 255 // FEATHER_LEVEL, 0, 255)
alpha = np.where(removed, 0, np.where(touches_removed, feather, 255)).astype(np.uint8)

# --- premultiplied resize: transparent black must not bleed into the edges
scale = np.float32(alpha) / 255.0
premultiplied = arr.astype(np.float32) * scale[:, :, None]


def resize_float(channel, size):
    return np.asarray(Image.fromarray(channel, mode="F").resize(size, Image.LANCZOS))


target = (SIZE, SIZE)
out_rgb = np.stack([resize_float(premultiplied[:, :, i], target) for i in range(3)], axis=2)
out_alpha = np.clip(resize_float(np.float32(alpha), target), 0, 255)
out_rgb = np.clip(out_rgb / np.maximum(out_alpha / 255.0, 1e-6)[:, :, None], 0, 255)

out = np.dstack([out_rgb, out_alpha]).round().astype(np.uint8)
Image.fromarray(out, "RGBA").save(OUT)

partial = int(((out_alpha > 20) & (out_alpha < 235)).sum())
print(f"wrote {OUT}  {SIZE}x{SIZE}")
print(f"  transparent {int((out_alpha == 0).sum())} px ({(out_alpha == 0).sum() / (SIZE * SIZE) * 100:.1f}%)")
print(f"  partial-alpha (rim/feather) {partial} px ({partial / (SIZE * SIZE) * 100:.2f}%)")
