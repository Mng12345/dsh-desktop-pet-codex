#!/usr/bin/env node
/**
 * Generate the pet's action frames from one reference sprite.
 *
 * Frames are generated **in sequence**, and every frame after the first is an
 * edit of several references at once: the original sprite, the first frame of
 * the scene, and the frame immediately before it. Three things make that the
 * right shape:
 *
 * - the original is always present, so identity cannot walk away from the
 *   character no matter how long the scene is;
 * - the previous frame is what makes the motion continuous — the model can see
 *   where the limb was, so the next phase is a small step from it;
 * - the first frame is the scene's own anchor, which stops the *pose* drifting
 *   even when the intermediate frames are imperfect.
 *
 * Carrying the whole back catalogue instead would average the references, and
 * the pose would stop moving. This is why a frame that fails its detail check
 * must be regenerated before the next one is built on top of it: an error here
 * is inherited by every frame after it.
 *
 * The endpoint is multipart and this deployment reaches the gateway through a
 * local proxy that Node's own fetch does not reliably pick up, so the request
 * goes through curl with an explicit --proxy.
 *
 * Usage:
 *   node tools/gen-pet-frames.mjs                      # list the plan
 *   node tools/gen-pet-frames.mjs --scene run          # one scene, chained
 *   node tools/gen-pet-frames.mjs --scene run --only run-4,run-5,run-6
 *   node tools/gen-pet-frames.mjs --all                # every scene, chained
 *   node tools/gen-pet-frames.mjs --reference <sprite.png> --scene idle
 *
 * Flags:
 *   --reference <png>   the identity anchor (default .ref/art/pet-512-short-a.png)
 *   --scene <name>      which scene to build
 *   --only a,b,c        rebuild just these frames; the chain restarts at the first
 *   --transparent       ask for a real alpha cut-out rather than a black field
 *
 * Output: .ref/art/frames/<name>.png  (raw: black background, gateway size)
 *
 * The run scene is generated as two independent halves, each grown from the
 * profile anchor `--reference .ref/art/frames/side-1.png`:
 *   ... --reference .ref/art/frames/side-1.png --scene run --only run-1,run-2,run-3 --transparent
 *   ... --reference .ref/art/frames/side-1.png --scene run --only run-4,run-5,run-6 --transparent
 * then finalised with tools/finalize-run.py and checked with
 * tools/verify-run-cycle.py.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Flags are stripped before the remaining words are read as frame names. */
const argv = process.argv.slice(2);
const flagValue = (name) => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};
const REFERENCE =
  flagValue('--reference') !== undefined
    ? path.resolve(flagValue('--reference'))
    : path.join(root, '.ref', 'art', 'pet-512-short-a.png');

/** Ask the gateway for a real cut-out instead of a black field to key. */
const TRANSPARENT = argv.includes('--transparent');

const OUT_DIR = path.join(root, '.ref', 'art', 'frames');
const MODEL = 'gpt-image-2';
const BASE_URL = 'https://apiforyou.com/v1/images/edits';
const KEY_ENV = 'PI_ZCODE_APIFORYOU_API_KEY';

/** The shared instruction: change the pose, preserve every other pixel. */
const KEEP = [
  'Keep this character completely identical to the reference images:',
  'the same face, the same eyes, the same dark navy blue bob hair,',
  'the same translucent whale-fin ears, the same blue whale hair clip,',
  'the same white sailor dress with navy trim, navy bow and whale print,',
  'the same whale pendant choker, and above all',
  'THE SAME NAVY SHOES AND THE SAME WHITE KNEE SOCKS —',
  'the shoes and socks must match the references exactly, detail for detail.',
  'The same art style, line work and colours. Change only the pose:',
].join(' ');

const SUFFIX = [
  'She stays the same size and in the same place in the frame.',
  'Full body visible, centered.',
  'The background is a perfectly flat, uniform, pure black field.',
  'No gradient, no glow, no halo, no drop shadow, no texture and no scenery behind her;',
  'every pixel that is not part of her is exactly black.',
  'No extra objects, square composition.',
].join(' ');

/**
 * `--transparent` asks the gateway itself for the cut-out.
 *
 * Keying the rendered art by threshold works for a black field but not for
 * everything the model puts on one: a first pass at a cleaner background clause
 * enumerated the artefacts to avoid — no speck, no grain, no cloud, no vignette,
 * no rim light — and got every one of them, grey smoke in two frames and a
 * white rim glow in all six. Naming an artefact is the surest way to get it, so
 * the clause above is deliberately short. Where the model still leaves debris,
 * this flag removes the guesswork: the matte comes from the gateway, and the
 * only job left is to sanitise it (see tools/finalize-run.py).
 */
const SUFFIX_TRANSPARENT = [
  'She stays the same size and in the same place in the frame.',
  'Full body visible, centered.',
  'The background is fully transparent: cut her out cleanly with no background',
  'of any kind, no glow, no halo, no drop shadow, no texture and no scenery',
  'behind her. Nothing but she herself is drawn. No extra objects, square composition.',
].join(' ');

/** Facing the viewer, which is what every scene but the run wants. */
const FRONT = 'She faces the viewer.';

/**
 * Her head must not change size between frames.
 *
 * Measured on a fixed cycle, the blue whale hair clip covered 1871 and 1887 px
 * in the two contact frames but 2332-2682 px in the other four — the head was
 * about 12% smaller in those two, while the shoes (the body's own rigid ruler)
 * were identical. A head that changes size between frames reads as the head
 * pulsing, which is far more noticeable than any pose error, so it is stated
 * rather than left to chance. tools/verify-run-cycle.py measures it.
 */
const HEAD_LOCK = [
  'IMPORTANT: her head, her face and her hair are EXACTLY the same size as in',
  'the reference images, at exactly the same scale relative to her body. Do not',
  'enlarge or shrink her head, do not enlarge or shrink her face, and do not',
  'change the size of the blue whale hair clip — it stays the size it has in the',
  'references, relative to her body.',
].join(' ');

/**
 * The run is the one scene drawn in profile.
 *
 * A stride read from the front is a pair of knees pumping at the camera; the
 * pose only says "running" from the side. The view is stated once per scene
 * rather than per frame so it cannot drift between frames of the same stride.
 */
const PROFILE = 'Her whole body is turned to her right and seen in full profile, running towards the right of the frame.';

/** Which scenes are not drawn facing the viewer. */
const VIEWS = { side: PROFILE, run: PROFILE };

/**
 * The frame plan: four scenes, plus the bits of business that belong to the
 * idle one.
 *
 * Every frame is a *phase of one continuous motion* — `run-2` is the top of the
 * stride, `wait-4` is the top of the arm's swing, `happy-4` is the jump. The
 * order inside a scene is the running order, because that is also the order
 * they are generated in.
 */
const SCENES = {
  // --- idle: a standing breath cycle with a blink and a head tilt ---
  idle: [
    { name: 'idle-1', pose: 'she stands upright with both hands resting in front of her, eyes open, calm gentle smile, chest lifted at the top of a slow breath' },
    { name: 'idle-2', pose: 'the same standing pose, her shoulders relaxed and slightly lowered as the breath goes out, eyes open, calm smile' },
    { name: 'idle-3', pose: 'the same standing pose, her eyelids half lowered and drowsy, calm smile' },
    { name: 'idle-4', pose: 'the same standing pose, her eyes fully closed in a blink, calm smile' },
    { name: 'idle-5', pose: 'the same standing pose, her head tilted a little to her right, eyes open, mildly curious' },
    { name: 'idle-6', pose: 'the same standing pose, her head tilted a little to her left, eyes open, calm' },
  ],

  // --- side: the profile anchor the run is grown from ---
  //
  // Not played. The reference sprite faces the viewer, and asking an edit for a
  // profile stride while also telling it to keep the character identical gets a
  // half-turn at best. So the profile is established once, on its own, and the
  // run scene is then chained from this frame instead of from the front sprite.
  side: [
    { name: 'side-1', pose: 'she stands still in full profile: her body turned to her right, her arms relaxed at her sides, her weight even on both feet, calm expression' },
  ],

  // --- run: a full stride cycle, in profile ---
  //
  // Rewritten after a review found the first stride did not run at all. Every
  // frame of it had the same leg in front: the feet swapped which one was
  // raised but never travelled through the pelvis, so the only sustained leg
  // motion was a backward sweep followed by a snap forward, which reads as
  // running backwards. The phases are therefore stated as *positions relative
  // to her hips* — where the planted foot is, and where the other foot is
  // going — because that is the thing that has to move. `near` is the leg on
  // the viewer's side, `far` the one behind it.
  //
  // Three phases per step, two steps: contact, recoil, toe-off. Within each
  // step the support foot must go front -> under -> behind, and the second step
  // must be the same three phases led by the other leg — which is what makes
  // run-4/5/6 look like run-1/2/3 with the legs swapped rather than a copy.
  run: [
    { name: 'run-1', pose: 'she is running at the first contact of the stride. Her NEAR leg is stretched forward and its foot is landing flat on the ground clearly IN FRONT of her hips, the knee almost straight. Her FAR leg is folded up BEHIND her with the knee strongly bent and that foot lifted high off the ground behind her hip. Her far arm is swung forward with the elbow bent and the fist up in front of her chest; her near arm is swung back behind her. She leans slightly forward and smiles' },
    { name: 'run-2', pose: 'the same run a moment later, at the lowest point of the stride. Her NEAR leg is directly under her hips with the knee CLEARLY BENT and the foot flat on the ground, so her hips are noticeably lower than in the previous frame and she is leaning forward over that leg. Her FAR leg has folded up and its knee is swinging forward past her hip, that foot tucked under her and off the ground. Her arms are passing close to her sides' },
    { name: 'run-3', pose: 'the same run a moment later. Her NEAR leg is now extended BEHIND her and only its toe touches the ground, that foot below and behind her hip. Her FAR leg has swung forward and its knee is raised up in FRONT of her hip with that foot lifted well off the ground in front of her. Her near arm is now swung forward and her far arm back. Her body is rising and both heels are off the ground' },
    { name: 'run-4', pose: 'the same run at the next contact, exactly one step later. Her FAR leg is stretched forward and its foot is landing flat on the ground clearly IN FRONT of her hips, the knee almost straight. Her NEAR leg is folded up BEHIND her with the knee strongly bent and that foot lifted high off the ground behind her hip. Her near arm is swung forward with the elbow bent and the fist up in front of her chest; her far arm is swung back behind her. She leans slightly forward and smiles' },
    { name: 'run-5', pose: 'the same run a moment later, at the lowest point of that stride. Her FAR leg is directly under her hips with the knee CLEARLY BENT and the foot flat on the ground, so her hips are noticeably lower than in the previous frame and she is leaning forward over that leg. Her NEAR leg has folded up and its knee is swinging forward past her hip, that foot tucked under her and off the ground. Her arms are passing close to her sides' },
    { name: 'run-6', pose: 'the same run a moment later. Her FAR leg is now extended BEHIND her and only its toe touches the ground, that foot below and behind her hip. Her NEAR leg has swung forward and its knee is raised up in FRONT of her hip with that foot lifted well off the ground in front of her. Her far arm is now swung forward and her near arm back. Her body is rising and both heels are off the ground' },
  ],

  // --- wait: one whole raise-and-lower of the arm ---
  wait: [
    { name: 'wait-1', pose: 'she stands with one arm hanging at her side and her other hand raised to her waist, looking at the viewer expectantly' },
    { name: 'wait-2', pose: 'the same pose with her raised hand lifted to her chest, looking at the viewer expectantly' },
    { name: 'wait-3', pose: 'the same pose with her raised hand lifted to her shoulder, eyebrows slightly raised' },
    { name: 'wait-4', pose: 'the same pose with her raised hand held high above her head, mouth open as if calling out' },
    { name: 'wait-5', pose: 'the same pose with her raised hand coming back down to her shoulder, still looking at the viewer' },
    { name: 'wait-6', pose: 'the same pose with her hand back at her waist, waiting patiently' },
  ],

  // --- happy: a bounce with a cheer ---
  happy: [
    { name: 'happy-1', pose: 'she stands with her arms just beginning to rise, a happy smile forming' },
    { name: 'happy-2', pose: 'her arms are raised to shoulder height, big open smile' },
    { name: 'happy-3', pose: 'both arms raised high above her head in a cheer, big open smile' },
    { name: 'happy-4', pose: 'she jumps up with both arms raised, feet clearly off the ground, joyful open smile' },
    { name: 'happy-5', pose: 'she lands with her knees slightly bent, arms still up, smiling' },
    { name: 'happy-6', pose: 'she stands straight again with her arms lowering, content smile' },
  ],

  // --- the idle scene's own business: a greeting, a heart, a nap ---
  wave: [
    { name: 'wave-1', pose: 'she raises her right hand to her chest, about to wave hello' },
    { name: 'wave-2', pose: 'her right hand is raised beside her shoulder with the palm open, starting to wave hello' },
    { name: 'wave-3', pose: 'her right hand is raised high beside her head, palm open, mid wave, friendly smile' },
    { name: 'wave-4', pose: 'her right hand is coming back down to her side, still smiling' },
  ],
  heart: [
    { name: 'heart-1', pose: 'she brings both hands together in front of her chest' },
    { name: 'heart-2', pose: 'both hands held together in front of her chest making a small heart shape, shy happy smile' },
    { name: 'heart-3', pose: 'her hands begin to separate again, still smiling shyly' },
  ],
  doze: [
    { name: 'doze-1', pose: 'she stands with her head starting to droop and her eyelids lowering, sleepy' },
    { name: 'doze-2', pose: 'she is asleep on her feet, head drooping down, eyes fully closed, arms relaxed at her sides' },
    { name: 'doze-3', pose: 'she suddenly wakes, head snapping up and eyes wide open, slightly startled' },
  ],
};

function readApiKey() {
  const direct = process.env[KEY_ENV];
  if (direct && direct.trim()) return direct.trim();
  const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', KEY_ENV], { encoding: 'utf8', windowsHide: true });
  const line = out.split(/\r?\n/).find((l) => l.includes(KEY_ENV));
  return line.trim().split(/\s{2,}/).pop().trim();
}

/** Ask for one still, conditioned on every reference in `images`. */
function editOnce(prompt, images, outFile) {
  const key = readApiKey();
  const args = ['-sS', '-m', '300'];
  const proxy = (process.env.HTTPS_PROXY || process.env.https_proxy || '').trim();
  if (proxy) args.push('--proxy', proxy);
  args.push(BASE_URL, '-H', `Authorization: Bearer ${key}`, '-F', `model=${MODEL}`, '-F', `prompt=${prompt}`);
  for (const image of images) args.push('-F', `image=@${image};type=image/png`);
  args.push('-F', `size=1024x1024`, '-F', 'n=1', '-o', outFile, '-w', '%{http_code}');
  if (TRANSPARENT) args.push('-F', 'background=transparent', '-F', 'output_format=png');

  const status = execFileSync('curl.exe', args, { encoding: 'utf8', windowsHide: true }).trim();
  const body = fs.readFileSync(outFile, 'utf8');
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error(`HTTP ${status}: non-JSON reply: ${body.slice(0, 200)}`);
  }
  if (json.error) throw new Error(`HTTP ${status}: ${JSON.stringify(json.error).slice(0, 220)}`);
  const item = (json.data || [])[0];
  if (!item?.b64_json) throw new Error(`HTTP ${status}: no image in reply: ${body.slice(0, 200)}`);
  return { json, bytes: Buffer.from(item.b64_json, 'base64') };
}

/** The references for frame `index` of a scene: original, first, previous. */
const referencesFor = (index, names, written) => {
  const images = [REFERENCE];
  const first = written.get(names[0]);
  if (index >= 1 && first !== undefined) images.push(first);
  const previous = index >= 1 ? written.get(names[index - 1]) : undefined;
  if (previous !== undefined && previous !== first) images.push(previous);
  return [...new Set(images)];
};

const sceneNames = Object.keys(SCENES);
const requested = flagValue('--scene');
if (argv.length === 0) {
  for (const [scene, frames] of Object.entries(SCENES)) {
    console.log(`${scene} (${frames.length}): ${frames.map((f) => f.name).join(' ')}`);
  }
  console.log(`\nreference: ${REFERENCE}`);
  process.exit(0);
}

const wanted = argv.includes('--all')
  ? sceneNames
  : requested !== undefined
    ? [requested]
    : sceneNames;
const unknown = wanted.filter((scene) => !sceneNames.includes(scene));
if (unknown.length > 0) {
  console.error(`unknown scene(s): ${unknown.join(', ')}; known: ${sceneNames.join(', ')}`);
  process.exit(1);
}
if (!fs.existsSync(REFERENCE)) {
  console.error(`reference sprite not found: ${REFERENCE}`);
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

for (const scene of wanted) {
  const all = SCENES[scene];
  /**
   * `--only` narrows a scene to some of its frames, and the chain restarts at
   * the first one named. That is how a stride whose second half is a mirror of
   * its first is generated: the mirror is a large edit, and asking for it while
   * the previous half is in the references gets a smeared compromise. Two
   * independent halves, each grown from the scene's reference, do not.
   */
  const only = flagValue('--only');
  const frames =
    only === undefined ? all : all.filter((frame) => only.split(',').includes(frame.name));
  if (frames.length === 0) {
    console.error(`--only matched no frame of "${scene}"`);
    process.exitCode = 1;
    continue;
  }
  const view = VIEWS[scene] ?? FRONT;
  const names = frames.map((frame) => frame.name);
  /** Where each generated frame landed, so later frames can reference it. */
  const written = new Map();

  console.log(`\n--- ${scene}: ${frames.length} frames, chained ---`);
  for (const [index, frame] of frames.entries()) {
    const target = path.join(OUT_DIR, `${frame.name}.png`);
    const scratch = path.join(OUT_DIR, `.${frame.name}.reply.json`);
    const images = referencesFor(index, names, written);
    const continuity =
      index === 0
        ? ''
        : ` This is frame ${index + 1} of ${frames.length} in one continuous motion; it must follow directly from the previous frame.`;
    const prompt = `${KEEP} ${frame.pose}.${continuity} ${view} ${scene === 'run' ? HEAD_LOCK + ' ' : ''}${TRANSPARENT ? SUFFIX_TRANSPARENT : SUFFIX}`;
    const started = Date.now();
    try {
      const { bytes } = editOnce(prompt, images, scratch);
      fs.writeFileSync(target, bytes);
      written.set(frame.name, target);
      console.log(
        `  [${index + 1}/${frames.length}] ${frame.name}: ${bytes.length} bytes, ${((Date.now() - started) / 1000).toFixed(1)}s, refs=${images.length}`,
      );
    } catch (error) {
      console.error(`  [${index + 1}/${frames.length}] ${frame.name}: FAILED — ${error.message}`);
      process.exitCode = 1;
      // Without this frame the next one has nothing to follow, so the scene stops.
      break;
    } finally {
      fs.rmSync(scratch, { force: true });
    }
  }
}
