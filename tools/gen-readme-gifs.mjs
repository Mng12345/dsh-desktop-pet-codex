#!/usr/bin/env node
/**
 * Renders the pose animations as GIFs for the README.
 *
 * The window draws its poses from `pet-app/public/frames/` at their authored
 * size. The README needs the same seven animations as files that play on GitHub
 * (animated GIF, not the animated WebP the art previews use), small enough to
 * load a handful on one page, and transparent so the page background shows
 * through in both themes.
 *
 * Everything is done here rather than in a dependency: the frames are 8-bit
 * RGBA PNGs, so `node:zlib` inflates them, a box filter takes them to the
 * README canvas, a median cut builds one palette per animation, and a small
 * GIF89a encoder writes the result. `tools/gen-pet-frames.mjs` remains the tool
 * that *draws* the frames; this one only replays them.
 *
 * The timing tables below mirror `src/SCENES` and `src/SEGMENTS` in
 * `pet-app/src/pet-frames.ts` — same frames, same holds, same loops. If that
 * file changes, this one has to follow; nothing derives one from the other
 * because the source is TypeScript and this is a docs tool with no build step.
 *
 * Usage: `node tools/gen-readme-gifs.mjs [--out <dir>]`
 *
 * @module tools/gen-readme-gifs
 */

import { inflateSync } from 'node:zlib'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const FRAME_DIR = join(REPO, 'pet-app', 'public', 'frames')

/** Side of the square GIF canvas, in pixels. */
const CANVAS = 160

/** Alpha below this (after the box filter) becomes the transparent index. */
const ALPHA_CUTOFF = 128

/**
 * The seven animations: four looping scenes and the three one-shot segments of
 * the idle scene, exactly as the window plays them.
 */
const ANIMATIONS = {
  idle: [
    ['idle-1', 900],
    ['idle-2', 900],
    ['idle-1', 700],
    ['idle-3', 130],
    ['idle-4', 150],
    ['idle-3', 130],
    ['idle-2', 500],
    ['idle-5', 700],
    ['idle-2', 400],
    ['idle-6', 700],
    ['idle-2', 400],
  ],
  run: [
    ['run-1', 130],
    ['run-2', 130],
    ['run-3', 130],
    ['run-4', 130],
    ['run-5', 130],
    ['run-6', 130],
  ],
  wait: [
    ['wait-1', 300],
    ['wait-2', 300],
    ['wait-3', 300],
    ['wait-4', 520],
    ['wait-5', 300],
    ['wait-6', 400],
  ],
  happy: [
    ['happy-1', 220],
    ['happy-2', 220],
    ['happy-3', 260],
    ['happy-4', 360],
    ['happy-5', 240],
    ['happy-6', 400],
  ],
  wave: [
    ['wave-1', 160],
    ['wave-2', 160],
    ['wave-3', 220],
    ['wave-2', 160],
    ['wave-3', 220],
    ['wave-4', 200],
  ],
  heart: [
    ['heart-1', 200],
    ['heart-2', 700],
    ['heart-3', 200],
  ],
  doze: [
    ['idle-2', 500],
    ['doze-1', 900],
    ['doze-2', 2600],
    ['doze-3', 500],
  ],
}

// --- PNG in -----------------------------------------------------------------

/**
 * Inflate one PNG file into RGBA bytes.
 *
 * Only what the frame set actually uses is handled: 8 bits per channel, true
 * colour with alpha, no interlacing. Anything else is a frame the tool does not
 * understand, and saying so beats writing a wrong GIF.
 *
 * @param {string} path - a `.png` under the frame directory.
 * @returns {{ width: number, height: number, data: Uint8Array }} the raster.
 */
const decodePng = (path) => {
  const file = readFileSync(path)
  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  for (let i = 0; i < signature.length; i += 1) {
    if (file[i] !== signature[i]) throw new Error(`${path}: not a PNG`)
  }

  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  const idat = []

  let offset = 8
  while (offset < file.length) {
    const length = file.readUInt32BE(offset)
    const type = file.toString('ascii', offset + 4, offset + 8)
    const body = file.subarray(offset + 8, offset + 8 + length)

    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      bitDepth = body[8]
      colorType = body[9]
      interlace = body[12]
    } else if (type === 'IDAT') {
      idat.push(body)
    } else if (type === 'IEND') {
      break
    }
    offset += length + 12
  }

  if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
    throw new Error(`${path}: expected 8-bit RGBA, non-interlaced`)
  }

  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * 4
  const data = new Uint8Array(stride * height)
  let previous = new Uint8Array(stride)

  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const row = data.subarray(y * stride, (y + 1) * stride)

    for (let x = 0; x < stride; x += 1) {
      const left = x >= 4 ? row[x - 4] : 0
      const up = previous[x]
      const upLeft = x >= 4 ? previous[x - 4] : 0
      let value = line[x]

      if (filter === 1) value += left
      else if (filter === 2) value += up
      else if (filter === 3) value += (left + up) >> 1
      else if (filter === 4) {
        const estimate = left + up - upLeft
        const dLeft = Math.abs(estimate - left)
        const dUp = Math.abs(estimate - up)
        const dUpLeft = Math.abs(estimate - upLeft)
        value += dLeft <= dUp && dLeft <= dUpLeft ? left : dUp <= dUpLeft ? up : upLeft
      } else if (filter !== 0) {
        throw new Error(`${path}: unknown scanline filter ${String(filter)}`)
      }

      row[x] = value & 0xff
    }
    previous = row
  }

  return { width, height, data }
}

// --- resample ---------------------------------------------------------------

/**
 * Box-filter one frame down to the canvas, in premultiplied alpha.
 *
 * Averaging in premultiplied space keeps the transparent margin from bleeding
 * black into the edge of the figure. The result carries the coverage in alpha,
 * which is what the cutoff below turns into the GIF's single transparent index.
 *
 * @param {{ width: number, height: number, data: Uint8Array }} png - the frame.
 * @returns {{ r: Float64Array, g: Float64Array, b: Float64Array, a: Float64Array }}
 *   per-canvas-pixel sums, with `a` as coverage from 0 to 1.
 */
const resample = (png) => {
  const scale = png.width / CANVAS
  const r = new Float64Array(CANVAS * CANVAS)
  const g = new Float64Array(CANVAS * CANVAS)
  const b = new Float64Array(CANVAS * CANVAS)
  const a = new Float64Array(CANVAS * CANVAS)

  for (let y = 0; y < CANVAS; y += 1) {
    const y0 = y * scale
    const y1 = y0 + scale
    for (let x = 0; x < CANVAS; x += 1) {
      const x0 = x * scale
      const x1 = x0 + scale
      let sumR = 0
      let sumG = 0
      let sumB = 0
      let sumA = 0
      let sumW = 0

      for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy += 1) {
        const wy = Math.min(y1, sy + 1) - Math.max(y0, sy)
        for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx += 1) {
          const wx = Math.min(x1, sx + 1) - Math.max(x0, sx)
          const w = wx * wy
          const at = (sy * png.width + sx) * 4
          const alpha = png.data[at + 3] / 255
          sumR += png.data[at] * alpha * w
          sumG += png.data[at + 1] * alpha * w
          sumB += png.data[at + 2] * alpha * w
          sumA += alpha * w
          sumW += w
        }
      }

      const at = y * CANVAS + x
      const coverage = sumA / sumW
      a[at] = coverage
      if (coverage > 0) {
        r[at] = sumR / sumA
        g[at] = sumG / sumA
        b[at] = sumB / sumA
      }
    }
  }

  return { r, g, b, a }
}

// --- palette ----------------------------------------------------------------

/**
 * Median-cut palette for one animation.
 *
 * One palette per animation rather than one per frame: a shared palette keeps
 * the colours from shifting between frames, and it is also what lets the GIF
 * spend its 256 slots on the figure instead of repeating them per frame.
 *
 * @param {readonly (readonly [string, number])[]} frames - the frame stems.
 * @returns {number[][]} RGB triples, at most 255 of them.
 */
const buildPalette = (frames) => {
  const pixels = []
  for (const [stem] of frames) {
    const { r, g, b, a } = resample(decodePng(join(FRAME_DIR, `${stem}.png`)))
    for (let i = 0; i < r.length; i += 1) {
      if (a[i] >= ALPHA_CUTOFF / 255) pixels.push([r[i], g[i], b[i]])
    }
  }

  /** @type {{ pixels: number[][], box: number[] }[]} */
  let boxes = [{ pixels, box: [0, 255, 0, 255, 0, 255] }]

  while (boxes.length < 255) {
    let widest = -1
    let widestSpan = 0
    for (let i = 0; i < boxes.length; i += 1) {
      const { box } = boxes[i]
      const span = Math.max(box[1] - box[0], box[3] - box[2], box[5] - box[4])
      if (boxes[i].pixels.length > 1 && span > widestSpan) {
        widest = i
        widestSpan = span
      }
    }
    if (widest === -1) break

    const { pixels: bucket, box } = boxes[widest]
    const channel = box[1] - box[0] >= box[3] - box[2] && box[1] - box[0] >= box[5] - box[4] ? 0 : box[3] - box[2] >= box[5] - box[4] ? 1 : 2
    bucket.sort((left, right) => left[channel] - right[channel])

    const middle = Math.floor(bucket.length / 2)
    const left = { pixels: bucket.slice(0, middle), box: [...box] }
    const right = { pixels: bucket.slice(middle), box: [...box] }
    left.box[channel * 2] = box[channel * 2]
    left.box[channel * 2 + 1] = bucket[middle - 1][channel]
    right.box[channel * 2] = bucket[middle][channel]
    right.box[channel * 2 + 1] = box[channel * 2 + 1]

    boxes[widest] = left
    boxes.push(right)
  }

  return boxes.map(({ pixels: bucket }) => {
    const sums = [0, 0, 0]
    for (const pixel of bucket) {
      sums[0] += pixel[0]
      sums[1] += pixel[1]
      sums[2] += pixel[2]
    }
    return sums.map((sum) => Math.min(255, Math.round(sum / bucket.length)))
  })
}

// --- GIF --------------------------------------------------------------------

/**
 * Write a GIF89a of the given frames.
 *
 * Index 0 is the transparent slot and keeps the global table at 256 entries, so
 * every frame shares the same table and the LZW stream never has to carry one.
 *
 * @param {Uint8Array[]} images - one index plane per frame.
 * @param {number[]} delays - one hold per frame, in 10 ms units.
 * @param {Uint8Array} palette - RGB triples, colour `i` at `i * 3`.
 * @param {string} path - where to write.
 */
const writeGif = (images, delays, palette, path) => {
  const bytes = []
  const push = (...values) => bytes.push(...values)

  push(0x47, 0x49, 0x46, 0x38, 0x39, 0x61) // GIF89a
  push(CANVAS & 0xff, CANVAS >> 8)
  push(CANVAS & 0xff, CANVAS >> 8)
  push(0xf7) // global table, 256 entries, 8-bit colour resolution
  push(0x00, 0x00)
  push(...palette)
  // The loop extension: play forever.
  push(0x21, 0xff, 0x0b)
  push(...Buffer.from('NETSCAPE2.0', 'ascii'))
  push(0x03, 0x01, 0x00, 0x00, 0x00)

  for (let i = 0; i < images.length; i += 1) {
    // Graphic control: restore to background, transparent index 0.
    push(0x21, 0xf9, 0x04)
    push((2 << 2) | 0x01)
    push(delays[i] & 0xff, (delays[i] >> 8) & 0xff)
    push(0x00, 0x00)
    // Image descriptor.
    push(0x2c, 0x00, 0x00, 0x00, 0x00)
    push(CANVAS & 0xff, CANVAS >> 8)
    push(CANVAS & 0xff, CANVAS >> 8)
    push(0x00)
    push(...lzwEncode(images[i]))
  }
  push(0x3b)

  writeFileSync(path, Buffer.from(bytes))
}

/**
 * LZW-compress one index plane into GIF sub-blocks.
 *
 * @param {Uint8Array} indices - one byte per pixel.
 * @returns {number[]} the code-size byte followed by the sub-blocks.
 */
const lzwEncode = (indices) => {
  const clear = 1 << 8
  const end = clear + 1
  let next = end + 1
  let size = 9

  /** @type {Map<number, number>} */
  let dictionary = new Map()
  const resetDictionary = () => {
    dictionary = new Map()
    next = end + 1
    size = 9
  }

  const out = []
  let bitBuffer = 0
  let bitCount = 0
  const bucket = []
  const flushBucket = () => {
    while (bucket.length > 0) {
      const piece = bucket.splice(0, 255)
      out.push(piece.length, ...piece)
    }
  }
  const emit = (code) => {
    bitBuffer |= code << bitCount
    bitCount += size
    while (bitCount >= 8) {
      bucket.push(bitBuffer & 0xff)
      bitBuffer >>= 8
      bitCount -= 8
    }
    if (bucket.length >= 255) flushBucket()
  }

  out.push(8)
  emit(clear)
  resetDictionary()

  let prefix = indices[0]
  for (let i = 1; i < indices.length; i += 1) {
    const suffix = indices[i]
    const key = (prefix << 8) | suffix
    const known = dictionary.get(key)
    if (known !== undefined) {
      prefix = known
      continue
    }
    emit(prefix)
    dictionary.set(key, next)
    next += 1
    if (next > 1 << size && size < 12) size += 1
    if (next > 4095) {
      emit(clear)
      resetDictionary()
      prefix = suffix
      continue
    }
    prefix = suffix
  }
  emit(prefix)
  emit(end)

  while (bitCount > 0) {
    bucket.push(bitBuffer & 0xff)
    bitBuffer >>= 8
    bitCount -= 8
  }
  flushBucket()
  out.push(0x00) // block terminator
  return out
}

/**
 * Map one frame to index-plane bytes against the animation palette.
 *
 * Nearest colour is memoised on a 4-bit-per-channel grid; the cache keeps a
 * 160x160 plane cheap without changing which colour wins for any pixel that
 * actually appears twice.
 *
 * @param {{ r: Float64Array, g: Float64Array, b: Float64Array, a: Float64Array }} frame - colour.
 * @param {readonly number[][]} palette - the animation palette.
 * @returns {Uint8Array} one byte per pixel.
 */
const indexFrame = (frame, palette) => {
  const indices = new Uint8Array(CANVAS * CANVAS)
  const cache = new Int16Array(4096).fill(-1)

  for (let i = 0; i < indices.length; i += 1) {
    if (frame.a[i] < ALPHA_CUTOFF / 255) continue

    const red = frame.r[i]
    const green = frame.g[i]
    const blue = frame.b[i]
    const key = ((red >> 4) << 8) | ((green >> 4) << 4) | (blue >> 4)
    let best = cache[key]
    if (best === -1) {
      let bestDistance = Infinity
      for (let c = 0; c < palette.length; c += 1) {
        const [pr, pg, pb] = palette[c]
        const distance = (pr - red) ** 2 + (pg - green) ** 2 + (pb - blue) ** 2
        if (distance < bestDistance) {
          bestDistance = distance
          best = c
        }
      }
      cache[key] = best
    }
    indices[i] = best + 1
  }

  return indices
}

// --- main -------------------------------------------------------------------

const outIndex = process.argv.indexOf('--out')
const OUT_DIR = outIndex === -1 ? join(REPO, 'docs', 'states') : process.argv[outIndex + 1]

mkdirSync(OUT_DIR, { recursive: true })

let total = 0
for (const [name, frames] of Object.entries(ANIMATIONS)) {
  const palette = buildPalette(frames)
  const images = []
  const delays = []
  for (const [stem, ms] of frames) {
    images.push(indexFrame(resample(decodePng(join(FRAME_DIR, `${stem}.png`))), palette))
    delays.push(Math.max(2, Math.round(ms / 10)))
  }

  // Index 0 is transparent; the palette starts at slot 1.
  const table = new Uint8Array(256 * 3)
  palette.forEach(([r, g, b], slot) => {
    table[(slot + 1) * 3] = r
    table[(slot + 1) * 3 + 1] = g
    table[(slot + 1) * 3 + 2] = b
  })

  const path = join(OUT_DIR, `${name}.gif`)
  writeGif(images, delays, table, path)
  const size = readFileSync(path).length
  total += size
  console.log(`  ${name.padEnd(6)} ${String(frames.length).padStart(2)} frames  ${String(Math.round(size / 1024)).padStart(4)} KB`)
}
console.log(`  ${'total'.padEnd(6)}                                    ${String(Math.round(total / 1024)).padStart(4)} KB  -> ${OUT_DIR}`)
