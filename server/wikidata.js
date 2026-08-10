import './env.js';
import { userAgent } from './env.js';
// Wikidata SPARQL fallback: bulk-resolve MBIDs that MusicBrainz has no area for.
// P434 = MusicBrainz artist ID, P740 = location of formation, P19 = place of birth,
// P17 = country of that place.

const ENDPOINT = 'https://query.wikidata.org/sparql';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));


// Every triple pattern must hang off a subject that is bound inside its own
// OPTIONAL. Resolving country off the COALESCEd ?place instead looks tidier but
// is catastrophic: for any artist with neither P740 nor P19, ?place is unbound,
// so `?place wdt:P17 ?country` matches every P17 statement in Wikidata and
// cross-joins it against each row. That returned a 512MB body and timed out.
export function buildQuery(mbids) {
  const values = mbids.map((id) => `"${id}"`).join(' ');
  return `SELECT ?mbid ?item ?itemLabel ?place ?placeLabel ?country ?countryLabel WHERE {
  VALUES ?mbid { ${values} }
  ?item wdt:P434 ?mbid .
  OPTIONAL { ?item wdt:P740 ?formation . OPTIONAL { ?formation wdt:P17 ?formationCountry . } }
  OPTIONAL { ?item wdt:P19 ?birth . OPTIONAL { ?birth wdt:P17 ?birthCountry . } }
  BIND(COALESCE(?formation, ?birth) AS ?place)
  BIND(COALESCE(?formationCountry, ?birthCountry) AS ?country)
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul". }
}`;
}

export async function sparql(query, { retries = 5 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'User-Agent': userAgent(),
        Accept: 'application/sparql-results+json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ query }).toString(),
    });

    // WDQS throws transient 502/504 from its front-end proxy under load — the
    // identical query succeeds moments later, so every 5xx is retryable.
    if (res.status === 429 || res.status >= 500) {
      await res.arrayBuffer();
      if (attempt >= retries) throw new Error(`Wikidata ${res.status} after ${retries} retries`);
      const retryAfter = Number(res.headers.get('retry-after'));
      const backoff = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(45_000, 4000 * 2 ** attempt);
      console.log(`    WDQS ${res.status} — retrying in ${Math.round(backoff / 1000)}s (attempt ${attempt + 1}/${retries})`);
      await sleep(backoff);
      continue;
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Wikidata ${res.status}: ${body.slice(0, 400)}`);
    }

    return res.json();
  }
}

/**
 * The place itself, not just its label — the QID and coordinates, so a real
 * place row can be created for artists MusicBrainz has no area for. The older
 * resolveByMbids below only kept the names, which left those artists with a city
 * that nothing on the map could join to.
 *
 * @returns {Promise<Map<mbid, {placeQid, name, lat, lon, country, iso}>>}
 */
export async function resolvePlacesByMbids(mbids) {
  const out = new Map();
  if (!mbids.length) return out;

  const values = mbids.map((id) => `"${id}"`).join(' ');
  const query = `SELECT ?mbid ?place ?placeLabel ?coord ?countryLabel ?iso WHERE {
  VALUES ?mbid { ${values} }
  ?item wdt:P434 ?mbid .
  OPTIONAL { ?item wdt:P740 ?formation . OPTIONAL { ?formation wdt:P625 ?fCoord } }
  OPTIONAL { ?item wdt:P19 ?birth . OPTIONAL { ?birth wdt:P625 ?bCoord } }
  BIND(COALESCE(?formation, ?birth) AS ?place)
  BIND(COALESCE(?fCoord, ?bCoord) AS ?coord)
  OPTIONAL { ?place wdt:P17 ?country . OPTIONAL { ?country wdt:P297 ?iso } }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul". }
}`;

  const json = await sparql(query);
  for (const b of json.results.bindings) {
    const mbid = b.mbid?.value;
    if (!mbid || out.has(mbid) || !b.place) continue;
    const m = /^Point\(([-\d.]+) ([-\d.]+)\)$/.exec(b.coord?.value ?? '');
    out.set(mbid, {
      placeQid: b.place.value.split('/').pop(),
      name: b.placeLabel?.value ?? null,
      lat: m ? Number(m[2]) : null,
      lon: m ? Number(m[1]) : null,
      country: b.countryLabel?.value ?? null,
      iso: b.iso?.value ?? null,
    });
  }
  return out;
}

/** @returns {Map<mbid, {city:string|null, country:string|null, qid:string}>} */
export async function resolveByMbids(mbids) {
  const out = new Map();
  if (!mbids.length) return out;
  const json = await sparql(buildQuery(mbids));
  for (const row of json.results.bindings) {
    const mbid = row.mbid?.value;
    if (!mbid || out.has(mbid)) continue; // first binding wins
    out.set(mbid, {
      city: row.placeLabel?.value ?? null,
      country: row.countryLabel?.value ?? null,
      qid: row.item?.value?.split('/').pop() ?? null,
    });
  }
  return out;
}
