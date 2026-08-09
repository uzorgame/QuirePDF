/* Which conversions actually convert.
 *
 * The page list and the engine's list are two different things: a page exists
 * for every pair anyone searches for, and only some of those pairs have code
 * behind them. This prints the split so the claim on the card and in the CV can
 * be checked against it. */
import {CONVERSIONS, convSlug, isLive} from './shared.mjs';

const live = [], dead = [];
for (const c of CONVERSIONS) {
  (isLive(c.a, c.b) ? live : dead).push({slug: convSlug(c.a, c.b), cat: c.cat});
}

const byCat = (rows) => {
  const m = new Map();
  for (const r of rows) m.set(r.cat, [...(m.get(r.cat) ?? []), r.slug]);
  return m;
};

console.log(`pages: ${CONVERSIONS.length}   live: ${live.length}   not built: ${dead.length}`);

for (const [title, rows] of [['LIVE', live], ['NOT BUILT', dead]]) {
  console.log(`\n── ${title} (${rows.length}) ──`);
  for (const [cat, slugs] of byCat(rows)) {
    console.log(`  ${cat}: ${slugs.join(', ')}`);
  }
}
