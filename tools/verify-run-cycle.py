"""Check a run cycle for the two faults a review of the shipped one found.

The first run frames looked like the character was running backwards, and their
background was full of debris. Neither is visible to a typecheck or to
tools/check-frame-alignment.py, which only looks at framing, so this measures
them directly:

A. **Cleanliness.** Connected components of the alpha mask. A clean cut-out has
   exactly one; every other component is a speck of something that is not her.
B. **The stride.** Two laws a run cannot break:
     * a foot on the ground travels BACKWARD relative to the body (the body
       passes over it), so the support foot's position must sweep steadily back
       and the loop must contain exactly two such sweeps, one per step;
     * a foot in the air travels FORWARD, on its way to the next contact.
   The shipped frames failed this with four direction changes per cycle: the
   support jumped front -> back -> mid -> front, which is a scissor in place and
   is what reads as running backwards. Which leg is which cannot be recovered
   from positions alone (the legs cross, and at the crossing frame both feet are
   in the same place), so the test uses the support foot, which is unambiguous.
C. **Pairing.** Silhouette overlap. A three-phase stride played twice must pair
   up as 1~4, 2~5, 3~6 with the *lowest* mismatch on those pairs; near-identical
   frames anywhere mean the stride stalled.
D. **Consistency.** Figure height, head height, sole line and body centre across
   the loop, so the pet does not jitter or change size while running.

Usage:
  verify-run-cycle.py <frames-dir> [--label NAME]
Exit code is 1 if anything failed.
"""
import os
import sys
from collections import deque

import numpy as np
from PIL import Image

DIR = sys.argv[1]
LABEL = sys.argv[sys.argv.index('--label') + 1] if '--label' in sys.argv else os.path.basename(DIR.rstrip('\\/'))
names = sorted(f for f in os.listdir(DIR) if f.startswith('run-') and f.endswith('.png'))
# int32, not int16: the luminance below multiplies by 587, which overflows int16
# and silently corrupts every colour test downstream.
imgs = {n: np.asarray(Image.open(os.path.join(DIR, n)).convert('RGBA')).astype(np.int32) for n in names}

GROUND_EPS = 0.04
fails = []


def label8(mask):
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


print('=' * 100)
print(f'A. CLEANLINESS  [{LABEL}]')
print('=' * 100)
print(f"{'frame':10} {'opaque':>7} {'partial':>8} {'comps':>6} {'strays':>7} {'straypx':>8}  stray colours")
for n in names:
    a = imgs[n]
    al = a[..., 3]
    op = al > 8
    lab, sizes, comps = label8(op)
    main = int(np.argmax(sizes[1:])) + 1 if len(sizes) > 1 else 0
    strays = sorted(((i, sizes[i]) for i in range(1, len(sizes)) if i != main), key=lambda t: -t[1])
    visible = [s for _, s in strays if s >= 3]
    cols = []
    for i, s in strays[:5]:
        if s < 3:
            continue
        pts = comps[i - 1]
        c = a[pts[:, 0], pts[:, 1], :3].mean(axis=0).astype(int)
        cols.append(f'{s}px@({int(pts[:,1].mean())},{int(pts[:,0].mean())})rgb({c[0]},{c[1]},{c[2]})')
    flag = ''
    if visible:
        flag = '   <-- FAIL'
        fails.append(f'{n}: {sum(visible)} stray px in {len(visible)} components')
    print(f'{n:10} {int(op.sum()):7d} {int(((al>0)&(al<250)).sum()):8d} {len(sizes)-1:6d} '
          f'{len(visible):7d} {sum(visible):8d}  {" | ".join(cols) if cols else "-"}{flag}')

print()
print('=' * 100)
print(f'B. STRIDE  [{LABEL}]  (feet in the pelvis frame; + = in front of the pelvis)')
print('=' * 100)
meas = {}
for n in names:
    a = imgs[n]
    fig = a[..., 3] > 8
    lab, sizes, comps = label8(fig)
    fig = lab == (int(np.argmax(sizes[1:])) + 1)
    ys, xs = np.nonzero(fig)
    top, bot = int(ys.min()), int(ys.max())
    H = bot - top
    band = fig.copy()
    band[:int(top + H * 0.40)] = False
    band[int(top + H * 0.50):] = False
    by, bx = np.nonzero(band)
    pelvis = float(bx.mean())

    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    lum = (r * 299 + g * 587 + b * 114) // 1000
    # Shoes are the darkest compact thing below the waist. Two other dark shapes
    # share that colour and those rows: the skirt's navy hem (much too wide to be
    # a shoe) and the waist bow's ribbon tail (a fixed blob that never leaves the
    # waist band, so its bottom sits above half her height — unlike a shoe, which
    # reaches far lower even when the leg is folded with the heel up).
    lowm = np.zeros_like(fig)
    lowm[int(top + H * 0.35):] = True
    shoe = fig & lowm & (lum < 80) & (b >= r - 6)
    _, ssz, scomp = label8(shoe)
    feet = []
    for i in range(1, len(ssz)):
        if not (120 <= ssz[i] <= 1800):
            continue
        pts = scomp[i - 1]
        cy, cx = pts[:, 0], pts[:, 1]
        x0, x1 = int(cx.min()), int(cx.max())
        y0, y1 = int(cy.min()), int(cy.max())
        if x1 - x0 + 1 > 62 or y1 - y0 + 1 < 6 or y1 < top + H * 0.50:
            continue
        feet.append(dict(cx=float(cx.mean()), botX=y1, x0=x0, x1=x1, px=int(ssz[i])))
    feet = sorted(feet, key=lambda f: -f['px'])[:2]
    feet.sort(key=lambda f: f['cx'])
    meas[n] = dict(H=H, top=top, bot=bot, pelvis=pelvis, feet=feet, fig=fig,
                   head_cx=float(xs[ys < top + H * 0.10].mean()))
    desc = '  '.join(f'[x{f["x0"]:3d}-{f["x1"]:3d} dx={(f["cx"]-pelvis)/H:+.3f} '
                     f'lift={(bot-f["botX"])/H:.3f}]' for f in feet)
    print(f'{n:10} H={H:3d} pelvis_x={pelvis:6.1f}  {len(feet)} foot( feet): {desc}')

support = []
for n in names:
    m = meas[n]
    if not m['feet']:
        support.append((n, float('nan'), float('nan')))
        continue
    f = min(m['feet'], key=lambda f: m['bot'] - f['botX'])
    support.append((n, (f['cx'] - m['pelvis']) / m['H'], (m['bot'] - f['botX']) / m['H']))

print('\n  support foot (the one on the ground):')
for n, dx, lift in support:
    print(f'    {n}: dx={dx:+.3f}  ' +
          ('on the ground' if lift <= GROUND_EPS else f'LIFTED {lift:.2f}H - no ground contact'))

dxs = [dx for _, dx, _ in support if not np.isnan(dx)]
lifts = [lift for _, _, lift in support if not np.isnan(lift)]
if len(dxs) != len(names):
    fails.append('a frame had no foot detected, so the stride could not be measured')
else:
    p = len(dxs)
    jumps = [i for i in range(p) if dxs[(i + 1) % p] > dxs[i] + 0.02]
    track = ' '.join(f'{dxs[i]:+.2f}' + ('  =>|  ' if i in jumps else '  ->  ')
                     for i in range(p))
    print(f'\n    support track: {track}(back to {dxs[0]:+.2f})')
    print(f'    "=>|" marks the support switching to the other foot')
    print(f'    forward switches: {len(jumps)} at {[names[(i+1) % p][4:6] for i in jumps]}   '
          f'(a run has exactly 2)')
    swept = sum(max(0.0, dxs[i] - dxs[(i + 1) % p]) for i in range(p) if i not in jumps)
    print(f'    total backward travel of the support foot: {swept:.2f}H per cycle')

    on_ground = [i for i, l in enumerate(lifts) if l <= GROUND_EPS]
    if not on_ground:
        fails.append('no frame has a foot on the ground, so the cycle has no support phase')
    if len(jumps) != 2:
        fails.append(f'the support foot changes direction {len(jumps)} times per cycle instead '
                     f'of 2: it does not sweep steadily backward, so the stride reads as a '
                     f'scissor in place / running backwards')
    elif swept < 0.5:
        fails.append(f'the support foot only travels {swept:.2f}H backward per cycle; a stride '
                     f'of this size should sweep about a body-length in all')
    else:
        print(f'    -> two steady backward sweeps per cycle: a left step and a right step')

print()
print('=' * 100)
print(f'C. PAIRING  [{LABEL}]  (silhouette mismatch as % of union)')
print('=' * 100)
print('          ' + ''.join(f'{n[4:6]:>8}' for n in names))
pairs = []
for i, n in enumerate(names):
    row = []
    for j, m in enumerate(names):
        u = (meas[n]['fig'] | meas[m]['fig']).sum()
        v = (meas[n]['fig'] ^ meas[m]['fig']).sum() / u * 100
        row.append(v)
        if i < j:
            pairs.append((v, n, m))
    print(f'{n:8}  ' + ''.join(f'{v:8.1f}' for v in row))
pairs.sort()
print('\n  closest pairs: ' + ', '.join(f'{a[4:6]}~{b[4:6]} {v:.1f}%' for v, a, b in pairs[:3]))
expected = {('run-1.png', 'run-4.png'), ('run-2.png', 'run-5.png'), ('run-3.png', 'run-6.png')}
got = {frozenset((a, b)) for _, a, b in pairs[:3]}
if got != {frozenset(p) for p in expected}:
    fails.append(f'the closest silhouette pairs are {sorted(tuple(sorted(g)) for g in got)}, '
                 f'not 1~4 / 2~5 / 3~6: a three-phase stride played twice should pair that way, '
                 f'and anything else means the stride stalled or the halve differ')
else:
    print('  -> exactly the three phase pairs 1~4 / 2~5 / 3~6, so both steps are present')

print()
print('=' * 100)
print(f'D. CONSISTENCY  [{LABEL}]')
print('=' * 100)
Hs = [meas[n]['H'] for n in names]
tops = [meas[n]['top'] for n in names]
bots = [meas[n]['bot'] for n in names]
pxs = [meas[n]['pelvis'] for n in names]
print(f'  figure height H : {Hs}   spread={max(Hs)-min(Hs)} px ({(max(Hs)-min(Hs))/max(Hs)*100:.1f}%)')
print(f'  head top y      : {tops}   spread={max(tops)-min(tops)} px')
print(f'  sole y          : {bots}   spread={max(bots)-min(bots)} px '
      f'({(max(bots)-min(bots))/max(Hs)*100:.1f}% of H)')
print(f'  pelvis x        : {[round(v) for v in pxs]}   spread={max(pxs)-min(pxs):.1f} px '
      f'({(max(pxs)-min(pxs))/max(Hs)*100:.1f}% of H)')
if (max(Hs) - min(Hs)) / max(Hs) > 0.10:
    fails.append(f'figure height varies by {(max(Hs)-min(Hs))/max(Hs)*100:.0f}% across the loop')
if max(bots) - min(bots) > 0.05 * max(Hs):
    fails.append(f'the sole line moves {max(bots)-min(bots)} px between frames')

print()
print('=' * 100)
print(f'E. HEAD SIZE  [{LABEL}]')
print('=' * 100)
# The head is the part a viewer notices changing size, and it is rigid, so the
# width of the top of the silhouette is a direct read of it. This is the check
# that was missing: the first fixed cycle passed A-D while the contact frames
# had a head 12% smaller than the other four, which reads as the head pulsing.
BAND_FRAC = 0.11
bands = []
for n in names:
    fig = meas[n]['fig']
    top = meas[n]['top']
    H = meas[n]['H']
    band = fig[top:top + max(2, int(H * BAND_FRAC))]
    by, bx = np.nonzero(band)
    bands.append(int(bx.max() - bx.min() + 1))
    print(f'  {n}: head band {bands[-1]:3d} px  ({bands[-1] / H * 100:.1f}% of her height)')
spread = (max(bands) - min(bands)) / float(np.median(bands)) * 100
print(f'  spread {min(bands)}..{max(bands)} = {spread:.1f}% of the median')
if spread > 12:
    fails.append(f'the head varies by {spread:.0f}% across the loop, which reads as the head '
                 f'pulsing; the generator drew it at different sizes in different frames')
else:
    print('  -> the head holds its size across the loop')

print()
print('=' * 100)
if fails:
    print(f'RESULT [{LABEL}]: {len(fails)} PROBLEM(S)')
    for f in fails:
        print(f'  - {f}')
else:
    print(f'RESULT [{LABEL}]: all checks passed')
print('=' * 100)
sys.exit(1 if fails else 0)
