/* Downloads the official forms and proves each one is usable before shipping it.
 *
 *   node tools/fetch-forms.mjs
 *
 * Downloading is the easy half. The half that matters is verification: a
 * government PDF can arrive intact and still be one our export path cannot
 * write back — SS-5, for instance, uses object structures pdf-lib refuses. If
 * that only surfaced when a user pressed Export, they would lose the work they
 * had just typed into it. So every file is loaded and re-saved here, and one
 * that fails the round trip is shipped with `writable: false`: it still opens
 * and still fills in, but the editor exports it by drawing the answers onto a
 * render of each page, and its form page says so before anyone starts typing.
 *
 * Already-downloaded files are skipped, so this is cheap to re-run. Pass
 * --refresh to fetch everything again — worth doing when tax season turns over
 * and the revisions change.
 */
import {readFileSync, writeFileSync, existsSync, mkdirSync, statSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PDFDocument} from 'pdf-lib';
import {OFFICIAL} from './forms-catalogue.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'forms', 'files');
const MANIFEST = join(ROOT, 'tools', 'forms-manifest.json');
const refresh = process.argv.includes('--refresh');

mkdirSync(DIR, {recursive: true});

const previous = existsSync(MANIFEST)
  ? JSON.parse(readFileSync(MANIFEST, 'utf8'))
  : {generated: null, forms: {}};

const manifest = {generated: new Date().toISOString().slice(0, 10), forms: {}};
const skipped = [];

/* pdf-lib is noisy about XFA and about objects it repairs. Neither is fatal and
   both would drown the one line that matters, so its chatter is muted while a
   document is being checked. */
function quietly(fn) {
  const {log, warn} = console;
  console.log = console.warn = () => {};
  try { return fn(); } finally { console.log = log; console.warn = warn; }
}

/* Page and field counts without asking pdf-lib to write anything back. Used
   for the forms that only fail the round trip. */
async function inspect(bytes) {
  const {getDocument} = await import('pdfjs-dist/legacy/build/pdf.mjs');
  /* The loading task owns the worker, not the document — destroying the wrong
     one throws and would make a perfectly readable form look unreadable.
     The copy matters just as much: pdf.js transfers the buffer it is handed to
     its worker, which detaches it here, and the caller would then write an
     empty file to disk without a single error to show for it. */
  const task = getDocument({data: bytes.slice(), useSystemFonts: false});
  const doc = await task.promise;
  let fields = 0;
  for (let n = 1; n <= doc.numPages; n++) {
    const annots = await (await doc.getPage(n)).getAnnotations();
    fields += annots.filter(a => a.subtype === 'Widget' && !a.pushButton).length;
  }
  const pages = doc.numPages;
  await task.destroy();
  return {pages, fields};
}

async function verify(bytes) {
  const doc = await PDFDocument.load(bytes, {ignoreEncryption: true, updateMetadata: false});
  const pages = doc.getPageCount();
  let fields = 0;
  try { fields = doc.getForm().getFields().length; } catch { fields = 0; }
  /* The round trip is the real test: loading proves it parses, saving proves we
     can hand it back. */
  const out = await doc.save();
  if (out.length < 1000) throw new Error('re-saved file is implausibly small');
  return {pages, fields};
}

for (const form of OFFICIAL) {
  const target = join(DIR, `${form.slug}.pdf`);
  /* An empty file counts as absent. It is what a half-finished write leaves
     behind, and treating it as a cache hit would keep serving nothing for as
     long as the file sat there. */
  const cached = !refresh && existsSync(target) && statSync(target).size > 0;

  let bytes;
  if (cached) {
    bytes = new Uint8Array(readFileSync(target));
  } else {
    try {
      const res = await fetch(form.file, {redirect: 'follow'});
      if (!res.ok) { skipped.push([form.slug, `HTTP ${res.status}`]); continue; }
      bytes = new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      skipped.push([form.slug, `fetch failed — ${String(err.message).slice(0, 60)}`]);
      continue;
    }
  }

  if (String.fromCharCode(...bytes.slice(0, 5)) !== '%PDF-') {
    skipped.push([form.slug, 'not a PDF']);
    continue;
  }

  /* Two different questions, and they have different answers often enough to
     matter. Can pdf.js render it? Almost always — that is what the editor needs
     to show it. Can pdf-lib write it back? Rather less often: most USCIS and SSA
     forms use object structures it refuses.
     A form that fails only the second question is still shipped. The editor
     exports it by rendering each page and drawing on top, which yields a filled,
     printable form rather than nothing at all. */
  let info = {pages: 0, fields: 0};
  let writable = true;
  try {
    info = await quietly(() => verify(bytes));
  } catch {
    writable = false;
    try {
      info = await inspect(bytes);
    } catch (err) {
      skipped.push([form.slug, `neither writable nor readable — ${String(err.message).slice(0, 44)}`]);
      continue;
    }
  }

  if (!cached) writeFileSync(target, bytes);

  /* Read back rather than trusted. The bytes have been through two PDF
     libraries by this point, and one of them transfers buffers away — the file
     on disk is the only thing the site will actually serve, so that is the
     thing worth checking. */
  const onDisk = statSync(target).size;
  if (onDisk < 1000) {
    skipped.push([form.slug, `wrote ${onDisk} bytes — refusing to ship it`]);
    continue;
  }

  manifest.forms[form.slug] = {
    code: form.code, name: form.name, agency: form.agency,
    category: form.category, tags: form.tags,
    source: form.source,
    bytes: statSync(target).size,
    pages: info.pages,
    fields: info.fields,
    /* False means the export path flattens instead of rewriting. The page says
       so before you start typing, rather than surprising you at the end. */
    writable,
    /* Kept from the previous run so a cached file does not look re-checked
       today when it was actually fetched months ago. */
    fetched: cached && previous.forms[form.slug]?.fetched
      ? previous.forms[form.slug].fetched
      : manifest.generated,
  };
}

writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

const kept = Object.keys(manifest.forms).length;
const flattenOnly = Object.entries(manifest.forms).filter(([, f]) => !f.writable).map(([s]) => s);
const totalMb = Object.values(manifest.forms).reduce((n, f) => n + f.bytes, 0) / 1024 / 1024;
const noFields = Object.entries(manifest.forms).filter(([, f]) => f.fields === 0).map(([s]) => s);

console.log(`\n${kept} of ${OFFICIAL.length} forms hosted · ${totalMb.toFixed(1)} MB`);
if (flattenOnly.length) {
  console.log(`\n${flattenOnly.length} export by flattening — pdf-lib cannot rewrite them:`);
  console.log('  ' + flattenOnly.join(', '));
}
if (noFields.length) {
  console.log(`\n${noFields.length} have no fillable fields (still editable with the text tool):`);
  console.log('  ' + noFields.join(', '));
}
if (skipped.length) {
  console.log(`\n${skipped.length} not shipped:`);
  for (const [slug, why] of skipped) console.log(`  ${slug.padEnd(14)} ${why}`);
}
