// What `decodeExport` does with a file it should not trust.
//
//     node --test server/share.test.js
//
// A share file is the first input Mappify has ever taken that was written by
// somebody else and delivered over a chat app. Everything here is a thing a
// hostile or broken file can do, asserted rather than assumed — this is the file
// that says the validation boundary still exists after somebody refactors it.

import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import { decodeExport, encodeExport, exportFilename, BadShareFile, MAGIC, FORMAT } from './share.js';

const ID = '0LyfQWJT6nXafLPZqxe9Of';
const ID2 = '3TVXtAsR1Inumwj472S9r4';

/** A minimal well-formed document, with overrides merged in. */
const doc = (over = {}) => ({
  magic: MAGIC,
  format: FORMAT,
  exported_at: '2026-08-26T00:00:00.000Z',
  user: { spotify_id: 'someone', display_name: 'Someone', avatar: null },
  place_columns: ['qid', 'name', 'country_iso', 'lat', 'lon', 'tracks', 'artists'],
  places: [['Q60', 'New York City', 'US', 40.7, -74, 10, 2]],
  artist_columns: ['spotify_id', 'name', 'tracks', 'place_qid', 'image_url'],
  artists: [[ID, 'An Artist', 5, 'Q60', null]],
  track_columns: ['spotify_id', 'name', 'artist_id'],
  tracks: [[ID2, 'A Track', ID]],
  ...over,
});

const file = (over) => encodeExport(doc(over));

const refuses = (buf, why) =>
  assert.throws(() => decodeExport(buf), BadShareFile, `should have refused: ${why}`);

test('a well-formed file round-trips', () => {
  const r = decodeExport(file());
  assert.equal(r.user.spotify_id, 'someone');
  assert.equal(r.places.length, 1);
  assert.equal(r.artists.length, 1);
  assert.equal(r.tracks.length, 1);
  assert.equal(r.dropped, 0);
});

test('anything that is not gzip is refused before zlib sees it', () => {
  refuses(Buffer.from('{"magic":"mappify.share"}'), 'plain JSON');
  refuses(Buffer.from(''), 'empty');
  refuses(Buffer.from([0x1f]), 'one byte');
});

test('truncated gzip is refused with a sentence, not a zlib throw', () => {
  const good = file();
  refuses(good.subarray(0, Math.floor(good.length / 2)), 'half a file');
});

test('a gzip bomb is refused rather than inflated', () => {
  // 200MB of zeros compresses to a couple of hundred kilobytes. Without
  // maxOutputLength this is the call that takes the process down — and on a
  // hosted instance, every user with it.
  const bomb = zlib.gzipSync(Buffer.alloc(200 * 1024 * 1024), { level: 9 });
  assert.ok(bomb.length < 1024 * 1024, 'the bomb should be small on the wire');
  refuses(bomb, 'gzip bomb');
});

test('the magic and the format number are checked before anything else is read', () => {
  refuses(file({ magic: 'something.else' }), 'wrong magic');
  refuses(file({ magic: undefined }), 'no magic');
  refuses(file({ format: 2 }), 'a newer format');
  refuses(file({ format: '1' }), 'a format that is a string');
});

test('a file that does not say who it belongs to is refused', () => {
  refuses(file({ user: { display_name: 'Someone' } }), 'no spotify id');
  refuses(file({ user: {} }), 'empty user');
});

test('row counts are checked before any row is touched', () => {
  const many = Array.from({ length: 20_001 }, () => [ID, 'x', 1, null, null]);
  refuses(file({ artists: many }), 'twenty thousand artists');
});

/**
 * A body of good rows to hide a bad one among.
 *
 * The bad rows in these tests have to be a small minority, because a file that
 * is mostly unreadable is refused outright — so a two-row fixture with one bad
 * row exercises the refusal, not the dropping, and proves nothing about either.
 */
const goodArtists = (n) =>
  Array.from({ length: n }, (_, i) => [`A${String(i).padStart(21, '0')}`, `Artist ${i}`, i + 1, 'Q60', null]);
const goodPlaces = (n) =>
  Array.from({ length: n }, (_, i) => [`Q${1000 + i}`, `Place ${i}`, 'US', 40, -74, i + 1, 1]);

test('a qid that is not a qid is dropped, not escaped', () => {
  const r = decodeExport(
    file({ places: [...goodPlaces(20), ["'; DROP TABLE places; --", 'Nasty', 'US', 40, -74, 10, 2]] })
  );
  assert.equal(r.places.length, 20);
  assert.ok(!r.places.some((p) => p.name === 'Nasty'));
  assert.equal(r.dropped, 1);
});

test('an over-long qid is refused rather than clipped into a valid one', () => {
  const r = decodeExport(file({ places: [...goodPlaces(20), [`Q${'9'.repeat(40)}`, 'Clipped', 'US', 40, -74, 1, 1]] }));
  assert.equal(r.places.length, 20);
  assert.equal(r.dropped, 1);
});

test('a Spotify id that is not one is dropped', () => {
  const r = decodeExport(
    file({ artists: [...goodArtists(20), ['../../etc/passwd', 'Nasty', 5, null, null]] })
  );
  assert.equal(r.artists.length, 20);
  assert.ok(!r.artists.some((a) => a.name === 'Nasty'));
});

test('an over-long Spotify id is refused rather than clipped', () => {
  // Two different 40-character ids clipped to 32 would collide, so clipping here
  // does not merely admit a bad row — it merges two of them.
  const r = decodeExport(file({ artists: [...goodArtists(20), ['B'.repeat(40), 'Clipped', 5, null, null]] }));
  assert.equal(r.artists.length, 20);
  assert.equal(r.dropped, 1);
});

test('impossible coordinates become null rather than moving a dot', () => {
  const r = decodeExport(
    file({ places: [['Q60', 'Nowhere', 'US', 999, -74, 10, 2]] })
  );
  assert.equal(r.places[0].lat, null);
  assert.equal(r.places[0].lon, -74);
});

test('a bogus country code is dropped without taking the place with it', () => {
  // The specific trap: clipping to two characters first would turn 'NOT-ISO'
  // into 'NO', and quietly move the city to Norway.
  const r = decodeExport(file({ places: [['Q60', 'Somewhere', 'NOT-ISO', 40, -74, 10, 2]] }));
  assert.equal(r.places.length, 1);
  assert.equal(r.places[0].country_iso, null);
  assert.equal(r.dropped, 0, 'a bad country code costs the code, not the place');
});

test('negative and non-integer track counts are refused', () => {
  const r = decodeExport(
    file({
      artists: [
        ...goodArtists(20),
        [ID, 'Negative', -5, null, null],
        [ID2, 'Fractional', 1.5, null, null],
      ],
    })
  );
  assert.equal(r.artists.length, 20);
  assert.ok(!r.artists.some((a) => a.name === 'Negative' || a.name === 'Fractional'));
  assert.equal(r.dropped, 2);
});

test('an artist with no name keeps its tracks and falls back to its id', () => {
  // A real row in a real library — Spotify serves some artists with an empty
  // name. Dropping it would delete every track filed under it from the score.
  const r = decodeExport(file({ artists: [[ID, '', 147, 'Q60', null]] }));
  assert.equal(r.artists.length, 1);
  assert.equal(r.artists[0].name, ID);
  assert.equal(r.artists[0].tracks, 147);
  assert.equal(r.dropped, 0);
});

test('a file that is mostly unreadable is refused rather than half-imported', () => {
  const rows = Array.from({ length: 100 }, (_, i) =>
    i < 50 ? [ID, 'Fine', 1, null, null] : ['nope', 'Bad', 1, null, null]
  );
  refuses(file({ artists: rows }), 'half the artists unreadable');
});

test('a few bad rows are dropped and counted, not fatal', () => {
  const r = decodeExport(
    file({ artists: [...goodArtists(95), ...Array.from({ length: 5 }, () => ['nope', 'Bad', 1, null, null])] })
  );
  assert.equal(r.dropped, 5);
  assert.equal(r.artists.length, 95);
});

test('an artist image pointing anywhere but Spotify is stripped', () => {
  // The URL is chosen by whoever wrote the file and the viewer's browser fetches
  // it, which hands that person an IP address and a referer on every render.
  const r = decodeExport(
    file({
      artists: [
        [ID, 'Tracked', 5, null, 'https://evil.example/beacon.png'],
        [ID2, 'Fine', 5, null, 'https://i.scdn.co/image/ab67616d00004851abc'],
      ],
    })
  );
  assert.equal(r.artists.find((a) => a.name === 'Tracked').image_url, null);
  assert.equal(
    r.artists.find((a) => a.name === 'Fine').image_url,
    'https://i.scdn.co/image/ab67616d00004851abc'
  );
  // Not merely a scheme check: a host that only starts the same way must fail.
  const sneaky = decodeExport(
    file({ artists: [[ID, 'Sneaky', 1, null, 'https://i.scdn.co.evil.example/image/x']] })
  );
  assert.equal(sneaky.artists[0].image_url, null);
});

test('an SVG avatar is rejected outright', () => {
  // Same-origin SVG is a scriptable document. Accepting one would make importing
  // a friend equivalent to running their code against your library.
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const r = decodeExport(
    file({
      user: {
        spotify_id: 'someone',
        display_name: 'Someone',
        avatar: { mime: 'image/png', bytes: svg.toString('base64') },
      },
    })
  );
  assert.equal(r.user.avatar, null, 'an SVG must not survive, whatever it claims to be');
});

test('the declared avatar mime is ignored in favour of the bytes', () => {
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(64),
  ]);
  const r = decodeExport(
    file({
      user: {
        spotify_id: 'someone',
        display_name: 'Someone',
        avatar: { mime: 'image/jpeg', bytes: png.toString('base64') },
      },
    })
  );
  assert.equal(r.user.avatar.mime, 'image/png');
});

test('an oversized avatar is dropped without failing the import', () => {
  const huge = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(400 * 1024)]);
  const r = decodeExport(
    file({
      user: {
        spotify_id: 'someone',
        display_name: 'Someone',
        avatar: { mime: 'image/jpeg', bytes: huge.toString('base64') },
      },
    })
  );
  assert.equal(r.user.avatar, null);
  assert.equal(r.artists.length, 1, 'losing a picture must not cost the library');
});

test('a display name cannot smuggle a header into the filename', () => {
  const name = 'Ann"; rm -rf /\r\nX-Evil: yes';
  const f = exportFilename(name, new Date('2026-08-26T00:00:00Z'));
  assert.match(f, /^[A-Za-z0-9._-]+\.mappify$/);
  assert.ok(!/["\r\n]/.test(f));
});

test('an empty display name still produces a usable filename', () => {
  assert.equal(exportFilename('', new Date('2026-08-26T00:00:00Z')), 'mappify-2026-08-26.mappify');
  assert.equal(exportFilename('русский', new Date('2026-08-26T00:00:00Z')), 'mappify-2026-08-26.mappify');
});

test('a reordered column header is honoured rather than read positionally', () => {
  const r = decodeExport(
    file({
      artist_columns: ['name', 'spotify_id', 'tracks', 'place_qid', 'image_url'],
      artists: [['Backwards', ID, 3, 'Q60', null]],
    })
  );
  assert.equal(r.artists[0].spotify_id, ID);
  assert.equal(r.artists[0].name, 'Backwards');
});

test('rows that are not arrays are dropped rather than throwing', () => {
  const r = decodeExport(file({ artists: [...goodArtists(20), 'not-a-row', 42, null] }));
  assert.equal(r.artists.length, 20);
  assert.equal(r.dropped, 3);
});
