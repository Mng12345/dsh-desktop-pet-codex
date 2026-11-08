"""Measure alignment across every exported pose frame.

Image-to-image from one reference preserves the character's position, so the
question is whether any per-frame transform is needed at all. Prints each
frame's alpha bounding box, feet line, horizontal centre and silhouette overlap
against the neutral frame, then writes a review sheet with the neutral
silhouette outlined in green over each frame.

Usage: check-frame-alignment.py <frames-dir> [base-name]
"""
import glob
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

frames_dir = sys.argv[1]
base_name = sys.argv[2] if len(sys.argv) > 2 else 'idle-a'

paths = sorted(glob.glob(os.path.join(frames_dir, '*.png')))
if not paths:
    raise SystemExit(f'no frames in {frames_dir}')

# The neutral frame anchors the comparison and is listed first.
order = sorted(paths, key=lambda p: (os.path.splitext(os.path.basename(p))[0] != base_name,
                                     os.path.basename(p)))


def load(path):
    return np.asarray(Image.open(path).convert('RGBA')).astype(np.int16)


base = load([p for p in paths if os.path.splitext(os.path.basename(p))[0] == base_name][0])
base_mask = base[:, :, 3] > 128

print(f"{'frame':<14}{'bbox (x0,y0,x1,y1)':<26}{'w':>5}{'h':>6}{'feet y':>8}{'cx':>8}{'IoU':>8}")
rows = []
for path in order:
    label = os.path.splitext(os.path.basename(path))[0]
    img = load(path)
    mask = img[:, :, 3] > 128
    ys, xs = np.nonzero(mask)
    bbox = (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max()))
    x0, y0, x1, y1 = bbox
    iou = int((mask & base_mask).sum()) / int((mask | base_mask).sum())
    rows.append((label, path, bbox, iou))
    print(f'{label:<14}{str(bbox):<26}{x1 - x0 + 1:>5}{y1 - y0 + 1:>6}{y1:>8}{(x0 + x1) / 2:>8.1f}{iou:>8.3f}')

feet = {r[2][3] for r in rows}
centres = [(r[2][0] + r[2][2]) / 2 for r in rows]
print(f'\nfeet line: min={min(feet)} max={max(feet)} spread={max(feet) - min(feet)} px')
print(f'horizontal centre: min={min(centres):.1f} max={max(centres):.1f} spread={max(centres) - min(centres):.1f} px')

if '--sheet' in sys.argv:
    tiles = []
    for label, path, bbox, iou in rows:
        img = load(path)
        canvas = Image.new('RGBA', (img.shape[1], img.shape[0]), (255, 0, 255, 255))
        canvas.alpha_composite(Image.fromarray(img.astype(np.uint8), 'RGBA'))
        missing = Image.fromarray(((base_mask & ~(img[:, :, 3] > 128)).astype(np.uint8) * 255), 'L')
        outline = Image.new('RGBA', canvas.size, (0, 255, 0, 0))
        outline.putalpha(missing.point(lambda v: 100 if v else 0))
        canvas.alpha_composite(outline)
        tiles.append((label, canvas.convert('RGB')))

    cols = 6
    gap = 8
    cell = tiles[0][1].width
    rows_n = (len(tiles) + cols - 1) // cols
    sheet = Image.new('RGB', (cols * cell + (cols - 1) * gap, rows_n * (cell + 18) + (rows_n - 1) * gap), (24, 24, 24))
    draw = ImageDraw.Draw(sheet)
    for index, (label, tile) in enumerate(tiles):
        x = (index % cols) * (cell + gap)
        y = (index // cols) * (cell + 18 + gap)
        sheet.paste(tile, (x, y))
        draw.text((x + 4, y + cell + 3), label, fill=(200, 200, 200))
    # Diagnostics belong in the scratch tree, never beside the shipped frames.
    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    scratch = os.path.join(repo, '.ref', 'art')
    os.makedirs(scratch, exist_ok=True)
    out = os.path.join(scratch, 'alignment-all.png')
    sheet.save(out)
    print(f'wrote {out}')
