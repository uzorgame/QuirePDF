/* Fails the build on the two mistakes this codebase has actually made.
 *
 *   1. The same class defined in two stylesheets that can end up on one page.
 *      `.drop` was the converter dropdown in site.css and the hero upload zone
 *      in index.html at the same time, and the header quietly grew a dashed
 *      border. Discipline did not catch that; a check does.
 *
 *   2. A bare element selector in a shared stylesheet. `section {}` in
 *      convert.css reaches into every page that ever links it, including ones
 *      written years later by someone who never opened the file.
 *
 * Run by tools/build.mjs. Also runnable on its own: node tools/check.mjs
 */
import {readFileSync, readdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* Which stylesheets can meet on one page. Sheets in the same group share a
   namespace and must not redefine each other's classes. */
const SHARED = ['tokens.css', 'site.css', 'footer.css'];
const PAGE_LOCAL = ['convert.css', 'forms.css', 'legal.css'];
/* The reset layer is the one place bare element selectors are the point. */
const RESET = 'tokens.css';

const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '');

/* Good enough for our own hand-written CSS: take each rule's selector list and
   pull out the first token of every compound. Not a parser, and does not need
   to be — it only has to notice two files claiming the same name. */
function selectorsOf(css){
  const out = new Map();
  const body = stripComments(css).replace(/@media[^{]+\{/g, '');
  for (const m of body.matchAll(/(^|\})\s*([^{}@]+?)\s*\{/g)){
    for (const sel of m[2].split(',')){
      const head = sel.trim().split(/[\s>+~]/)[0];
      if (!head) continue;
      const cls = head.match(/^\.([a-zA-Z][\w-]*)/);
      if (cls){ out.set('.' + cls[1], (out.get('.' + cls[1]) || 0) + 1); continue; }
      const el = head.match(/^([a-z][a-z0-9]*)(?![\w-])/);
      if (el && !/^(html|body|from|to)$/.test(el[1])) out.set(el[1], 1);
    }
  }
  return out;
}

function inlineStyle(html){
  return [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n');
}

const sheets = new Map();
for (const f of readdirSync(join(ROOT, 'assets')).filter(f => f.endsWith('.css')))
  sheets.set('assets/' + f, selectorsOf(readFileSync(join(ROOT, 'assets', f), 'utf8')));
for (const f of ['index.html', 'editor.html'])
  sheets.set(f + ' (inline)', selectorsOf(inlineStyle(readFileSync(join(ROOT, f), 'utf8'))));

const problems = [];

/* 1. collisions — every sheet is compared against the shared ones, and the
      shared ones against each other. Two page-local sheets are never loaded
      together, so they are allowed to reuse a name. */
const isShared = name => SHARED.some(s => name.endsWith(s));
const names = [...sheets.keys()];
for (let i = 0; i < names.length; i++){
  for (let j = i + 1; j < names.length; j++){
    const [a, b] = [names[i], names[j]];
    const bothLocal = !isShared(a) && !isShared(b)
      && PAGE_LOCAL.some(s => a.endsWith(s)) && PAGE_LOCAL.some(s => b.endsWith(s));
    if (bothLocal) continue;
    for (const sel of sheets.get(a).keys())
      if (sheets.get(b).has(sel))
        problems.push(`${sel} is defined in both ${a} and ${b}`);
  }
}

/* 2. bare element selectors in anything shared */
for (const [name, sels] of sheets){
  if (!isShared(name) || name.endsWith(RESET)) continue;
  for (const sel of sels.keys())
    if (!sel.startsWith('.') && !sel.startsWith('*'))
      problems.push(`${name} styles the bare element "${sel}" — scope it to a class`);
}

if (problems.length){
  console.error('\nCSS check failed:\n');
  for (const p of problems) console.error('  ✗ ' + p);
  console.error(`\n${problems.length} problem(s). See the note at the top of tools/check.mjs.\n`);
  process.exit(1);
}
console.log(`  css check — ${sheets.size} stylesheets, no collisions`);
