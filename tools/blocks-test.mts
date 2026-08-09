/* Does the block finder see what a reader sees?
 *
 * Block detection is the one part of the text editor that cannot be reasoned
 * into correctness. Every threshold in TUNING is a guess, and the only way to
 * know whether a guess is good is to run it over documents that were typeset by
 * different tools and look at what came out. So this prints the blocks of each
 * file in the corpus, and checks a handful of facts that must hold whatever the
 * thresholds are.
 *
 *   node --experimental-strip-types tools/blocks-test.mts [file.pdf]
 *
 * Adding a document to test/corpus/ is how the corpus grows. Expectations for a
 * document go in EXPECT, keyed by its file name; anything without expectations
 * is still printed, so a new file is useful the moment it is dropped in. */
import {readFileSync, readdirSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {getBlocks} from '../app/core/blocks.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const dir = join(root, 'test', 'corpus');

const {getDocument} = await import('pdfjs-dist/legacy/build/pdf.mjs');

/* What a person would say if you showed them the page. `has` is a phrase that
   must end up inside one single block; `apart` is a pair that must not share
   one. Deliberately about meaning rather than about counts — a count changes
   whenever the tuning moves by a hair and tells you nothing about whether the
   page got better. */
const EXPECT: Record<string, {has?: string[][]; apart?: Array<[string, string]>}> = {
  'cv.pdf': {
    has: [
      /* A wrapped paragraph is one block, not one block per line. */
      ['Product engineer who ships', 'across the whole stack from day one'],
    ],
    apart: [
      /* The two columns of the skills table. Merging them is the failure the
         overlap test exists to prevent. */
      ['Languages', 'JavaScript, Dart'],
      /* A heading is not the first line of the text under it. */
      ['S U M M A R Y', 'Product engineer who ships'],
      /* Each product in the list is its own item, not one tall block. */
      ['Kora Wallet', 'Retro Arcade'],
      ['Backend:', 'Web:'],
      /* A job title and the date on the far right of the same line. */
      ['Co-founder & Full-Stack Engineer', 'Nov 2025'],
    ],
  },
  'w-9.pdf': {
    apart: [
      ['Request for Taxpayer', 'Give form to the'],
    ],
  },
};

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

let failures = 0;

const only = process.argv[2];
const files = only
  ? [only]
  : existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.pdf')).map(f => join(dir, f)) : [];

if (!files.length) {
  console.error('No PDFs in test/corpus/. Drop some in — one column, two columns,');
  console.error('a table, a scan, something from LibreOffice, something from LaTeX.');
  process.exit(1);
}

for (const file of files) {
  const name = file.split(/[\\/]/).pop()!;
  const bytes = new Uint8Array(readFileSync(file));
  const doc = await getDocument({data: bytes, useSystemFonts: false, isEvalSupported: false}).promise;

  const all: Array<{page: number; text: string; lines: number; align: string; box: string}> = [];
  const t0 = performance.now();
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    for (const b of await getBlocks(page as never, n)) {
      all.push({
        page: n,
        text: norm(b.lines.map(l => l.text).join(' ')),
        lines: b.lines.length,
        align: b.align,
        box: `${b.x.toFixed(0)},${b.y.toFixed(0)} ${b.w.toFixed(0)}×${b.h.toFixed(0)}`,
      });
    }
  }
  const ms = Math.round(performance.now() - t0);

  console.log(`\n━━ ${name} — ${doc.numPages} page(s), ${all.length} blocks, ${ms} ms`);
  for (const b of all.slice(0, 60)) {
    const head = b.text.length > 78 ? b.text.slice(0, 75) + '…' : b.text;
    console.log(`  p${b.page} ${String(b.lines).padStart(2)}L ${b.align.padEnd(7)} ${b.box.padEnd(20)} ${head}`);
  }
  if (all.length > 60) console.log(`  … ${all.length - 60} more`);

  const want = EXPECT[name];
  if (!want) continue;

  for (const phrases of want.has ?? []) {
    const hit = all.find(b => phrases.every(p => b.text.includes(p)));
    if (hit) {
      console.log(`  ✓ together: ${phrases.map(p => `"${p.slice(0, 28)}"`).join(' + ')}`);
    } else {
      failures++;
      console.log(`  ✗ SPLIT:    ${phrases.map(p => `"${p.slice(0, 28)}"`).join(' + ')}`);
      for (const p of phrases) {
        const b = all.find(x => x.text.includes(p));
        console.log(`      "${p.slice(0, 28)}" → ${b ? `block «${b.text.slice(0, 60)}»` : 'NOT FOUND'}`);
      }
    }
  }

  for (const [a, b] of want.apart ?? []) {
    const shared = all.find(x => x.text.includes(a) && x.text.includes(b));
    if (!shared) {
      console.log(`  ✓ apart:    "${a.slice(0, 24)}" | "${b.slice(0, 24)}"`);
    } else {
      failures++;
      console.log(`  ✗ MERGED:   "${a.slice(0, 24)}" | "${b.slice(0, 24)}"`);
      console.log(`      into «${shared.text.slice(0, 90)}»`);
    }
  }
}

console.log(failures ? `\n${failures} expectation(s) failed.` : '\nAll expectations met.');
process.exit(failures ? 1 : 0);
