#!/usr/bin/env node
/**
 * Slices NASA's Blue Marble into the raster tile pyramid the globe draws.
 *
 * Run once, by hand, when the imagery or the zoom ceiling changes:
 *
 *     node tools/build-earth-tiles.mjs [--maxz 4] [--quality 78]
 *
 * Not a build step. The output is committed; the 27MB source is not.
 *
 * The one piece of real work here is the projection. Blue Marble is
 * equirectangular — row is linear in latitude — while map tiles are Web
 * Mercator, where row is linear in ln(tan(45° + lat/2)). So the source cannot
 * simply be cut up: every output row has to be resampled from a different place
 * in the source, which is what `mercatorRows` below works out.
 */

import { mkdir, writeFile, stat, rm } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CACHE = path.join(ROOT, 'tools', '.cache')
const OUT = path.join(ROOT, 'web', 'public', 'earth')

/**
 * July rather than December.
 *
 * The Blue Marble set has a frame per month and they are not interchangeable
 * for this: December buries the whole northern landmass under snow, which is
 * exactly where most of the dots are. July is the greenest and the least white,
 * so cities read against land instead of against glare.
 */
const SRC =
  'https://assets.science.nasa.gov/content/dam/science/esd/eo/images/bmng' +
  '/bmng-topography-bathymetry/july/world.topo.bathy.200407.3x21600x10800.jpg'

const TILE = 512

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : Number(process.argv[i + 1])
}

/**
 * How deep the pyramid goes.
 *
 * z4 is 8192px across the equator — about 5km per pixel, which is where Blue
 * Marble itself runs out of detail, so going deeper would only be inventing
 * pixels. Past this the map is overzoomed, which is fine: at city scale the
 * imagery is backdrop and the dots are the subject. Dropping to 3 cuts the
 * committed size from ~13MB to ~3MB at the cost of that last sharpening.
 */
const MAX_Z = arg('maxz', 4)
const QUALITY = arg('quality', 78)

/** Web Mercator's latitude cut-off, where the projection runs to infinity. */
const MAX_LAT = 85.0511287798066

async function download(url, dest) {
  try {
    const s = await stat(dest)
    if (s.size > 1e6) {
      console.log(`source cached (${(s.size / 1e6).toFixed(1)}MB)`)
      return
    }
  } catch {
    /* not cached yet */
  }
  console.log(`downloading ${url}`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest))
  const s = await stat(dest)
  console.log(`  ${(s.size / 1e6).toFixed(1)}MB`)
}

/**
 * For each row of a Web Mercator image N pixels tall, which row of an
 * equirectangular image `srcH` tall it samples from — as a float, so the caller
 * can blend the two neighbours rather than picking one and stair-stepping the
 * coastlines.
 */
function mercatorRows(n, srcH) {
  const rows = new Float64Array(n)
  for (let j = 0; j < n; j++) {
    // Centre of the output row, in 0..1 down the Mercator world.
    const t = (j + 0.5) / n
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * t))) * 180) / Math.PI
    rows[j] = ((90 - lat) / 180) * srcH - 0.5
  }
  return rows
}

async function main() {
  await mkdir(CACHE, { recursive: true })
  await rm(OUT, { recursive: true, force: true })

  const src = path.join(CACHE, 'blue-marble.jpg')
  await download(SRC, src)

  const N = TILE * 2 ** MAX_Z

  // Resampled to a square first. Height is not an aspect ratio here — the
  // vertical axis is only ever used as a latitude lookup — so oversampling it
  // to N keeps the poles from smearing when Mercator stretches them.
  console.log(`resampling source to ${N}x${N} equirectangular…`)
  const { data: eq } = await sharp(src)
    .resize(N, N, { fit: 'fill', kernel: 'lanczos3' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  console.log(`reprojecting to ${N}x${N} Web Mercator…`)
  const merc = Buffer.allocUnsafe(N * N * 3)
  const rows = mercatorRows(N, N)
  const stride = N * 3
  for (let j = 0; j < N; j++) {
    const sy = rows[j]
    const y0 = Math.max(0, Math.min(N - 1, Math.floor(sy)))
    const y1 = Math.min(N - 1, y0 + 1)
    const f = Math.max(0, Math.min(1, sy - y0))
    const o = j * stride
    const a = y0 * stride
    const b = y1 * stride
    if (f === 0) {
      eq.copy(merc, o, a, a + stride)
      continue
    }
    for (let i = 0; i < stride; i++) {
      merc[o + i] = eq[a + i] + (eq[b + i] - eq[a + i]) * f
    }
  }

  let written = 0
  let bytes = 0
  for (let z = 0; z <= MAX_Z; z++) {
    const side = TILE * 2 ** z
    // z === MAX_Z is already the right size; anything shallower is a downsample
    // of the finished Mercator image, so every level stays perfectly registered.
    const level =
      side === N
        ? merc
        : await sharp(merc, { raw: { width: N, height: N, channels: 3 } })
            .resize(side, side, { kernel: 'lanczos3' })
            .raw()
            .toBuffer()

    const jobs = []
    for (let x = 0; x < 2 ** z; x++) {
      await mkdir(path.join(OUT, String(z), String(x)), { recursive: true })
      for (let y = 0; y < 2 ** z; y++) {
        // Cut the tile out of the level by hand: one buffer copy per row beats
        // handing sharp the whole level and asking it to extract, 341 times.
        const tile = Buffer.allocUnsafe(TILE * TILE * 3)
        for (let r = 0; r < TILE; r++) {
          const from = ((y * TILE + r) * side + x * TILE) * 3
          level.copy(tile, r * TILE * 3, from, from + TILE * 3)
        }
        jobs.push(
          sharp(tile, { raw: { width: TILE, height: TILE, channels: 3 } })
            .jpeg({ quality: QUALITY, mozjpeg: true, chromaSubsampling: '4:2:0' })
            .toBuffer()
            .then(async (buf) => {
              await writeFile(path.join(OUT, String(z), String(x), `${y}.jpg`), buf)
              written++
              bytes += buf.length
            })
        )
      }
    }
    await Promise.all(jobs)
    console.log(`  z${z}: ${4 ** z} tiles`)
  }

  console.log(
    `\n${written} tiles, ${(bytes / 1e6).toFixed(1)}MB in web/public/earth ` +
      `(Mercator cut-off ±${MAX_LAT.toFixed(2)}°)`
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
