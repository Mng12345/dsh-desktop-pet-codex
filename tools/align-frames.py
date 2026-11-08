"""Normalise a scene's frames onto one ground line and one centre.

Chaining references fixes the details — the shoes and socks now match across a
scene — but it loosens the framing, because each frame follows the previous
frame's pose and its position along with it. Measured on the chained set, the
feet line wandered up to 9 px inside a scene where independent generation had
held it to 1 px.

This puts every frame of a scene back on the same footing, once, after keying:

- the **feet line** of the grounded frames is snapped to the highest of them,
  so every shift is upward and nothing is clipped at the bottom edge;
- the **horizontal centre** is snapped to the scene's median;
- **airborne** frames keep their height, because being off the ground is the
  animation. They are told apart by distance from the scene's median feet line,
  which puts the run's and the jump's flight frames on the right side of it.

Usage: align-frames.py <frames-dir> [--dry-run]
"""
import os
import statistics
import sys

from PIL import Image

frames_dir = sys.argv[1]
dry_run = '--dry-run' in sys.argv

# A frame whose feet are more than this far above the scene's median is flying,
# not misaligned: the run's flight frames sit ~36 px up, its planted ones ~0.
AIRBORNE_MARGIN = 12

names = sorted(f for f in os.listdir(frames_dir) if f.endswith('.png'))
groups = {}
for name in names:
    scene = name.split('-')[0]
    groups.setdefault(scene, []).append(name)

for scene, files in sorted(groups.items()):
    frames = {f: Image.open(os.path.join(frames_dir, f)).convert('RGBA') for f in files}

    feet = {}
    centres = {}
    for f, image in frames.items():
        box = image.getchannel('A').getbbox()
        if box is None:
            continue
        feet[f] = box[3]
        centres[f] = (box[0] + box[2]) / 2

    median_feet = statistics.median(feet.values())
    grounded = {f: y for f, y in feet.items() if y >= median_feet - AIRBORNE_MARGIN}
    if not grounded:
        continue
    ground = min(grounded.values())
    target_cx = statistics.median(centres.values())

    moved = []
    for f, image in frames.items():
        dy = (ground - feet[f]) if f in grounded else 0
        dx = round(target_cx - centres[f])
        if dx == 0 and dy == 0:
            continue
        shifted = Image.new('RGBA', image.size, (0, 0, 0, 0))
        shifted.paste(image, (dx, dy))
        moved.append(f'{f}({dx:+d},{dy:+d})')
        if not dry_run:
            shifted.save(os.path.join(frames_dir, f))

    print(f'{scene:<7} ground={ground} centre={target_cx:.0f}  grounded={len(grounded)}/{len(frames)}  moved: {" ".join(moved) or "none"}')

print('dry run — nothing written' if dry_run else 'frames rewritten in place')
