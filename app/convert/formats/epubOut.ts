/* PDF to EPUB — the words, taken off the paper.
 *
 * The two formats disagree about what a document is. A PDF is ink at
 * coordinates on a sheet of a fixed size; an EPUB is text that the reader
 * re-breaks to fit whatever it is being read on. So a conversion that keeps the
 * PDF's page boundaries has not converted anything — it has produced a book
 * that breaks mid-sentence every few hundred words, on a phone, for no reason
 * anyone holding the phone can see. The paper is the thing to throw away.
 *
 * What survives the trip is what a PDF genuinely carries and a browser can
 * genuinely read back: the words, the paragraphs they were set in, the type
 * sizes that mark a heading, and which runs were bold or italic. What does not
 * survive is anything that is not in the file to recover — and, deliberately,
 * the pictures: pulling images out of a PDF's content stream is a different and
 * much larger job than reading its text, and a half-done job would put some of
 * the figures in the book and silently lose the rest.
 *
 * The paragraph finder is core/blocks.ts, the same one the editor clicks on. It
 * exists because guessing paragraphs back out of coordinates is the hard part
 * and it has a corpus behind it; writing a second, worse one here would make
 * the same document come out differently depending on which door it walked in.
 */
import {Refused} from '../heavy.ts';
import {pdfjs} from '../../core/pdfjs.ts';
import type {PDFPageProxy} from '../../core/pdfjs.ts';
import {getBlocks} from '../../core/blocks.ts';
import type {Block, Line} from '../../core/blocks.ts';

const refuse = (m: string): never => { throw new Refused(m); };

/* A stretch of text that was set one way. Kept separate from its neighbours
   only while bold or italic differs, so a paragraph with one emphasised word
   is three fragments and an ordinary one is a single fragment. */
interface Frag {text: string; bold: boolean; italic: boolean}

interface Item {
  tag: 'h1' | 'h2' | 'p';
  frags: Frag[];
  /** Which sheet it came off. The only thing page numbers are used for is
   *  noticing that a paragraph ran over the edge of one. */
  page: number;
  /** Anchor, on headings only, so the contents can point at one that did not
   *  get a file of its own. */
  id?: string;
}

/** One sheet of the original, and the paragraphs found on it. Not called a
 *  Sheet because the engine already has one of those and it means an output
 *  file. */
interface Paper {height: number; blocks: Block[]}

/** Roughly how much text goes in one XHTML file before the next one starts.
 *  Not a rule of the format — a reader paginating a whole novel held in one
 *  file stalls on every jump, and a hundred files makes the archive tedious to
 *  inspect. Splits only ever land between paragraphs. */
const SPLIT_AT = 40_000;

export async function pdfToEpub(
  bytes: Uint8Array, name = '', onPage?: (done: number, total: number) => void,
): Promise<Blob> {
  /* Opened here rather than through the engine's own reader because the blocks
     need the page objects, not a finished string. The two refusals are worded
     the same as heavy.ts's on purpose: the same broken file should get the same
     sentence whichever converter it was dropped on. */
  const task = pdfjs.getDocument({data: bytes.slice()});
  const doc = await task.promise.catch(async (err: unknown) => {
    await task.destroy().catch(() => {});
    return refuse(/password/i.test(String((err as Error)?.message))
      ? 'That PDF is password protected, so its pages cannot be read.'
      : 'That file could not be opened as a PDF. It may be damaged.');
  });

  const sheets: Paper[] = [];
  let info: Record<string, unknown> = {};
  let fingerprint = '';
  try {
    info = ((await doc.getMetadata()).info ?? {}) as Record<string, unknown>;
    fingerprint = doc.fingerprints?.[0] ?? '';
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const height = page.getViewport({scale: 1}).height;
      sheets.push({height, blocks: await inReadingOrder(page, await getBlocks(page, n), height)});
      onPage?.(n, doc.numPages);
      /* The whole conversion runs on the main thread, and a long book is a lot
         of pages. Yielding between them keeps the tab answering. */
      await new Promise(r => setTimeout(r, 0));
    }
  } finally {
    await task.destroy().catch(() => {});
  }

  dropFurniture(sheets);

  const body = bodySize(sheets);
  const compounds = hyphenated(sheets);
  const items = stitch(sheets.flatMap(
    (sheet, i) => sheet.blocks.flatMap(b => toItems(b, i + 1, body, compounds)),
  ), compounds);

  if (!items.length) {
    refuse('That PDF has no text in it — its pages are images. Turning a scan into a book '
      + 'needs optical character recognition, which this does not do.');
  }

  let heading = 0;
  for (const item of items) if (item.tag === 'h1') item.id = `h${++heading}`;

  return pack(split(items, sheets.length), {
    title: bookTitle(info, name),
    author: oneLine(info['Author']),
    language: bcp47(info['Language']),
    id: identifier(fingerprint),
  });
}

/* ── reading the page ─────────────────────────────────────────────────────── */

/* Blocks come back sorted down the page and then across it, which is the order
 * an editor wants: the thing nearest the top of the sheet is the thing your eye
 * goes to first. It is the wrong order for prose in two columns, where it reads
 * a line of the left column, a line of the right, and so on down the page.
 *
 * The file itself knows better. Almost every generator — LaTeX, Word, InDesign,
 * a browser's print — emits the text in the order it is meant to be read,
 * column by column, and that is the order pdf.js hands the runs over in. So each
 * block is placed by where its earliest run appeared in the content stream. The
 * match is by exact coordinates, because both sides derive them from the same
 * numbers in the same way; if any block on the page fails to match, the whole
 * page keeps the geometric order rather than being half-sorted by two rules.
 *
 * It also means a PDF converted to EPUB and the same PDF converted to TXT put
 * the words in the same order, which they should. */
async function inReadingOrder(
  page: PDFPageProxy, blocks: Block[], height: number,
): Promise<Block[]> {
  if (blocks.length < 2) return blocks;

  const seen = new Map<string, number>();
  let content;
  try { content = await page.getTextContent(); } catch { return blocks; }
  content.items.forEach((item, i) => {
    if (!('str' in item) || !item.str.trim()) return;
    const [, , , , e = 0, f = 0] = item.transform as number[];
    const key = `${e}|${height - f}`;
    if (!seen.has(key)) seen.set(key, i);
  });

  const marks = blocks.map(b => Math.min(
    ...b.lines.map(l => seen.get(`${l.x0}|${l.baseline}`) ?? Infinity),
  ));
  if (marks.some(m => !Number.isFinite(m))) return blocks;

  return blocks
    .map((block, i) => ({block, at: marks[i]!}))
    .sort((m, n) => m.at - n.at)
    .map(x => x.block);
}

/* Running heads, folios, "Confidential — do not distribute" along the foot.
 *
 * These are furniture: they exist because the sheet has edges, and a book that
 * reflows has none. Left in, they land in the middle of a sentence every few
 * screens. The test is deliberately narrow — a single line, in the top or
 * bottom twelfth of the sheet, saying the same thing it says on other sheets
 * once the numbers in it are ignored, which is what makes "Page 4 of 30" match
 * "Page 5 of 30". A one-page document is left alone: nothing there repeats, and
 * a lone line at the top of a single sheet is a title, not a header. */
function dropFurniture(sheets: Paper[]): void {
  if (sheets.length < 2) return;

  const edge = (s: Paper, b: Block) => b.y < s.height * 0.08 || b.y + b.h > s.height * 0.92;
  const key = (b: Block) =>
    b.lines[0]!.text.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().toLowerCase();
  const candidate = (s: Paper, b: Block) => b.lines.length === 1 && edge(s, b) && key(b) !== '';

  const seen = new Map<string, number>();
  for (const sheet of sheets) {
    /* Counted once per sheet, so a page carrying the same line twice cannot
       convince the tally on its own. */
    for (const k of new Set(sheet.blocks.filter(b => candidate(sheet, b)).map(key))) {
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
  }

  const enough = sheets.length >= 4 ? 3 : sheets.length;
  for (const sheet of sheets) {
    sheet.blocks = sheet.blocks.filter(
      b => !(candidate(sheet, b) && (seen.get(key(b)) ?? 0) >= enough));
  }
}

/* The size most of the words are set in — the baseline everything else is
   judged against. Weighted by how many characters are set in each size rather
   than by how many lines, because a title page of six large lines must not
   convince a report that 24pt is its body text. */
function bodySize(sheets: Paper[]): number {
  const weight = new Map<number, number>();
  for (const sheet of sheets) {
    for (const block of sheet.blocks) {
      for (const line of block.lines) {
        const k = Math.round(line.size * 2) / 2;
        weight.set(k, (weight.get(k) ?? 0) + line.text.length);
      }
    }
  }
  let best = 12, most = -1;
  for (const [size, n] of weight) if (n > most) { most = n; best = size; }
  return best;
}

/* Every hyphenated compound the document uses in the middle of a line.
 *
 * This is the evidence for the one genuinely ambiguous decision in the whole
 * conversion. A hyphen at the end of a line is either the typesetter breaking a
 * word to fill the measure — "infor-" / "mation", which must be joined up or
 * the reflowed text is visibly broken — or a real compound that happened to
 * fall there, "well-" / "known", which must not be. Nothing about the two looks
 * different at the break.
 *
 * But a document that writes "well-known" once usually writes it again
 * somewhere it did not need to break, and that sighting is proof. So the
 * hyphen is dropped unless the same compound appears intact elsewhere in the
 * book. A line-ending hyphen can never enter this set: there is no letter after
 * it on its own line. */
function hyphenated(sheets: Paper[]): Set<string> {
  const out = new Set<string>();
  for (const sheet of sheets) {
    for (const block of sheet.blocks) {
      for (const line of block.lines) {
        for (const m of line.text.matchAll(/(\p{L}{2,})-(\p{L}{2,})/gu)) {
          out.add(`${m[1]}-${m[2]}`.toLowerCase());
        }
      }
    }
  }
  return out;
}

/* ── blocks into paragraphs ───────────────────────────────────────────────── */

const toItems = (block: Block, page: number, body: number, compounds: Set<string>): Item[] =>
  paragraphs(block).map(lines => toItem(lines, page, body, compounds)).filter(x => x !== null);

/* One block is not always one paragraph.
 *
 * The block finder is looking for something to click on, and a page of prose
 * set the way books are set — no space between paragraphs, a first line
 * indented instead — is one thing to click on. Every line sits under the last
 * one, they all share a right edge, so the four tests that keep a heading out
 * of its body have nothing to object to and the whole page comes back as a
 * single block. Printed, that is correct. Reflowed, it is a page-long paragraph.
 *
 * The indent is the signal the typesetter left, so it is the signal used: a
 * line that starts further in than the block's own left margin begins a new
 * paragraph — unless the line after it is indented too, which means the block
 * is set with a hanging indent and the indent means the opposite. In justified
 * text there is a second signal, and it is safe there and nowhere else: a line
 * that stops short of the right margin can only be the end of something, since
 * every other line was stretched to reach it. */
function paragraphs(block: Block): Line[][] {
  const lines = block.lines;
  if (lines.length < 2 || block.align === 'center' || block.align === 'right') return [lines];

  const left = Math.min(...lines.map(l => l.x0));
  const right = Math.max(...lines.map(l => l.x1));

  const indented = (l: Line | undefined) => !!l && l.x0 - left > l.size * 0.5;

  const out: Line[][] = [[lines[0]!]];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    const starts = (indented(line) && !indented(lines[i + 1]))
      || (block.align === 'justify' && lines[i - 1]!.x1 < right - line.size * 3);
    if (starts) out.push([line]); else out[out.length - 1]!.push(line);
  }
  return out;
}

function toItem(lines: Line[], page: number, body: number, compounds: Set<string>): Item | null {
  const frags: Frag[] = [];
  lines.forEach((line, i) => {
    if (i) bridge(frags, line.text, compounds);
    for (const run of line.runs) push(frags, run.text, run.bold, run.italic);
  });
  tidy(frags);
  if (!frags.length) return null;

  /* The dominant size, not the largest: one superscript must not promote a
     paragraph to a heading. */
  const sizes = lines.map(l => l.size).sort((m, n) => m - n);
  const size = sizes[Math.floor((sizes.length - 1) / 2)]!;
  const text = plain(frags);

  /* A heading here is measured, not guessed. The only claim being made is that
     these words are set larger than the words around them and there are few of
     them — which is what the file says, in numbers. Nothing is promoted for
     being bold, or short, or in capitals, because those are the guesses that
     turn a table of contents into forty chapters. */
  const short = text.length <= 140 && lines.length <= 3;
  const tag: Item['tag'] = !short ? 'p'
    : size >= body * 1.45 ? 'h1'
    : size >= body * 1.15 ? 'h2'
    : 'p';

  return {tag, frags, page};
}

/* A paragraph that ran over the bottom of one sheet and carried on at the top
 * of the next is one paragraph. The PDF has no way of saying so — it has two
 * groups of ink on two sheets — but the sentence does: it did not finish, and
 * what follows begins in lower case. Joining them is the whole point of the
 * format, and it is the only join made: two paragraphs on the *same* sheet were
 * already told apart by the spacing or the indent, where the evidence was
 * there to see. Across a sheet boundary there is no spacing and no indent to
 * read, which is exactly why the sentence has to be asked instead. */
function stitch(items: Item[], compounds: Set<string>): Item[] {
  const out: Item[] = [];
  for (const item of items) {
    const prev = out[out.length - 1];
    if (prev && prev.tag === 'p' && item.tag === 'p'
        && item.page === prev.page + 1 && continues(plain(prev.frags), plain(item.frags))) {
      bridge(prev.frags, plain(item.frags), compounds);
      for (const f of item.frags) push(prev.frags, f.text, f.bold, f.italic);
      /* Moved to the later sheet so a third paragraph on that same sheet is no
         longer a page apart, and cannot be swept up by the same test. */
      prev.page = item.page;
      continue;
    }
    out.push(item);
  }
  return out;
}

/* Sentence-ending punctuation closes a paragraph; so does a capital at the
   start of the next one. Quotation marks and brackets count as closers because
   they follow the stop. */
const continues = (before: string, after: string): boolean =>
  !/[.!?:;»”"')\]]\s*$/.test(before) && (/-$/.test(before) || /^[\p{Ll}\p{Nd}]/u.test(after));

/* Joining one line to the next, and the one decision that has to be made there:
   whether the hyphen at the end of the first was a word or a line break. */
function bridge(frags: Frag[], next: string, compounds: Set<string>): void {
  const last = frags[frags.length - 1];
  if (!last?.text) return;

  const head = /(\p{L}[\p{L}'’]*)-$/u.exec(last.text)?.[1];
  const tail = /^(\p{L}[\p{L}'’]*)/u.exec(next.replace(/^\s+/, ''))?.[1];
  if (head && tail) {
    /* Either way the two halves belong to one word, so no space is added
       between them — only the hyphen is in question. A capital after the break
       keeps it whatever the evidence says: "anti-American" is a compound, and
       no typesetter breaks a word onto a capital letter. */
    if (!/^\p{Lu}/u.test(tail) && !compounds.has(`${head}-${tail}`.toLowerCase())) {
      last.text = last.text.slice(0, -1);
    }
    return;
  }
  if (!/\s$/.test(last.text)) last.text += ' ';
}

function push(frags: Frag[], text: string, bold: boolean, italic: boolean): void {
  if (!text) return;
  const last = frags[frags.length - 1];
  if (last && last.bold === bold && last.italic === italic) last.text += text;
  else frags.push({text, bold, italic});
}

const plain = (frags: Frag[]): string => frags.map(f => f.text).join('');

/* Whitespace collapsed across the fragment boundaries rather than inside each
   one, so a space that fell between two differently-set runs is not lost and
   not doubled. Soft hyphens go: they are invisible in the PDF and would sit in
   the middle of words in a book that can be searched. */
function tidy(frags: Frag[]): void {
  for (const f of frags) {
    f.text = f.text.replace(/\u00ad/g, '').replace(/\s+/g, ' ');
  }
  let i = 0;
  while (i < frags.length) {
    if (frags[i]!.text === '') frags.splice(i, 1); else i++;
  }
  if (!frags.length) return;
  frags[0]!.text = frags[0]!.text.replace(/^\s+/, '');
  frags[frags.length - 1]!.text = frags[frags.length - 1]!.text.replace(/\s+$/, '');
  if (frags.length && frags[0]!.text === '') frags.shift();
  if (frags.length && frags[frags.length - 1]!.text === '') frags.pop();
}

/* ── paragraphs into documents ────────────────────────────────────────────── */

interface Chapter {file: string; items: Item[]}
interface Entry {href: string; label: string}

/* Where one XHTML file ends and the next begins.
 *
 * A new file at every top-level heading, because that is a chapter and a reader
 * starts every spine item on a fresh screen. That last part is also why nothing
 * else forces a break: a file boundary in the wrong place looks exactly like
 * the paper break this conversion exists to remove. The size cap is the one
 * exception, and by then the items are whole paragraphs, so its seam can only
 * fall where the writing already stopped.
 *
 * Unless the headings are not chapters at all. A tax form sets half its lines
 * larger than its six-point small print, and the measurement that finds a real
 * chapter heading finds forty of them there. More headings than sheets of paper
 * is the tell: whatever that document is, it is not a book with chapters, and
 * cutting it into forty spine items would only make it harder to read. The
 * headings stay — they are still measurably headings — but the file boundaries
 * go, and the table of contents points into the text instead. */
function split(items: Item[], sheets: number): Chapter[] {
  const perChapter = items.filter(i => i.tag === 'h1').length <= sheets;
  const out: Chapter[] = [];
  let size = 0;

  for (const item of items) {
    const open = out[out.length - 1];
    const chapter = perChapter && item.tag === 'h1' && !!open?.items.length;
    if (!open || chapter || size > SPLIT_AT) {
      out.push({file: `c${String(out.length + 1).padStart(3, '0')}.xhtml`, items: []});
      size = 0;
    }
    out[out.length - 1]!.items.push(item);
    size += plain(item.frags).length;
  }
  return out;
}

/* Every top-level heading, wherever it ended up. Linked to the file when the
   heading opens one and to an anchor inside it when it does not, so the
   contents are the same list either way. A book with no headings at all still
   gets one line — a reader with an empty table of contents looks broken. */
function contents(chapters: Chapter[], meta: Meta): Entry[] {
  const out: Entry[] = [];
  for (const c of chapters) {
    c.items.forEach((item, i) => {
      if (item.tag !== 'h1') return;
      out.push({href: i === 0 ? c.file : `${c.file}#${item.id}`, label: plain(item.frags)});
    });
  }
  return out.length ? out : [{href: chapters[0]!.file, label: meta.title}];
}

const chapterTitle = (chapter: Chapter, meta: Meta): string =>
  plain(chapter.items.find(i => i.tag === 'h1')?.frags ?? []) || meta.title;

/* ── the package ──────────────────────────────────────────────────────────── */

interface Meta {title: string; author: string; language: string; id: string}

async function pack(chapters: Chapter[], meta: Meta): Promise<Blob> {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();

  /* The one hard rule of the container: "mimetype" is the first entry in the
     archive and it is stored, not deflated, so that a reader can identify the
     file by looking at a fixed offset without unpacking anything. JSZip writes
     entries in the order they were added, so this line has to stay first — and
     the compression has to be overridden per file, because the archive as a
     whole is deflated. */
  zip.file('mimetype', 'application/epub+zip', {compression: 'STORE'});

  zip.file('META-INF/container.xml',
    `<?xml version="1.0" encoding="utf-8"?>\n`
    + `<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">`
    + `<rootfiles><rootfile full-path="OEBPS/package.opf" `
    + `media-type="application/oebps-package+xml"/></rootfiles></container>`);

  const toc = contents(chapters, meta);
  zip.file('OEBPS/style.css', CSS);
  for (const c of chapters) zip.file(`OEBPS/${c.file}`, chapterXhtml(c, meta));
  zip.file('OEBPS/nav.xhtml', navXhtml(toc, meta));
  zip.file('OEBPS/toc.ncx', ncx(toc, meta));
  zip.file('OEBPS/package.opf', opf(chapters, meta));

  const out = await zip.generateAsync({
    type: 'uint8array', compression: 'DEFLATE', mimeType: 'application/epub+zip',
  });
  return new Blob([out.slice() as BlobPart], {type: 'application/epub+zip'});
}

const CSS = `html { font-size: 100%; }
body { margin: 0 5%; line-height: 1.5; }
h1, h2 { line-height: 1.25; margin: 1.4em 0 0.6em; }
h1 { font-size: 1.5em; }
h2 { font-size: 1.2em; }
p { margin: 0 0 0.7em; }
nav ol { list-style: none; padding: 0; }
nav li { margin: 0.4em 0; }
`;

function chapterXhtml(chapter: Chapter, meta: Meta): string {
  const body = chapter.items.map(item => {
    const inner = item.tag === 'p' ? inline(item.frags) : xml(plain(item.frags));
    const id = item.id ? ` id="${item.id}"` : '';
    return `<${item.tag}${id}>${inner}</${item.tag}>`;
  }).join('\n');
  return xhtmlPage(chapterTitle(chapter, meta), body, meta.language);
}

/* Bold and italic are carried across because the file names the faces it drew
   with — "OpenSans-Bold" is not an inference. Headings are left alone: the
   heading element already says the words are set apart, and wrapping the whole
   of one in <strong> only makes it heavier than the stylesheet intended. */
function inline(frags: Frag[]): string {
  return frags.map(f => {
    let out = xml(f.text);
    if (f.italic) out = `<em>${out}</em>`;
    if (f.bold) out = `<strong>${out}</strong>`;
    return out;
  }).join('');
}

function navXhtml(toc: Entry[], meta: Meta): string {
  const list = toc.map(
    e => `<li><a href="${e.href}">${xml(e.label)}</a></li>`).join('\n');
  return xhtmlPage('Contents',
    `<nav epub:type="toc" id="toc">\n<h1>Contents</h1>\n<ol>\n${list}\n</ol>\n</nav>`,
    meta.language);
}

function xhtmlPage(title: string, body: string, language: string): string {
  const lang = language === 'und' ? '' : ` lang="${language}" xml:lang="${language}"`;
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"${lang}>
<head>
<meta charset="utf-8"/>
<title>${xml(title)}</title>
<link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
${body}
</body>
</html>
`;
}

function opf(chapters: Chapter[], meta: Meta): string {
  const items = chapters.map(
    c => `<item id="${c.file.replace('.xhtml', '')}" href="${c.file}" `
       + `media-type="application/xhtml+xml"/>`).join('\n');
  const spine = chapters.map(
    c => `<itemref idref="${c.file.replace('.xhtml', '')}"/>`).join('\n');
  /* Whole seconds: the format asks for exactly this shape and rejects the
     milliseconds a browser's toISOString puts in. */
  const when = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="pub-id">${xml(meta.id)}</dc:identifier>
<dc:title>${xml(meta.title)}</dc:title>
<dc:language>${xml(meta.language)}</dc:language>
${meta.author ? `<dc:creator>${xml(meta.author)}</dc:creator>\n` : ''}<meta property="dcterms:modified">${when}</meta>
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
<item id="css" href="style.css" media-type="text/css"/>
${items}
</manifest>
<spine toc="ncx">
${spine}
</spine>
</package>
`;
}

/* EPUB 3 keeps its contents in nav.xhtml and this file is obsolete — except on
   the readers that never moved, which will not open a book without it. It costs
   a few hundred bytes and is what makes the output work on a decade-old Kobo. */
function ncx(toc: Entry[], meta: Meta): string {
  const points = toc.map((e, i) =>
    `<navPoint id="np${i + 1}" playOrder="${i + 1}">`
    + `<navLabel><text>${xml(e.label)}</text></navLabel>`
    + `<content src="${e.href}"/></navPoint>`).join('\n');

  return `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head>
<meta name="dtb:uid" content="${xml(meta.id)}"/>
<meta name="dtb:depth" content="1"/>
<meta name="dtb:totalPageCount" content="0"/>
<meta name="dtb:maxPageNumber" content="0"/>
</head>
<docTitle><text>${xml(meta.title)}</text></docTitle>
<navMap>
${points}
</navMap>
</ncx>
`;
}

/* ── the small print ──────────────────────────────────────────────────────── */

/* XHTML is XML, and XML has no recovery mode: one control byte that drifted out
   of a PDF and the reader refuses the entire book rather than the character.
   Lone surrogates go for the same reason — they cannot be encoded as UTF-8 at
   all. */
function xml(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) continue;
    if ((c >= 0x7f && c <= 0x9f) || c === 0xfffe || c === 0xffff) continue;
    /* A lone half of a surrogate pair: not a character, and not encodable as
       UTF-8 either, so nothing downstream could carry it even if XML allowed
       it. */
    if (c >= 0xd800 && c <= 0xdfff) continue;
    out += c === 0x26 ? '&amp;' : c === 0x3c ? '&lt;'
      : c === 0x3e ? '&gt;' : c === 0x22 ? '&quot;' : ch;
  }
  return out;
}

const oneLine = (v: unknown): string => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);

/* What to call the book. The PDF's own title is preferred over the file name
   when it says anything — but half the titles in the wild are the artefact the
   producer left behind, "Microsoft Word - draft3.doc", and a shelf full of
   those is worse than a shelf of file names. */
function bookTitle(info: Record<string, unknown>, name: string): string {
  const claimed = oneLine(info['Title'])
    .replace(/^Microsoft (?:Word|PowerPoint) - /i, '')
    .replace(/\.(?:docx?|pptx?|pages|indd|pdf|tex|rtf|odt)$/i, '')
    .trim();
  const junk = !claimed || /^(untitled|document\d*|no title|slide \d+)$/i.test(claimed);
  return (junk ? '' : claimed) || oneLine(name) || 'Untitled';
}

/* The format insists on a language, and the only place to get an honest one is
   the PDF's own catalogue, where the generator recorded it or did not. Guessing
   from the alphabet would mean choosing between Ukrainian, Russian and Bulgarian
   on the strength of a Cyrillic letter. "und" is the registered tag for exactly
   this: the language is not known. */
function bcp47(v: unknown): string {
  const tag = String(v ?? '').trim();
  return /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(tag) ? tag : 'und';
}

/* Every EPUB needs an identifier nothing else shares. It is built from the
   PDF's own fingerprint — pdf.js's hash of the file's identity — so converting
   the same book twice produces the same identifier, and the second copy
   replaces the first on a shelf instead of sitting beside it. Version 8 is the
   UUID that exists to say "these bits mean something to whoever made them",
   which is exactly what this is. */
function identifier(fingerprint: string): string {
  const hex = /^[0-9a-f]{32}$/i.test(fingerprint) ? fingerprint.toLowerCase() : randomHex();
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const v = `${hex.slice(0, 12)}8${hex.slice(13, 16)}${variant}${hex.slice(17)}`;
  return `urn:uuid:${v.slice(0, 8)}-${v.slice(8, 12)}-${v.slice(12, 16)}-`
    + `${v.slice(16, 20)}-${v.slice(20, 32)}`;
}

function randomHex(): string {
  const n = new Uint8Array(16);
  crypto.getRandomValues(n);
  return [...n].map(b => b.toString(16).padStart(2, '0')).join('');
}
