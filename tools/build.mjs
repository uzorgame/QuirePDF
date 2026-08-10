/* The one entry point.
 *
 *   node tools/build.mjs
 *
 * Everything that produces a file lives behind this. The individual builders
 * still run on their own for quick iteration, but this is the command that
 * leaves the tree in a consistent state — and, importantly, the one that keeps
 * index.html's chrome and sitemap.xml in step with the rest.
 *
 * Those two were the weak points: the header sync was an ad-hoc one-liner typed
 * into a shell and the sitemap was a heredoc. Neither existed in the repo, so
 * neither would have survived the next person adding a page.
 */
import {readFileSync, writeFileSync, readdirSync, copyFileSync, existsSync, mkdirSync, rmSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SITE, header, footer} from './shared.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const log = (...a) => console.log(' ', ...a);

/* ── 1. generated pages ───────────────────────────────────────────────── */

await import('./build-converters.mjs');
/* Before the form pages, because they reference the pictures it writes.
   Skipped when a preview already exists, so this is cheap on a rebuild — pass
   --force, or delete forms/previews, to redraw them all. */
await import('./build-previews.mjs');
await import('./build-forms.mjs');
await import('./build-legal.mjs');

/* ── 2. hand-written pages that still share the chrome ─────────────────
 * index.html is written by hand — it is the only page whose body is unique
 * enough not to be worth templating. Its header and footer are not, so they are
 * swapped in from the same source everything else uses.
 *
 * The replacement is anchored on the tag pair rather than on a marker comment,
 * so it keeps working if the surrounding markup is edited. If either anchor
 * goes missing the build fails loudly instead of silently leaving stale nav. */
function swapChrome(file, prefix, headOpts = {}, footOpts = {}){
  const path = join(ROOT, file);
  let s = readFileSync(path, 'utf8');

  /* Anchored on the bare tags, not on the full opening tag with its classes —
     the editor's header carries an extra modifier class and would otherwise be
     skipped silently, which is the failure mode this whole function exists to
     prevent. */
  for (const [open, close, html] of [
    ['<header', '</header>', header(prefix, headOpts)],
    ['<footer', '</footer>', footer(prefix, footOpts)],
  ]){
    const a = s.indexOf(open);
    const b = s.indexOf(close, a);
    if (a < 0 || b < 0) throw new Error(`${file}: could not find ${open} … ${close}`);
    s = s.slice(0, a) + html + s.slice(b + close.length);
  }

  writeFileSync(path, s, 'utf8');
  log(`${file} chrome synced`);
}

swapChrome('index.html', './');

/* The editor gets the identical nav. Only the right-hand actions and the
   document title differ, and they are passed in rather than forked. */
swapChrome('editor.html', './', {
  app: true,
  middle: '<div class="app-file"><b id="fileName">Untitled</b><span id="fileMeta">—</span></div>',
  actions: `
      <span class="badge" id="docBadge"><i></i>Nothing uploaded</span>
      <button class="btn" id="openBtn">
        <svg viewBox="0 0 24 24"><path d="M3.5 7.5V19a1.5 1.5 0 0 0 1.5 1.5h14a1.5 1.5 0 0 0 1.5-1.5V9a1.5 1.5 0 0 0-1.5-1.5h-8L9 4.5H5A1.5 1.5 0 0 0 3.5 6z"/></svg>
        Open
      </button>
      <button class="btn" id="newBtn">
        <svg viewBox="0 0 24 24"><path d="M6.5 2.5h7.5L19.5 8v13.5h-13z"/><path d="M14 2.5V8h5.5"/><path d="M12.5 12v6M9.5 15h6"/></svg>
        New
      </button>
      <button class="btn btn--primary" id="exportBtn">
        <svg viewBox="0 0 24 24"><path d="M12 3.5v11M8 10.5l4 4 4-4"/><path d="M4.5 16.5v2.5a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-2.5"/></svg>
        Export
      </button>
    `,
}, {slim: true});

/* ── 3. FAQ schema, derived from the visible FAQ ───────────────────────
 * Structured data that disagrees with the page is worse than none — Google
 * treats the mismatch as a reason to drop the rich result entirely. So the
 * questions are written once, in the markup, and the schema is read back out
 * of them rather than maintained beside them. */
function syncFaqSchema(file){
  const path = join(ROOT, file);
  let s = readFileSync(path, 'utf8');

  const qa = [...s.matchAll(/<details class="faq-item"[^>]*>\s*<summary>([\s\S]*?)<\/summary>\s*<p>([\s\S]*?)<\/p>/g)]
    .map(m => [m[1], m[2]].map(t => t.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()));

  if (!qa.length) throw new Error(`${file}: no .faq-item found`);

  const schema = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: qa.map(([q, a]) => ({
      '@type': 'Question',
      name: q,
      acceptedAnswer: {'@type': 'Answer', text: a},
    })),
  }, null, 1);

  const tag = /<script type="application\/ld\+json" id="faq-schema">[\s\S]*?<\/script>/;
  if (!tag.test(s)) throw new Error(`${file}: no #faq-schema placeholder`);
  s = s.replace(tag, `<script type="application/ld+json" id="faq-schema">\n${schema}\n</script>`);

  writeFileSync(path, s, 'utf8');
  log(`${file} FAQ schema — ${qa.length} questions`);
}

syncFaqSchema('index.html');

/* The two numbers the front page quotes about itself.
 *
 * They were typed in by hand, and a hand-typed count is a promise that goes
 * stale the first time a page is added or dropped — which happened three
 * times in a week, twice reaching the live site before anyone noticed. Any
 * link carrying data-count has its number rewritten here from what is
 * actually on disk, so the page can only ever claim what it has. */
function syncCounts(file) {
  const path = join(ROOT, file);
  let s = readFileSync(path, 'utf8');
  const have = {
    conversions: readdirSync(join(ROOT, 'convert')).filter(n => n.endsWith('.html')).length,
    forms: readdirSync(join(ROOT, 'forms')).filter(n => n.endsWith('.html')).length,
  };
  let touched = 0;
  for (const [key, n] of Object.entries(have)) {
    const tag = new RegExp(`(data-count="${key}"[^>]*>)\\s*\\d+`, 'g');
    if (!tag.test(s)) throw new Error(`${file}: nothing carries data-count="${key}"`);
    s = s.replace(tag, (_, open) => { touched++; return `${open}${n}`; });
  }
  writeFileSync(path, s, 'utf8');
  log(`${file} counts — ${have.conversions} conversions, ${have.forms} forms, ${touched} rewritten`);
}

syncCounts('index.html');

/* ── 4. sitemap ───────────────────────────────────────────────────────── */

const PRIORITY = {'':1.0, 'editor.html':0.9, 'converter.html':0.9, 'forms.html':0.9,
                  'privacy.html':0.3, 'terms.html':0.3};
const FREQ     = {'forms.html':'weekly', 'converter.html':'weekly',
                  'privacy.html':'yearly', 'terms.html':'yearly'};

/* Derived from what is actually on disk, so a page cannot be added without
   appearing here. The date comes from the build, not from a literal — a
   hard-coded lastmod is a lie the moment anything changes. */
const stamp = new Date(process.env.SOURCE_DATE_EPOCH
  ? Number(process.env.SOURCE_DATE_EPOCH) * 1000 : Date.now())
  .toISOString().slice(0, 10);

/* Every page at the root is listed by hand, because the two directories below
   are generated and this handful is not. converter.html was the one missing:
   the hub the seventy-four conversion pages all link back to, absent from the
   sitemap while every page under it was in. */
const routes = [
  '',
  'editor.html',
  'converter.html',
  'forms.html',
  'privacy.html',
  'terms.html',
  ...readdirSync(join(ROOT, 'convert')).filter(f => f.endsWith('.html')).sort().map(f => `convert/${f}`),
  ...readdirSync(join(ROOT, 'forms')).filter(f => f.endsWith('.html')).sort().map(f => `forms/${f}`),
];

const xml = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ...routes.map(r =>
    `  <url><loc>${SITE}/${r}</loc><lastmod>${stamp}</lastmod>` +
    `<changefreq>${FREQ[r] || 'monthly'}</changefreq>` +
    `<priority>${(PRIORITY[r] ?? 0.8).toFixed(1)}</priority></url>`),
  '</urlset>',
  '',
].join('\n');

writeFileSync(join(ROOT, 'sitemap.xml'), xml, 'utf8');
log(`sitemap.xml — ${routes.length} URLs`);

/* ── 4. the pdf.js worker ─────────────────────────────────────────────
 * pdf.js parses and rasterises off the main thread, and the worker has to be a
 * real file next to the bundle — app/core/pdfjs.ts resolves it relative to
 * itself. Copying it here rather than by hand means a `npm i pdfjs-dist@next`
 * cannot leave a stale worker behind, which fails in ways that look like
 * corrupt PDFs rather than like a version mismatch. */
{
  const from = join(ROOT, 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs');
  if (!existsSync(from)) throw new Error('pdfjs-dist is not installed — run npm install');
  copyFileSync(from, join(ROOT, 'assets/pdf.worker.mjs'));
  log('assets/pdf.worker.mjs');
}

/* The Unicode faces.
 *
 * The fourteen fonts built into the PDF format cover Latin-1 and nothing else,
 * so a line of Ukrainian has no glyph to draw and pdf-lib throws on save. These
 * are the fallback, embedded only into documents that actually need them and
 * subsetted on the way in — a page of Cyrillic adds about eight kilobytes to
 * the output, not seven hundred.
 *
 * They are fetched at runtime rather than bundled, and only when a document
 * turns out to contain something outside Latin-1. Latin-only work never
 * downloads a byte of this. */
{
  const faces = [
    ['DejaVuSans.ttf', 'sans.ttf'],
    ['DejaVuSans-Bold.ttf', 'bold.ttf'],
    ['DejaVuSansMono.ttf', 'mono.ttf'],
  ];
  mkdirSync(join(ROOT, 'assets/fonts'), {recursive: true});
  for (const [src, dst] of faces) {
    const from = join(ROOT, 'node_modules/dejavu-fonts-ttf/ttf', src);
    if (!existsSync(from)) throw new Error('dejavu-fonts-ttf is not installed — run npm install');
    copyFileSync(from, join(ROOT, 'assets/fonts', dst));
  }
  log(`assets/fonts — ${faces.length} Unicode faces`);
}

/* ── 5. last build's chunks ────────────────────────────────────────────
 * Vite writes hashed chunk names, and `emptyOutDir` has to stay off because
 * assets/ also holds hand-written CSS a clean build would delete. The side
 * effect is that every rebuild leaves the previous hash behind: four copies of
 * the 1.4 MB HEIC decoder had accumulated, none referenced by anything, all of
 * them destined for the deploy. chunks/ holds nothing but generated files, so
 * that one directory can be emptied on its own. */
{
  const dir = join(ROOT, 'assets/chunks');
  if (existsSync(dir)) {
    const stale = readdirSync(dir).length;
    rmSync(dir, {recursive: true, force: true});
    if (stale) log(`assets/chunks — ${stale} files from the last build removed`);
  }
}

/* ── 6. guards ────────────────────────────────────────────────────────── */

await import('./check.mjs');

/* ── 6. robots ────────────────────────────────────────────────────────── */

writeFileSync(join(ROOT, 'robots.txt'),
`User-agent: *
Allow: /

Sitemap: ${SITE}/sitemap.xml
`, 'utf8');
log('robots.txt');

console.log('\nBuild complete.');
