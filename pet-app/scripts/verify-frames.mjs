/**
 * Run the compiled pose player outside a browser and check it really cycles.
 *
 * `pet-frames.js` imports only a type from `state.js`, so the emitted module has
 * no runtime dependency and runs under Node with a stubbed window and Image.
 * This catches the three failures a typecheck cannot: a frame the tables name
 * but that was never exported, a scene that does not map from its phase, and a
 * clock that never advances.
 */
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const dist = path.join(here, '..', 'dist');

globalThis.window = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};
globalThis.Image = class {
  set src(_value) {
    /* the preload is not what this checks */
  }
};

const { createFramePlayer, FRAME_FILES, SCENES, SEGMENTS, sceneFor, frameUrl } = await import(
  `file:///${path.join(dist, 'pet-frames.js').replace(/\\/g, '/')}`
);

let failures = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

// 1. Every frame the tables name exists on disk in the build.
const missing = FRAME_FILES.filter((frame) => !fs.existsSync(path.join(dist, frameUrl(frame))));
check(FRAME_FILES.length === 34, 'thirty-four distinct frames referenced', `got ${FRAME_FILES.length}`);
check(missing.length === 0, 'every referenced frame exists in dist/', missing.join(', ') || 'none missing');

// 2. Every scene and segment is non-empty, with sane durations.
const badStep = [];
for (const [name, steps] of Object.entries({ ...SCENES, ...SEGMENTS })) {
  if (steps.length === 0) badStep.push(`${name}:empty`);
  for (const step of steps) {
    if (!FRAME_FILES.includes(step.frame)) badStep.push(`${name}:${step.frame}`);
    if (!(step.ms > 0)) badStep.push(`${name}:${step.frame}:ms=${step.ms}`);
  }
}
check(badStep.length === 0, 'all tables use known frames with positive durations', badStep.join(', ') || 'none');

// 3. Every session phase maps to a scene, and the quiet ones stay distinct.
const mapping = {
  running: sceneFor('running'),
  waiting: sceneFor('waiting'),
  completed: sceneFor('completed'),
  stopped: sceneFor('stopped'),
};
check(
  Object.values(mapping).every((scene) => scene in SCENES),
  'every phase maps to a real scene',
  JSON.stringify(mapping),
);
check(mapping.waiting === 'wait' && mapping.completed === 'happy', 'the distinct phases stay distinct');
check(mapping.running === 'run' && mapping.stopped === 'idle', 'working runs, and a stopped turn borrows the quiet scene');

// 4. The clock actually swaps the sprite, and a segment returns to its scene.
const target = { src: '' };
const player = createFramePlayer(target);
const seen = [target.src];
const watch = setInterval(() => {
  if (seen[seen.length - 1] !== target.src) seen.push(target.src);
}, 20);

await new Promise((resolve) => setTimeout(resolve, 2_200));
player.play('run');
await new Promise((resolve) => setTimeout(resolve, 1_200));
player.playSegment('wave');
await new Promise((resolve) => setTimeout(resolve, 1_400));
clearInterval(watch);

const names = seen.map((src) => src.split('/').pop());
check(names[0] === 'idle-1.png', 'starts on the first idle still', names[0]);
check(names.some((n) => n.startsWith('idle-')), 'the idle scene played');
check(names.some((n) => n.startsWith('run-')), 'switching scene switched the stills');
check(names.some((n) => n.startsWith('wave-')), 'the wave segment played');

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
