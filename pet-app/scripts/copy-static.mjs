/**
 * Copy the static shell into the build output.
 *
 * `tsc` only emits JavaScript, and the Tauri build embeds `../dist` verbatim,
 * so everything in `public/` has to be placed there explicitly — including the
 * pet artwork, which is why this copies the whole directory rather than a
 * hard-coded list that silently goes stale.
 *
 * A copy step is used instead of a bundler because the frontend has no module
 * dependencies at all.
 */
import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const from = join(root, 'public')
const to = join(root, 'dist')

mkdirSync(to, { recursive: true })

const copied = []
for (const name of readdirSync(from)) {
  const source = join(from, name)
  // Keep the compiled JavaScript; replace only the entries this directory owns.
  // Directories are copied whole, so the pose frames under `public/frames/`
  // reach the build without a second list to keep in step.
  rmSync(join(to, name), { recursive: true, force: true })
  cpSync(source, join(to, name), { recursive: true })
  copied.push(name)
}
console.log(`copied into dist/: ${copied.join(', ')}`)
