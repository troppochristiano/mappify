/**
 * Run the scene pass by hand and read what it decided.
 *
 * The pass itself lives in server/scenes.js, because the import job runs it too
 * — its header is where the rules and their known costs are written down. This
 * is the CLI over it: the same decisions, printed.
 *
 *   node tools/fix-artist-scenes.js [--dry-run] [--limit N] [--why "name,name"]
 *
 * --why prints the full reasoning for those artists, which is how the safety
 * cases are checked rather than asserted:
 *
 *   node tools/fix-artist-scenes.js --dry-run --why "Snoop Dogg,2Pac,Raekwon"
 *
 * Writes the same column as the infobox pass, so `fix-artist-origins.js
 * --revert` clears both, and a place you set by hand still outranks it. Anything
 * it writes is worth sending on with `node tools/push-derived.js`, so nobody
 * else has to fetch it again.
 */
import '../server/env.js';
import { openDb } from '../server/db.js';
import { resolveScenes } from '../server/scenes.js';

const args = process.argv.slice(2);
const apply = !args.includes('--dry-run');
const li = args.indexOf('--limit');
const limit = li >= 0 ? Number(args[li + 1]) : 2000;
const wi = args.indexOf('--why');
const WHY = new Set(
  (wi >= 0 ? (args[wi + 1] ?? '') : '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

const db = openDb();
const { moved, stats } = await resolveScenes(db, {
  limit,
  apply,
  why: (name) => WHY.has(name.toLowerCase()),
  log: (m) => console.log(m),
});

console.log('');
console.log(`${moved.length} artist(s) ${apply ? 'moved' : 'would move'}:`);
for (const m of moved) console.log(`  ${m.name}: ${m.from} -> ${m.to}   [${m.because[0]}]`);
console.log('');
console.log(`  ${stats.onlyBirthplace} named only their birthplace again`);
console.log(`  ${stats.unbreakable} tied with no way to choose`);
console.log(`  ${stats.unresolved} named places not on the map`);
console.log(`  ${stats.noMusicCat} have no music "from" category`);
console.log(`  ${stats.noArticle} have no English Wikipedia article`);
if (!apply) console.log('\n(dry run — nothing written)');
db.close();
