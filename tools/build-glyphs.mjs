#!/usr/bin/env node
/**
 * Fetches the glyph ranges the map labels actually need.
 *
 *     node tools/build-glyphs.mjs
 *
 * MapLibre draws text from pre-rendered signed-distance-field glyphs, served as
 * one protobuf per 256 codepoints. There is no key-free endpoint worth putting
 * in the runtime path, so they are self-hosted — but the full Unicode set is
 * ~250 files per weight, and mappify does not need them.
 *
 * Place names come from Wikidata, so which ranges are needed is a property of
 * the data rather than something to guess: this reads the names out of the
 * database and downloads exactly those, plus Latin-1, which the UI chrome needs
 * regardless. Re-run it after an import that adds places in a new script.
 *
 * Noto Sans is SIL OFL 1.1 — redistribution is fine; the licence travels with
 * the files.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'web', 'public', 'glyphs')
const DB = path.join(ROOT, 'mappify.db')

/**
 * Protomaps' asset repo, which serves real PBFs.
 *
 * fonts.openmaptiles.org is the obvious candidate and answers 200 to everything
 * — including a request for a range it does not have, where it returns the
 * project's HTML homepage. Worth knowing, because the failure is silent: you
 * get six identically-sized files and no labels.
 */
const HOST = 'https://raw.githubusercontent.com/protomaps/basemaps-assets/main/fonts'
/** Regular for the crowd, Medium for whatever the cursor is on. */
const STACKS = ['Noto Sans Regular', 'Noto Sans Medium']

const LICENCE = `Noto Sans is licensed under the SIL Open Font License 1.1.
https://openfontlicense.org/

Glyph PBFs from the Protomaps basemaps-assets project, mirrored here so the app
has no runtime dependency on a font server:
https://github.com/protomaps/basemaps-assets
`

function neededRanges() {
  const db = new DatabaseSync(DB, { readOnly: true })
  const names = [
    ...db.prepare('select name from places where name is not null').all(),
    ...db.prepare('select country from places where country is not null').all(),
  ]
  db.close()

  // Latin-1 always: the legend, the breadcrumbs and every fallback string live
  // there even if no place name does.
  const blocks = new Set([0])
  for (const row of names) {
    for (const ch of String(row.name ?? row.country)) {
      blocks.add(Math.floor(ch.codePointAt(0) / 256))
    }
  }
  return [...blocks].sort((a, b) => a - b).map((b) => `${b * 256}-${b * 256 + 255}`)
}

async function main() {
  const ranges = neededRanges()
  console.log(`${ranges.length} range(s) in use: ${ranges.join(', ')}`)

  let bytes = 0
  for (const stack of STACKS) {
    await mkdir(path.join(OUT, stack), { recursive: true })
    for (const range of ranges) {
      const url = `${HOST}/${encodeURIComponent(stack)}/${range}.pbf`
      const res = await fetch(url)
      if (!res.ok) throw new Error(`${res.status} for ${url}`)
      const buf = Buffer.from(await res.arrayBuffer())
      // A protobuf never starts with '<'. See the note on HOST.
      if (buf.length < 1000 || buf[0] === 0x3c) {
        throw new Error(`${url} returned ${buf.length} bytes that are not a glyph PBF`)
      }
      await writeFile(path.join(OUT, stack, `${range}.pbf`), buf)
      bytes += buf.length
    }
    console.log(`  ${stack}: ${ranges.length} files`)
  }
  await writeFile(path.join(OUT, 'LICENSE.txt'), LICENCE)
  console.log(`\n${(bytes / 1e3).toFixed(0)}kB in web/public/glyphs`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
