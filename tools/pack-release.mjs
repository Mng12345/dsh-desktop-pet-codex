#!/usr/bin/env node
/**
 * Build the plugin's release tarball.
 *
 * The pet window is a native binary, so a source-only install cannot work for
 * most people: building it needs Rust, the pinned toolchain and several
 * minutes, and the plugin market deliberately refuses to run install scripts.
 * The market's own preference order is a registry package first, then a
 * prebuilt GitHub Release archive, and only then the repository source — so
 * this produces the prebuilt archive: the plugin exactly as it must be
 * installed, with the compiled JavaScript in `lib/` and one window binary per
 * platform under `bin/<platform>-<arch>/`.
 *
 * One archive holding every platform is what lets a single install URL work on
 * Windows, macOS and Linux: the plugin picks the binary for the machine it runs
 * on, so the same download serves everyone and nothing is built locally. The
 * cost is size — four binaries instead of one.
 *
 * The binaries are not in git (see .gitignore): they are per-platform build
 * products and belong in the release asset. The frames *are* in git, so a
 * checkout can build her without regenerating anything.
 *
 * Usage:
 *   node tools/pack-release.mjs                 # build this platform, then pack
 *   node tools/pack-release.mjs --skip-build    # pack plugin/bin exactly as staged
 *   node tools/pack-release.mjs --require-all   # refuse unless all four are staged
 *   node tools/pack-release.mjs --out dist      # where the .tgz lands (default .ref/release)
 *
 * CI builds the four targets on four runners, collects them under plugin/bin,
 * and calls this with --skip-build --require-all, so a release cannot go out
 * with a platform silently missing.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const flagValue = (name, fallback) => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : fallback;
};

const PET_APP = path.join(root, 'pet-app');
const PLUGIN = path.join(root, 'plugin');
const FRAMES = path.join(PET_APP, 'public', 'frames');
// Cargo names the artifact after the crate, and only Windows adds `.exe`; the
// directory has no `--target` subdirectory because the build is native.
const builtBinary = process.platform === 'win32' ? 'dsh-desktop-pet.exe' : 'dsh-desktop-pet';
const EXE = path.join(PET_APP, 'src-tauri', 'target', 'release', builtBinary);
const OUT = path.resolve(root, flagValue('--out', path.join('.ref', 'release')));
const SKIP_BUILD = argv.includes('--skip-build');
const REQUIRE_ALL = argv.includes('--require-all');

/** Every platform the release carries: its directory and the file it is built as. */
const TARGETS = [
  { target: 'win32-x64', binary: 'dsh-desktop-pet.exe' },
  { target: 'linux-x64', binary: 'dsh-desktop-pet' },
  { target: 'darwin-arm64', binary: 'dsh-desktop-pet' },
  { target: 'darwin-x64', binary: 'dsh-desktop-pet' },
];
const BIN = path.join(PLUGIN, 'bin');
const localTarget = `${process.platform}-${process.arch}`;
const local = TARGETS.find((entry) => entry.target === localTarget);

/** Run a command, streaming nothing but failing loudly with its output. */
const run = (command, args, cwd) => {
  process.stdout.write(`  $ ${command} ${args.join(' ')}   (in ${path.relative(root, cwd) || '.'})\n`);
  try {
    return execFileSync(command, args, { cwd, encoding: 'utf8', shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const out = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim();
    throw new Error(`${command} ${args.join(' ')} failed${out ? `:\n${out}` : ` (exit ${error.status})`}`);
  }
};

const fail = (message) => {
  console.error(`\npack-release: ${message}\n`);
  process.exit(1);
};

const pluginPkg = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'package.json'), 'utf8'));
console.log(`packing ${pluginPkg.name}@${pluginPkg.version}`);

// --- 1. the artwork has to be present, or the window would ship empty -------
const frames = fs.existsSync(FRAMES) ? fs.readdirSync(FRAMES).filter((f) => f.endsWith('.png')) : [];
if (frames.length < 34) {
  fail(
    `only ${frames.length} of the 34 pose frames are in pet-app/public/frames/.\n` +
      `  They are committed to this repository, so a working checkout has them.\n` +
      `  If they are missing, check that .gitignore does not exclude them, or\n` +
      `  regenerate them with the two commands below:\n` +
      `    powershell -File tools/prepare-pet-image.ps1 -Source <your-image>\n` +
      `    node tools/gen-pet-frames.mjs --reference .ref/art/pet-512-short-a.png --all\n` +
      `  Packing without them would ship a window that draws nothing.`,
  );
}
console.log(`  artwork: ${frames.length} frames`);

// --- 2. build this platform's window, then stage it under bin/<target>/ ----
if (SKIP_BUILD) {
  console.log(`  --skip-build: packing ${path.relative(root, BIN)} exactly as staged`);
} else {
  if (!local) {
    fail(`this machine is ${localTarget}, which is not one of the shipped targets`);
  }
  // `npm run build` runs tsc, copy-static and cargo with the working directory
  // inside the repository, which is what lets rustup find the pinned toolchain
  // in rust-toolchain.toml. Invoking cargo from elsewhere silently falls back
  // to the machine's stable channel and fails the MSRV check.
  run('npm', ['run', 'build'], PET_APP);
  if (!fs.existsSync(EXE)) fail(`no executable at ${path.relative(root, EXE)} — run without --skip-build`);

  const staged = path.join(BIN, local.target, local.binary);
  fs.mkdirSync(path.dirname(staged), { recursive: true });
  try {
    fs.copyFileSync(EXE, staged);
  } catch (error) {
    // Windows refuses to replace a running executable, and on this project the
    // running one is usually the pet window itself. CI has nothing running, so
    // this is a local-pack concern only — but say so, rather than leaking EBUSY.
    if (error.code === 'EBUSY' || error.code === 'EPERM' || error.code === 'EACCES') {
      fail(
        `${path.relative(root, staged)} is in use, so it cannot be replaced.\n` +
          `  The pet window is running from it. Hiding it is not enough — the\n` +
          `  process is what holds the file — so end it first:\n` +
          `    Stop-Process -Name dsh-desktop-pet\n` +
          `  Nothing runs during a CI pack, so this only affects packing on this machine.`,
      );
    }
    throw error;
  }
  console.log(`  window binary: ${path.relative(root, staged)}  ${(fs.statSync(staged).size / 1048576).toFixed(2)} MiB`);
}

// --- 3. which platforms are actually staged -------------------------------
const staged = TARGETS.map((entry) => ({ ...entry, file: path.join(BIN, entry.target, entry.binary) })).filter(
  (entry) => fs.existsSync(entry.file),
);
const stagedTargets = new Set(staged.map((entry) => entry.target));
const absent = TARGETS.filter((entry) => !stagedTargets.has(entry.target)).map((entry) => entry.target);
if (staged.length === 0) {
  fail(
    `nothing is staged under ${path.relative(root, BIN)}.\n` +
      `  Build this platform first (drop --skip-build), or put a CI artifact for\n` +
      `  each target at bin/<platform>-<arch>/ — that is how the release job packs\n` +
      `  all four into one archive.`,
  );
}
if (REQUIRE_ALL && absent.length > 0) {
  fail(
    `--require-all was given, but ${absent.join(', ')} ${absent.length === 1 ? 'is' : 'are'} not staged.\n` +
      `  The release job downloads one artifact per target before packing; a release\n` +
      `  is never built from a partial tree.`,
  );
}
for (const entry of staged) {
  console.log(`  ${entry.target}: ${(fs.statSync(entry.file).size / 1048576).toFixed(2)} MiB`);
}
if (absent.length > 0) {
  console.log(`  not staged: ${absent.join(', ')} — the archive will install without a window there`);
}

// --- 3b. never ship a binary that names the machine it was built on --------
// Rust writes the source path of every panic location into the executable, so a
// build made on a laptop names that laptop's home directory and checkout. That
// is why the release workflow remaps both prefixes; the check below is what
// stops a local pack from ever being published. The CI runner's own account and
// workspace are allowed through, so CI never trips it.
const CI_HOMES = new Set(['runner', 'runneradmin']);
const CI_WORKSPACES = [/[\\/]a[\\/]/, /[\\/]_work[\\/]/, /runneradmin/, /[\\/]runner[\\/]/];
const home = os.homedir();
const homeVariants = [...new Set([home, home.replaceAll('\\', '/')])].filter((value) => value.length > 2);
const rootVariants = [...new Set([root, root.replaceAll('\\', '/')])];
const ciHome = CI_HOMES.has(path.basename(home));
const ciWorkspace = CI_WORKSPACES.some((pattern) => pattern.test(root));
const leaks = [];
for (const entry of staged) {
  const text = fs.readFileSync(entry.file).toString('latin1');
  if (!ciHome && homeVariants.some((variant) => text.includes(variant))) leaks.push(`${entry.target}: ${home}`);
  const namesRepo = rootVariants.some((variant) => text.includes(variant));
  if (namesRepo && ciWorkspace) {
    console.log(`  note: ${entry.target} still names the runner workspace — the remap may not have applied`);
  } else if (namesRepo) {
    leaks.push(`${entry.target}: ${root}`);
  }
}
if (leaks.length > 0) {
  fail(
    `the window binary names the machine it was built on:\n` +
      leaks.map((leak) => `    ${leak}\n`).join('') +
      `  Rust records the source path of every panic site, so publishing this file\n` +
      `  would publish that path to everyone who installs it. Rebuild with the paths\n` +
      `  remapped — the release workflow sets exactly this:\n` +
      `    pwsh:  $env:RUSTFLAGS = "--remap-path-prefix=$env:USERPROFILE=~"\n` +
      `    sh:    RUSTFLAGS="--remap-path-prefix=$HOME=~"\n` +
      `  then run this script again.`,
  );
}
console.log('  builder paths: none');

// --- 4. pack: `prepare` builds lib/ as part of this ------------------------
fs.mkdirSync(OUT, { recursive: true });
const packed = run('npm', ['pack', '--pack-destination', OUT], PLUGIN)
  .trim()
  .split(/\r?\n/)
  .filter(Boolean)
  .pop();
const tarball = path.join(OUT, path.basename(packed));

// --- 5. prove the tarball is installable ----------------------------------
const listing = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
  .split(/\r?\n/)
  .filter(Boolean);
const required = [
  'package/package.json',
  'package/lib/index.js',
  'package/client.js',
  'package/cordis.patch.yml',
  'package/locale',
  ...staged.map((entry) => `package/bin/${entry.target}/${entry.binary}`),
];
const missing = required.filter((want) => !listing.some((entry) => entry === want || entry.startsWith(`${want}/`)));
if (missing.length > 0) fail(`the tarball is missing ${missing.join(', ')} — it would install as a broken plugin`);

const name = JSON.parse(
  execFileSync('tar', ['-xzOf', tarball, 'package/package.json'], { encoding: 'utf8' }),
).name;
if (name !== pluginPkg.name) fail(`the tarball declares "${name}", not "${pluginPkg.name}"`);

console.log(`  tarball: ${listing.length} entries, ${(fs.statSync(tarball).size / 1048576).toFixed(2)} MiB`);
console.log(`  contains: ${required.join(', ')}`);

// The install URL is derived from the manifest rather than written out here, so
// it cannot drift from the repository the package claims to live in.
const repository = pluginPkg.repository;
const repositoryUrl = typeof repository === 'string' ? repository : repository?.url ?? '';
const slug = repositoryUrl
  .replace(/^git\+/, '')
  .replace(/^https?:\/\/github\.com\//, '')
  .replace(/\.git$/, '');
console.log(`\n${tarball}`);
console.log(`\nNext: attach that file to a GitHub Release. This script is what`);
console.log(`.github/workflows/release.yml runs, so pushing a v* tag publishes it, and`);
console.log(`the install URL is then`);
console.log(`  https://github.com/${slug || '<owner>/<repo>'}/releases/latest/download/dsh-desktop-pet-codex.tgz`);
console.log(`which the README quotes. A local pack cannot be published while a binary`);
console.log(`still carries this machine's paths — see the check above.`);
