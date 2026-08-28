// What countryBox() decides, for every country at once.
//
//   node tools/dump-country-boxes.mjs           every country
//   node tools/dump-country-boxes.mjs US FR NO  just these
//   node tools/dump-country-boxes.mjs --partial only the ones that shed land
//
// The camera harness proves one country at a time in a browser. This proves the
// geometry choice for all of them in a second, with no browser at all, which is
// where you would notice a country being framed by the wrong half of itself.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
const WEB = path.join(ROOT, 'web');

// Both packages are dependencies of the web app, not of the root — resolve them
// from there rather than asking anyone to install a second copy up here.
const req = createRequire(path.join(WEB, 'package.json'));
const { feature } = req('topojson-client');
const { geoArea, geoBounds } = req('d3-geo');

// The threshold and the table are read from the modules that define them rather
// than restated here — a copy is how this quietly stops describing the app.
const src = readFileSync(path.join(WEB, 'src/components/globe/countryBox.ts'), 'utf8');
const COVERAGE = Number(/const COVERAGE = ([\d.]+)/.exec(src)?.[1]);
if (!Number.isFinite(COVERAGE)) throw new Error('Could not read COVERAGE from countryBox.ts');

const isoSrc = readFileSync(path.join(WEB, 'src/components/globe/iso.ts'), 'utf8');
const ISO = {};
for (const m of isoSrc.matchAll(/'(\d{3})':\s*'([A-Z]{2})'/g)) ISO[m[1]] = m[2];

const topo = JSON.parse(
  readFileSync(path.join(WEB, 'node_modules/world-atlas/countries-110m.json'), 'utf8')
);
const fc = feature(topo, topo.objects.countries);

const args = process.argv.slice(2);
const partialOnly = args.includes('--partial');
const only = args.filter((a) => !a.startsWith('--')).map((a) => a.toUpperCase());

const n = (x) => x.toFixed(1).padStart(7);
const rows = [];

for (const f of fc.features) {
  const iso = ISO[String(f.id).padStart(3, '0')];
  if (!iso) continue;
  if (only.length && !only.includes(iso)) continue;

  const polys = (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates)
    .map((coordinates) => ({ coordinates, a: geoArea({ type: 'Polygon', coordinates }) }))
    .sort((x, y) => y.a - x.a);
  const total = polys.reduce((s, p) => s + p.a, 0);

  const kept = [];
  let acc = 0;
  for (const p of polys) {
    kept.push(p.coordinates);
    acc += p.a;
    if (total <= 0 || acc / total >= COVERAGE) break;
  }
  if (partialOnly && kept.length === polys.length) continue;

  const b = geoBounds({ type: 'MultiPolygon', coordinates: kept });
  const whole = geoBounds(f.geometry);
  rows.push({
    iso,
    name: f.properties.name,
    kept: `${kept.length}/${polys.length}`,
    cover: `${Math.round((acc / total) * 100)}%`,
    lon: `${n(b[0][0])}..${n(b[1][0])}`,
    lat: `${n(b[0][1])}..${n(b[1][1])}`,
    // How much of the country's latitude span the frame gives up. Big numbers
    // are the ones worth looking at: that is a territory being left out.
    shed: (whole[1][1] - whole[0][1] - (b[1][1] - b[0][1])).toFixed(1),
    wrapped: b[0][0] > b[1][0] ? 'antimeridian' : '',
  });
}

rows.sort((a, b) => Number(b.shed) - Number(a.shed) || a.iso.localeCompare(b.iso));

console.log(`coverage ${COVERAGE} — ${rows.length} countries, most land shed first\n`);
console.log('iso  kept   cover  lon                 lat                 shed°  note');
for (const r of rows) {
  console.log(
    r.iso.padEnd(4),
    r.kept.padEnd(6),
    r.cover.padEnd(6),
    r.lon.padEnd(19),
    r.lat.padEnd(19),
    r.shed.padStart(5),
    ' ' + (r.wrapped || r.name)
  );
}
