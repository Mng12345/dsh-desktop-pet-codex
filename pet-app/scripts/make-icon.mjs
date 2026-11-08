/**
 * Generate the window's icon.
 *
 * `tauri-build` requires `icons/icon.ico` to write the Windows resource file,
 * and this project deliberately has no image tooling. A PNG and an ICO are both
 * simple containers, so the artwork is drawn here as pixels and wrapped by
 * hand — which also keeps the icon reproducible from source.
 *
 * Usage: node scripts/make-icon.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const SIZE = 64
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const iconsDir = join(root, 'src-tauri', 'icons')

const INK = [31, 41, 55, 255]
const SKIN = [125, 211, 252, 255]
const DARK = [15, 23, 42, 255]
const CLEAR = [0, 0, 0, 0]

const pixels = new Uint8Array(SIZE * SIZE * 4)

/** Write one pixel, ignoring out-of-bounds coordinates. */
const put = (x, y, color) => {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return
  const at = (y * SIZE + x) * 4
  pixels[at] = color[0]
  pixels[at + 1] = color[1]
  pixels[at + 2] = color[2]
  pixels[at + 3] = color[3]
}

/** Filled rectangle with a corner radius, matching the pet's card shape. */
const roundedRect = (left, top, width, height, radius, color) => {
  for (let y = top; y < top + height; y += 1) {
    for (let x = left; x < left + width; x += 1) {
      const dx = Math.min(x - left, left + width - 1 - x)
      const dy = Math.min(y - top, top + height - 1 - y)
      if (dx < radius && dy < radius) {
        const ox = radius - dx
        const oy = radius - dy
        if (ox * ox + oy * oy > radius * radius) continue
      }
      put(x, y, color)
    }
  }
}

// The card, the pet's head, its ears, eyes and mouth.
roundedRect(2, 2, 60, 60, 13, INK)
roundedRect(20, 12, 8, 8, 2, SKIN)
roundedRect(36, 12, 8, 8, 2, SKIN)
roundedRect(14, 18, 36, 30, 9, SKIN)
roundedRect(22, 27, 7, 8, 2, DARK)
roundedRect(35, 27, 7, 8, 2, DARK)
roundedRect(28, 39, 8, 3, 1, DARK)
roundedRect(20, 50, 24, 7, 3, [52, 211, 153, 255])

// --- PNG -------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

const crc32 = (buffer) => {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const chunk = (type, data) => {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

/** Prefix every scanline with filter type 0, as PNG requires. */
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
for (let y = 0; y < SIZE; y += 1) {
  const rowAt = y * (SIZE * 4 + 1)
  raw[rowAt] = 0
  Buffer.from(pixels.buffer, y * SIZE * 4, SIZE * 4).copy(raw, rowAt + 1)
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // colour type: RGBA
ihdr[10] = 0
ihdr[11] = 0
ihdr[12] = 0

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])

// --- ICO -------------------------------------------------------------------

// A single-entry ICO whose payload is the PNG above; Vista and later read it.
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(1, 4)

const entry = Buffer.alloc(16)
entry[0] = SIZE === 256 ? 0 : SIZE
entry[1] = SIZE === 256 ? 0 : SIZE
entry[2] = 0
entry[3] = 0
entry.writeUInt16LE(1, 4)
entry.writeUInt16LE(32, 6)
entry.writeUInt32LE(png.length, 8)
entry.writeUInt32LE(header.length + entry.length, 12)

mkdirSync(iconsDir, { recursive: true })
writeFileSync(join(iconsDir, 'icon.png'), png)
writeFileSync(join(iconsDir, 'icon.ico'), Buffer.concat([header, entry, png]))
console.log(`wrote icon.png (${png.length} B) and icon.ico (${png.length + 22} B) at ${SIZE}x${SIZE}`)
