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
 * z5 is 16384px across the equator, and the source is 21600 — so this is the
 * last level that is still genuinely resolved rather than invented. z6 would be
 * 32768px of upscaling. Past the bottom of the pyramid the map is overzoomed,
 * which is fine: at city scale the imagery is backdrop, the dots are the
 * subject, and the coastline overlay fades in to carry orientation.
 *
 * Each level is roughly three times the one above it — z4 is 4.3MB and z5 about
 * 14MB — so this is also the size dial. Dropping to 4 gives back most of it.
 */
const MAX_Z = arg('maxz', 5)

/**
 * The height of the source, and the finest vertical sampling worth doing.
 *
 * Mercator's rows are densest at the equator, at `side / 360` per degree; the
 * source carries 60 per degree. So there is nothing to gain from resampling the
 * source taller than it is, and at z5 that is the difference between a 531MB
 * intermediate and a 805MB one.
 */
const SRC_HEIGHT = 10800
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

  let written = 0
  let bytes = 0

  for (let z = 0; z <= MAX_Z; z++) {
    const side = TILE * 2 ** z
    const across = 2 ** z
    // Height is not an aspect ratio here — the vertical axis is only ever used
    // as a latitude lookup — so it is set by how finely Mercator will sample it
    // rather than by the shape of the world.
    const eqH = Math.min(SRC_HEIGHT, side)

    // Resampled per level straight from the source rather than downsampled from
    // the level below, so every level gets the full lanczos treatment and none
    // of them inherits another's resampling.
    process.stdout.write(`  z${z}: resampling ${side}x${eqH}…`)
    const { data: eq } = await sharp(src, { limitInputPixels: false })
      .resize(side, eqH, { fit: 'fill', kernel: 'lanczos3' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })

    const rows = mercatorRows(side, eqH)
    const stride = side * 3

    for (let ty = 0; ty < across; ty++) {
      await mkdir(path.join(OUT, String(z)), { recursive: true })

      // One tile-row of Mercator at a time. Materialising the whole level would
      // be 805MB at z5 — past what sharp will even accept as an input — and
      // there is no reason to hold rows that have already been cut up.
      const band = Buffer.allocUnsafe(TILE * stride)
      for (let r = 0; r < TILE; r++) {
        const sy = rows[ty * TILE + r]
        const y0 = Math.max(0, Math.min(eqH - 1, Math.floor(sy)))
        const y1 = Math.min(eqH - 1, y0 + 1)
        const f = Math.max(0, Math.min(1, sy - y0))
        const o = r * stride
        const a = y0 * stride
        const b = y1 * stride
        if (f === 0) {
          eq.copy(band, o, a, a + stride)
          continue
        }
        // Blended between the two neighbouring source rows rather than snapped
        // to one, or the coastlines stair-step where Mercator stretches most.
        for (let i = 0; i < stride; i++) {
          band[o + i] = eq[a + i] + (eq[b + i] - eq[a + i]) * f
        }
      }

      const jobs = []
      for (let tx = 0; tx < across; tx++) {
        await mkdir(path.join(OUT, String(z), String(tx)), { recursive: true })
        // Cut by hand: one buffer copy per row beats handing sharp the whole
        // band and asking it to extract, once per tile.
        const tile = Buffer.allocUnsafe(TILE * TILE * 3)
        for (let r = 0; r < TILE; r++) {
          const from = r * stride + tx * TILE * 3
          band.copy(tile, r * TILE * 3, from, from + TILE * 3)
        }
        jobs.push(
          sharp(tile, { raw: { width: TILE, height: TILE, channels: 3 } })
            .jpeg({ quality: QUALITY, mozjpeg: true, chromaSubsampling: '4:2:0' })
            .toBuffer()
            .then(async (buf) => {
              await writeFile(path.join(OUT, String(z), String(tx), `${ty}.jpg`), buf)
              written++
              bytes += buf.length
            })
        )
      }
      await Promise.all(jobs)
    }
    console.log(` ${4 ** z} tiles`)
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
