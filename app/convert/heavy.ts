/* The conversions that need a real library behind them.
 *
 * Kept out of assets/convert.js on purpose. Turning a PNG into a JPG is a
 * canvas call and should cost a few kilobytes; opening a PDF costs pdf.js, and
 * decoding an iPhone photo costs a megabyte and a half of WebAssembly. Loading
 * either of those on a page that will never use them is the difference between
 * a converter that feels instant and one that does not.
 *
 * Everything here is still local. Nothing is uploaded, and there is no server
 * to upload it to.
 */
import {PDFDocument, StandardFonts, rgb} from 'pdf-lib';
import {pdfjs} from '../core/pdfjs';
import {needsUnicode, unicodeFont} from '../core/unicodeFont';
import {renderPage} from '../core/render';

/* Two modules define this — assets/convert.js has its own — and an instanceof
   check across that boundary is false even when both mean the same thing. The
   thing. The name is what the caller checks, so it is set explicitly rather
   than left to whatever minification calls the class. */
export class Refused extends Error {
  override name = 'Refused';
}
const refuse = (m: string): never => { throw new Refused(m); };

/* ── PDF in ───────────────────────────────────────────────────────────── */

export interface Sheet {name: string; blob: Blob}

/* One place that turns bytes into an open document, so the two readers below
   report the same thing when a file will not open — and so the type checker
   can see that past this line there is always a document. */
async function openPdf(bytes: Uint8Array) {
  const task = pdfjs.getDocument({data: bytes.slice()});
  try {
    return {task, doc: await task.promise};
  } catch (err) {
    await task.destroy().catch(() => {});
    return refuse(/password/i.test(String((err as Error)?.message))
      ? 'That PDF is password protected, so its pages cannot be read.'
      : 'That file could not be opened as a PDF. It may be damaged.');
  }
}

/* Renders every page to a picture. A one-page document hands back the picture
   itself; anything longer is zipped, because thirty separate download prompts
   is not a feature. */
export async function pdfToImages(
  bytes: Uint8Array, type: 'image/jpeg' | 'image/png', base: string,
  onPage?: (done: number, total: number) => void,
): Promise<Sheet[]> {
  const {task, doc} = await openPdf(bytes);

  const ext = type === 'image/png' ? 'png' : 'jpg';
  const pad = String(doc.numPages).length;
  const out: Sheet[] = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const canvas = document.createElement('canvas');
      /* 2× is 144 dpi — sharp enough to read and to print small, and well
         inside what a browser will allocate for a large page. */
      /* .done, not the call. renderPage hands back a task object so the
         viewer can cancel a render that scrolling has already made pointless —
         awaiting the object itself resolves at once, and the page is then read
         off a canvas nothing has drawn on. With alpha:false that canvas is
         opaque black, which is exactly what came out. */
      await renderPage(page, canvas, {scale: 2, dpr: 1}).done;
      const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, type, 0.92));
      if (!blob) refuse(`Page ${n} could not be encoded as ${ext.toUpperCase()}.`);
      out.push({
        name: doc.numPages === 1 ? `${base}.${ext}`
          : `${base}-${String(n).padStart(pad, '0')}.${ext}`,
        blob: blob!,
      });
      /* Freed as we go: thirty A4 pages at 2× is about a gigabyte of canvas if
         they are all kept alive at once. */
      canvas.width = canvas.height = 0;
      onPage?.(n, doc.numPages);
      await new Promise(r => setTimeout(r, 0));
    }
  } finally {
    await task.destroy().catch(() => {});
  }
  return out;
}

export async function pdfToText(bytes: Uint8Array): Promise<Blob> {
  const {task, doc} = await openPdf(bytes);

  const parts: string[] = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const content = await (await doc.getPage(n)).getTextContent();
      /* pdf.js gives runs, not lines. `hasEOL` is its own record of where the
         source put a line break, which is the only honest place to put one —
         guessing from coordinates turns a two-column page into nonsense. */
      let line = '';
      const lines: string[] = [];
      for (const item of content.items) {
        if (!('str' in item)) continue;
        line += item.str;
        if (item.hasEOL) { lines.push(line); line = ''; }
      }
      if (line) lines.push(line);
      parts.push(lines.join('\n'));
    }
  } finally {
    await task.destroy().catch(() => {});
  }

  const text = parts.join('\n\n');
  if (!text.trim()) {
    refuse('That PDF has no text in it — its pages are images. Extracting words from a '
      + 'scan needs optical character recognition, which this does not do.');
  }
  return new Blob([text], {type: 'text/plain;charset=utf-8'});
}

/* The same words, in the format a word processor opens without asking.
 *
 * RTF rather than DOCX where the goal is only "editable text": it is one file
 * of plain ASCII with no zip and no schema, every processor since 1987 reads
 * it, and what a PDF can honestly give — the words and where the lines broke —
 * fits it exactly. Anything past that (headings, tables, columns) is not in the
 * PDF to recover, and markup that claims otherwise is markup that lies. */
export async function pdfToRtf(bytes: Uint8Array): Promise<Blob> {
  const text = await (await pdfToText(bytes)).text();

  /* RTF is Latin-1 with escapes; anything above it goes out as a signed
     16-bit \u escape with an ASCII stand-in behind it, which is what readers
     that predate Unicode fall back to. */
  const escape = (s: string) => {
    let out = '';
    for (const ch of s) {
      const c = ch.codePointAt(0)!;
      if (ch === '\\' || ch === '{' || ch === '}') out += '\\' + ch;
      else if (c < 128) out += ch;
      else if (c <= 0xffff) out += `\\u${c > 32767 ? c - 65536 : c}?`;
      else {
        /* Outside the basic plane RTF wants the surrogate pair, each escaped. */
        const v = c - 0x10000;
        const hi = 0xd800 + (v >> 10), lo = 0xdc00 + (v & 0x3ff);
        out += `\\u${hi > 32767 ? hi - 65536 : hi}?\\u${lo > 32767 ? lo - 65536 : lo}?`;
      }
    }
    return out;
  };

  const body = text.split('\n')
    .map(line => (line.trim() ? escape(line) : ''))
    .join('\\par\n');

  const rtf = '{\\rtf1\\ansi\\ansicpg1252\\deff0'
    + '{\\fonttbl{\\f0\\fswiss\\fcharset0 Helvetica;}}'
    + '\\viewkind4\\uc1\\pard\\f0\\fs22\n'
    + body
    + '\\par\n}';
  return new Blob([rtf], {type: 'application/rtf'});
}

/* ── PDF out ──────────────────────────────────────────────────────────── */

/* One page per picture, sized to the picture rather than forced onto A4: a
   screenshot padded into portrait A4 with white margins is not what anyone
   means by "image to PDF". */
export async function imagesToPdf(items: Array<{bytes: Uint8Array; kind: string}>): Promise<Blob> {
  const doc = await PDFDocument.create();
  for (const {bytes, kind} of items) {
    const img = kind === 'png'
      ? await doc.embedPng(bytes)
      : await doc.embedJpg(bytes);
    const page = doc.addPage([img.width, img.height]);
    page.drawImage(img, {x: 0, y: 0, width: img.width, height: img.height});
  }
  if (doc.getPageCount() === 0) refuse('There was nothing to put in the PDF.');
  return new Blob([(await doc.save()).slice() as BlobPart], {type: 'application/pdf'});
}

/* An Illustrator file has been a PDF since version 9.
 *
 * Adobe writes AI as a PDF with its own editable artwork tucked into a private
 * stream that only Illustrator reads; every reader in the world already opens
 * the file, and the only thing standing between it and a .pdf extension is the
 * extension. So this does not convert anything — it checks that the claim is
 * true and re-saves through pdf-lib, which drops the private section and leaves
 * a clean PDF. An older, PostScript-era .ai is refused rather than mangled. */
export async function aiToPdf(bytes: Uint8Array): Promise<Blob> {
  const head = new TextDecoder('latin1').decode(bytes.slice(0, 1024));
  if (!head.startsWith('%PDF')) {
    refuse(head.startsWith('%!PS')
      ? 'That is a PostScript-era Illustrator file, saved before Adobe moved AI to PDF in '
        + 'version 9. Open it in Illustrator and save as PDF.'
      : 'That file does not look like an Illustrator document.');
  }
  const doc = await PDFDocument.load(bytes.slice(), {ignoreEncryption: true, updateMetadata: false});
  if (doc.getPageCount() === 0) refuse('That Illustrator file has no artboards in it.');
  return new Blob([(await doc.save()).slice() as BlobPart], {type: 'application/pdf'});
}

/* A TIFF is a container of pages, so it becomes a PDF of pages.
 *
 * No engine but Safari's decodes TIFF, which is why this cannot go through the
 * ordinary picture route — the browser will not put one in an <img>. UTIF is
 * already here for writing them; reading is the same library from the other
 * end. Each page is turned into straight RGBA, painted onto a canvas and
 * embedded as PNG, because pdf-lib takes PNG and JPEG and nothing else. */
export async function tiffToPdf(bytes: Uint8Array): Promise<Blob> {
  const UTIF = (await import('utif')).default;
  let pages: import('utif').IFD[];
  try {
    pages = UTIF.decode(bytes.slice().buffer as ArrayBuffer);
  } catch {
    return refuse('That file is not a TIFF the decoder could read.');
  }
  if (!pages.length) refuse('That TIFF has no pages in it.');

  const items: Array<{bytes: Uint8Array; kind: string}> = [];
  for (const ifd of pages) {
    UTIF.decodeImage(bytes.slice().buffer as ArrayBuffer, ifd, pages);
    const rgba = UTIF.toRGBA8(ifd);
    const w = ifd.width, h = ifd.height;
    if (!w || !h || !rgba?.length) continue;

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return refuse('Canvas 2D is unavailable in this browser.');
    ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0);

    const png = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/png'));
    if (png) items.push({bytes: new Uint8Array(await png.arrayBuffer()), kind: 'png'});
    canvas.width = canvas.height = 0;
  }
  if (!items.length) refuse('None of the pages in that TIFF could be decoded.');
  return imagesToPdf(items);
}

/* Plain text onto pages. Wrapped by measuring the font rather than by counting
   characters, so a line of capitals does not overrun where a line of lowercase
   fits. */
export async function textToPdf(text: string, mono = false): Promise<Blob> {
  guardBinary(text);
  const doc = await PDFDocument.create();
  /* A real Unicode face the moment the text needs one. It is fetched on demand
     and subsetted, so an English document still carries no embedded font and a
     Ukrainian one carries about eight kilobytes. */
  const font = needsUnicode(text)
    ? await unicodeFont(doc, mono ? 'mono' : 'sans')
    : await doc.embedFont(mono ? StandardFonts.Courier : StandardFonts.Helvetica);
  const A4 = {w: 595.28, h: 841.89};
  const M = 56, SIZE = mono ? 9.5 : 11, LEAD = SIZE * 1.45;
  const width = A4.w - M * 2;

  const safe = clean(text);
  const lines: string[] = [];
  for (const para of safe.split(/\r?\n/)) {
    if (!para) { lines.push(''); continue; }
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      const next = line + word;
      if (font.widthOfTextAtSize(next, SIZE) > width && line.trim()) {
        lines.push(line.replace(/\s+$/, ''));
        line = word.replace(/^\s+/, '');
      } else {
        line = next;
      }
    }
    lines.push(line);
  }

  let page = doc.addPage([A4.w, A4.h]);
  let y = A4.h - M;
  for (const line of lines) {
    if (y < M) { page = doc.addPage([A4.w, A4.h]); y = A4.h - M; }
    if (line) page.drawText(line, {x: M, y: y - SIZE, size: SIZE, font, color: rgb(0.09, 0.11, 0.15)});
    y -= LEAD;
  }
  return new Blob([(await doc.save()).slice() as BlobPart], {type: 'application/pdf'});
}

/* ── Word ─────────────────────────────────────────────────────────────── */

/* A .docx is a zip of XML, which is the only reason this is possible at all in
 * a browser: JSZip is already here for EPUB, and the rest is markup.
 *
 * What goes in is what a PDF can honestly give — the words and where the lines
 * broke. A PDF has no headings, no lists and no tables to recover; it has
 * glyphs at coordinates. Writing <w:pStyle w:val="Heading1"/> around a line
 * because it happened to be short and bold would be inventing structure, and
 * the document would be wrong in a way that is worse than plain, because it
 * would look deliberate. So: paragraphs, in order, in a real Word file. */
const XML_ESC = (s: string) => s
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  /* Control characters are illegal in XML 1.0 and Word refuses the whole file
     rather than the character — a single stray 0x0C from a PDF would otherwise
     cost the entire conversion. */
  .replace(/[ --]/g, '');

const DOCX_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Default Extension="jpeg" ContentType="image/jpeg"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const DOCX_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

/** Wraps a finished `<w:body>` in the four parts a reader needs to open it. */
async function packDocx(body: string, extra: Array<{path: string; data: Uint8Array | string}> = []) {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  zip.file('[Content_Types].xml', DOCX_TYPES);
  zip.file('_rels/.rels', DOCX_RELS);
  zip.file('word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`
    + `<w:document ${W_NS} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" `
    + `xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" `
    + `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" `
    + `xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">`
    + `<w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>`
    + `<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`);
  for (const {path, data} of extra) zip.file(path, data as never);
  const out = await zip.generateAsync({type: 'uint8array', compression: 'DEFLATE'});
  return new Blob([out.slice() as BlobPart], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
}

export async function pdfToWord(bytes: Uint8Array): Promise<Blob> {
  const text = await (await pdfToText(bytes)).text();
  const body = text.split(/\r?\n/).map(line => {
    const t = XML_ESC(line);
    /* xml:space="preserve" or Word eats leading indentation, which is the one
       piece of layout a text dump actually carries. */
    return t.trim()
      ? `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`
      : '<w:p/>';
  }).join('');
  return packDocx(body);
}

/* A picture in a Word file, sized to the page rather than to its pixels: a
   4000-pixel photograph placed at its natural size is a document eleven pages
   wide, which is what every naive image-to-Word converter produces. */
export async function imageToWord(
  image: Uint8Array, kind: 'png' | 'jpeg', width: number, height: number,
): Promise<Blob> {
  /* EMUs — English Metric Units, 914400 to the inch, which is how Office
     measures everything. The text column of the page above is 6.27 inches. */
  const EMU = 914400;
  const maxW = 6.27 * EMU;
  const scale = Math.min(1, maxW / (width / 96 * EMU));
  const cx = Math.round((width / 96) * EMU * scale);
  const cy = Math.round((height / 96) * EMU * scale);
  const ext = kind === 'png' ? 'png' : 'jpeg';

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.${ext}"/>
</Relationships>`;

  const body = `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">`
    + `<wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="1" name="Picture 1"/>`
    + `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">`
    + `<pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="image1.${ext}"/><pic:cNvPicPr/></pic:nvPicPr>`
    + `<pic:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
    + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`
    + `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>`
    + `</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;

  return packDocx(body, [
    {path: 'word/_rels/document.xml.rels', data: rels},
    {path: `word/media/image1.${ext}`, data: image},
  ]);
}

/* The other direction. Word's own markup is read rather than guessed at: a
 * paragraph is <w:p>, a run of like-styled text is <w:r>, and the text itself
 * is <w:t>. Everything between them — revision marks, bookmarks, proofing
 * errors — is skipped by walking the tree instead of stripping tags with a
 * regular expression, which is what turns a tracked-changes document into
 * nonsense.
 *
 * A tab is a tab and a break is a line break, both of which carry meaning that
 * the text alone does not. */
export async function docxToPdf(bytes: Uint8Array): Promise<Blob> {
  const JSZip = (await import('jszip')).default;
  let zip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    return refuse('That file could not be opened. A .docx is a zip archive, and this one '
      + 'does not unpack — an older .doc from before Word 2007 is a different format '
      + 'entirely and has to be saved as .docx first.');
  }

  const main = zip.file('word/document.xml');
  if (!main) {
    return refuse('That zip is not a Word document — it has no word/document.xml in it.');
  }
  const xml = await main.async('string');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) refuse('The document markup inside that file is not valid XML.');

  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const paragraphs: string[] = [];
  for (const p of Array.from(doc.getElementsByTagNameNS(W, 'p'))) {
    let line = '';
    /* Depth-first over the paragraph's own children, so a run inside a
       hyperlink or a smart-tag is picked up and one inside a deleted revision
       is not. */
    const walk = (node: Element) => {
      for (const child of Array.from(node.children)) {
        const name = child.localName;
        if (name === 'del' || name === 'instrText') continue;
        if (name === 't') line += child.textContent ?? '';
        else if (name === 'tab') line += '\t';
        else if (name === 'br') line += '\n';
        else walk(child);
      }
    };
    walk(p);
    paragraphs.push(line);
  }

  const text = paragraphs.join('\n').replace(/\n{3,}/g, '\n\n');
  if (!text.trim()) {
    refuse('That document has no text in it. If its content is images, convert those '
      + 'to PDF instead.');
  }
  return textToPdf(text);
}

/* A CSV becomes a table rather than a wall of commas — which is the only
   reason to put one in a PDF at all. */
export async function csvToPdf(text: string): Promise<Blob> {
  guardBinary(text);
  const rows = parseCsv(text);
  if (!rows.length) refuse('That CSV has no rows in it.');
  return tablesToPdf([{name: '', rows}]);
}

/* One or more tables, drawn the same way.
 *
 * A spreadsheet and a comma-separated file are the same data in two wrappers,
 * so they get the same renderer — otherwise the two converters would drift and
 * the same numbers would come out looking different depending on which page
 * they were dropped on. */
export async function tablesToPdf(sheets: Array<{name: string; rows: string[][]}>): Promise<Blob> {
  const all = sheets.flatMap(s => s.rows);
  const cols = Math.max(1, ...all.map(r => r.length));
  const text = all.flat().join('') + sheets.map(s => s.name).join('');

  const doc = await PDFDocument.create();
  const uni = needsUnicode(text);
  const font = uni ? await unicodeFont(doc, 'sans') : await doc.embedFont(StandardFonts.Helvetica);
  const bold = uni ? await unicodeFont(doc, 'bold') : await doc.embedFont(StandardFonts.HelveticaBold);

  /* Landscape past four columns, because a ten-column table on portrait A4 is
     a column of vertical letters. */
  const size = cols > 4 ? {w: 841.89, h: 595.28} : {w: 595.28, h: 841.89};
  const M = 40, SIZE = 8.5, ROW = 15;
  const colW = (size.w - M * 2) / cols;

  let page = doc.addPage([size.w, size.h]);
  let y = size.h - M;
  const feed = (h: number) => {
    if (y < M + h) { page = doc.addPage([size.w, size.h]); y = size.h - M; }
  };

  for (const sheet of sheets) {
    /* Sheets are titled only when there is more than one — a heading over the
       single table of a CSV would be a heading over nothing. */
    if (sheets.length > 1 && sheet.name) {
      feed(ROW * 2);
      page.drawText(clean(sheet.name), {x: M, y: y - 12, size: 12, font: bold,
                                        color: rgb(0.09, 0.11, 0.15)});
      y -= ROW * 1.6;
    }
    sheet.rows.forEach((row, i) => {
      feed(ROW);
      for (let c = 0; c < cols; c++) {
        let cell = clean(row[c] ?? '');
        const f = i === 0 ? bold : font;
        /* Trimmed rather than wrapped: a table where one long cell pushes its
           row three lines tall stops being a table you can scan. */
        while (cell && f.widthOfTextAtSize(cell, SIZE) > colW - 8) cell = cell.slice(0, -1);
        page.drawText(cell, {x: M + c * colW + 3, y: y - SIZE - 3, size: SIZE, font: f,
                             color: rgb(0.09, 0.11, 0.15)});
      }
      page.drawLine({start: {x: M, y: y - ROW}, end: {x: size.w - M, y: y - ROW},
                     thickness: 0.5, color: rgb(0.85, 0.87, 0.9)});
      y -= ROW;
    });
    y -= ROW;
  }
  return new Blob([(await doc.save()).slice() as BlobPart], {type: 'application/pdf'});
}

/* Control bytes only. Everything above Latin-1 is now the Unicode font's job,
   not something to be replaced with a question mark — the whole reason a page
   of Ukrainian used to be refused. */
function clean(text: string): string {
  /* Written as a loop rather than a regular expression because the ranges it
     needs are control characters, and a source file with a literal NUL in it is
     a source file waiting to be corrupted by the next tool that touches it.
     Newlines and tabs survive; other control bytes become spaces, which is what
     stops pdf-lib throwing on a stray one. Nothing above Latin-1 is touched —
     that is what the Unicode face is for. */
  const KEEP = new Set([0x0a, 0x0d, 0x09]);   // newline, carriage return, tab
  let out = '';
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (KEEP.has(c)) { out += ch; continue; }
    out += c < 0x20 || c === 0x7f ? ' ' : ch;
  }
  return out;
}

/* Binary renamed .csv or .txt is still worth refusing: it is not a script
   problem, it is a file that is not text at all, and it produces a page of
   noise rather than a document. */
function guardBinary(text: string): void {
  const control = [...text].filter(c => {
    const n = c.codePointAt(0) ?? 0;
    return n < 0x20 && n !== 0x0a && n !== 0x0d && n !== 0x09;
  }).length;
  if (control > text.length * 0.02) {
    refuse('That file is not text — it contains binary data. Check the extension matches '
      + 'what the file actually is.');
  }
}

/* Quoted fields, doubled quotes inside them, and newlines inside quotes — the
   three things a split on commas gets wrong. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"') { quoted = true; }
    else if (c === ',' || c === ';') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(v => v.trim()));
}

/* ── HEIC ─────────────────────────────────────────────────────────────── */

/* The one format on the list no browser engine but Safari can read. libheif is
   the reference decoder compiled to WebAssembly; it is a megabyte and a half,
   which is why it is behind a dynamic import inside a module that is itself
   only loaded when a page needs it. */
export async function heicToCanvas(bytes: Uint8Array): Promise<HTMLCanvasElement> {
  const mod = await import('libheif-js/wasm-bundle');
  const Ctor = mod.HeifDecoder ?? mod.default?.HeifDecoder;
  if (!Ctor) refuse('The HEIC decoder could not be loaded.');

  let images: HeifImage[] = [];
  try { images = new Ctor().decode(bytes); }
  catch { refuse('That HEIC file could not be decoded. It may be damaged.'); }
  if (!images.length) refuse('That file contains no image the HEIC decoder recognises.');

  const image = images[0]!;
  const w = image.get_width(), h = image.get_height();
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const data = ctx.createImageData(w, h);
  await new Promise<void>((ok, no) => {
    image.display(data, (out: ImageData | null) => out ? ok() : no(new Refused('The HEIC image could not be drawn.')));
  });
  ctx.putImageData(data, 0, 0);
  return canvas;
}

import type {HeifImage} from 'libheif-js/wasm-bundle';

/* ── zip ──────────────────────────────────────────────────────────────── */

/* Written by hand rather than pulled in, because the format is a header, the
   bytes, and a table at the end — and a zip library is a hundred kilobytes to
   avoid ninety lines.
 *
 * Deflated where it helps. JPEG and PNG members are already compressed and
 * gain nothing, but a six-page PDF turned into BMP is thirty-four megabytes of
 * uncompressed pixels, and deflate takes about ninety percent of that off. The
 * browser has the compressor built in, so this costs no dependency either. */
export async function zip(files: Sheet[]): Promise<Blob> {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const f of files) {
    const name = enc.encode(f.name);
    const raw = new Uint8Array(await f.blob.arrayBuffer());
    /* The CRC is always of the original bytes, whatever the member is stored
       as — writing it over the compressed ones produces an archive every
       unzipper reports as corrupt. */
    const crc = crc32(raw);
    const {data, method} = await squeeze(raw, f.blob.type);

    const local = new Uint8Array(30 + name.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);          // version needed
    dv.setUint16(6, 0x0800, true);      // UTF-8 names
    dv.setUint16(8, method, true);      // 0 stored, 8 deflated
    dv.setUint32(14, crc, true);
    dv.setUint32(18, data.length, true);
    dv.setUint32(22, raw.length, true);
    dv.setUint16(26, name.length, true);
    local.set(name, 30);
    parts.push(local, data);

    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    cd.set(name, 46);
    central.push(cd);

    offset += local.length + data.length;
  }

  const size = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, size, true);
  ev.setUint32(16, offset, true);

  return new Blob([...parts, ...central, end].map(u => u.slice() as BlobPart),
                  {type: 'application/zip'});
}

/* Already-compressed members are stored as they are; everything else goes
   through the browser's deflate. If CompressionStream is missing — it is not,
   in anything current, but a polyfilled environment is a real place — the
   member is simply stored and the archive is merely larger. */
const COMPRESSED = /^(image\/(jpeg|png|webp|gif|avif|heic)|application\/(zip|pdf))/;

async function squeeze(
  raw: Uint8Array, type: string,
): Promise<{data: Uint8Array; method: number}> {
  if (COMPRESSED.test(type) || raw.length < 512 || typeof CompressionStream === 'undefined') {
    return {data: raw, method: 0};
  }
  try {
    const stream = new Blob([raw.slice() as BlobPart])
      .stream()
      .pipeThrough(new CompressionStream('deflate-raw'));
    const packed = new Uint8Array(await new Response(stream).arrayBuffer());
    /* Only if it actually helped — deflate can grow already-dense data, and a
       zip member larger than its source is a pointless trade. */
    return packed.length < raw.length ? {data: packed, method: 8} : {data: raw, method: 0};
  } catch {
    return {data: raw, method: 0};
  }
}

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]!) & 255]! ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/* ── spreadsheets ─────────────────────────────────────────────────────── */

/* A workbook laid out as a table, one sheet after another.
 *
 * SheetJS reads every format Excel has ever written; the drawing is the same
 * table renderer the CSV route uses, so a spreadsheet and a comma-separated
 * file come out looking alike — which they should, being the same data. */
export async function excelToPdf(bytes: Uint8Array): Promise<Blob> {
  const XLSX = await import('xlsx');
  const book = (() => {
    try {
      return XLSX.read(bytes, {type: 'array'});
    } catch {
      return refuse('That file could not be read as a spreadsheet. It may be damaged, or it may '
        + 'be password protected — Excel encrypts those, and there is nothing to open without '
        + 'the key.');
    }
  })();
  if (!book.SheetNames.length) refuse('That workbook has no sheets in it.');

  const sheets: Array<{name: string; rows: string[][]}> = [];
  for (const name of book.SheetNames) {
    const ws = book.Sheets[name];
    if (!ws) continue;
    const rows = XLSX.utils.sheet_to_json(ws, {
      header: 1, raw: false, defval: '', blankrows: false,
    }) as string[][];
    if (rows.length) sheets.push({name, rows: rows.map(r => r.map(c => String(c ?? '')))});
  }
  if (!sheets.length) refuse('Every sheet in that workbook is empty.');
  return tablesToPdf(sheets);
}

/* Text out of a PDF, back into a workbook.
 *
 * Honest about what it is: pdf.js gives runs of text with positions, and rows
 * are recovered by grouping runs that share a baseline, columns by the gaps
 * between them. On a document with a real table grid that reproduces the table.
 * On free-flowing prose it produces one long column, because there is no table
 * there to find — a converter that invented one would be worse. */
export async function pdfToSheet(
  bytes: Uint8Array, format: 'xlsx' | 'xls',
): Promise<{blob: Blob; rows: number}> {
  const {task, doc} = await openPdf(bytes);
  const XLSX = await import('xlsx');
  const book = XLSX.utils.book_new();
  let total = 0;

  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const content = await (await doc.getPage(n)).getTextContent();
      const runs: Array<{x: number; y: number; s: string}> = [];
      for (const item of content.items) {
        if (!('str' in item) || !item.str.trim()) continue;
        const [, , , , x, y] = item.transform as number[];
        runs.push({x: x ?? 0, y: y ?? 0, s: item.str});
      }
      /* Two points of slack on the baseline: superscripts and slightly
         mis-set runs belong to the line they read as, not their own. */
      const lines = new Map<number, typeof runs>();
      for (const r of runs) {
        const key = [...lines.keys()].find(k => Math.abs(k - r.y) < 2.5) ?? r.y;
        (lines.get(key) ?? lines.set(key, []).get(key)!).push(r);
      }
      const rows = [...lines.entries()]
        .sort((a, b) => b[0] - a[0])                       // PDF counts up the page
        .map(([, rs]) => rs.sort((a, b) => a.x - b.x).map(r => r.s.trim()).filter(Boolean));

      if (!rows.length) continue;
      total += rows.length;
      XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows),
        `Page ${n}`.slice(0, 31));
    }
  } finally {
    await task.destroy().catch(() => {});
  }

  if (!book.SheetNames.length) {
    refuse('That PDF has no text in it — its pages are images. Pulling a table out of a scan '
      + 'needs optical character recognition, which this does not do.');
  }
  const out = XLSX.write(book, {type: 'array', bookType: format}) as ArrayBuffer;
  return {
    blob: new Blob([out], {type: format === 'xlsx'
      ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      : 'application/vnd.ms-excel'}),
    rows: total,
  };
}

/* ── ebooks ───────────────────────────────────────────────────────────── */

/* An EPUB is a zip of XHTML. The spine says which files make up the book and
   in what order; reading them in that order and stripping the markup gives the
   text, which is what a PDF of a novel is. Layout is deliberately not carried
   across — an EPUB has no fixed layout to carry, which is the whole point of
   the format. */
export async function epubToPdf(bytes: Uint8Array): Promise<Blob> {
  const JSZip = (await import('jszip')).default;
  const zip = await (async () => {
    try { return await JSZip.loadAsync(bytes); }
    catch {
      return refuse('That file could not be opened as an EPUB. An EPUB is a zip archive, and '
        + 'this one does not unpack.');
    }
  })();

  /* container.xml names the package document; the package document names the
     spine. Guessing at filenames instead works until it meets a book packed by
     anything other than the tool you tested with. */
  /* zip.file(name) returns a single entry; zip.file(regexp) returns an array.
     The overload the types pick is the array one unless the argument is known
     to be a string, hence the local. */
  const read = async (name: string): Promise<string | undefined> => {
    const entry = zip.file(name);
    return entry && !Array.isArray(entry) ? entry.async('string') : undefined;
  };

  const container = await read('META-INF/container.xml');
  if (!container) return refuse('That EPUB has no META-INF/container.xml, so it is not a valid book.');
  const opfPath = /full-path="([^"]+)"/.exec(container)?.[1];
  if (!opfPath) return refuse('That EPUB does not say where its package document is.');

  const opf = await read(opfPath);
  if (!opf) return refuse(`That EPUB names ${opfPath} as its package document, but the file is not there.`);
  const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';

  const manifest = new Map<string, string>();
  for (const m of opf.matchAll(/<item\b[^>]*>/g)) {
    const id = /id="([^"]+)"/.exec(m[0])?.[1];
    const href = /href="([^"]+)"/.exec(m[0])?.[1];
    if (id && href) manifest.set(id, base + decodeURIComponent(href));
  }
  const spine = [...opf.matchAll(/<itemref\b[^>]*idref="([^"]+)"/g)]
    .map(m => manifest.get(m[1] ?? '')).filter(Boolean) as string[];
  if (!spine.length) refuse('That EPUB has an empty spine — there is nothing to read.');

  const parts: string[] = [];
  for (const path of spine) {
    const html = await read(path);
    if (html) parts.push(stripHtml(html));
  }
  const text = parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) refuse('That EPUB has no readable text in it.');
  return textToPdf(text);
}

/* Markup out, text in, with the block-level breaks kept — running every
   paragraph of a novel together is not a conversion anybody wants. */
function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/(script|style)\s*>/gi, '')
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article)\s*>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n');
}

/* ── the two raster formats a browser cannot write ────────────────────── */

/* BMP, uncompressed 24-bit, bottom-up — the shape every Windows tool expects.
   Twenty lines here against a dependency, and the format has not changed since
   1990. */
export function canvasToBmp(canvas: HTMLCanvasElement): Blob {
  const {width: w, height: h} = canvas;
  const px = canvas.getContext('2d')!.getImageData(0, 0, w, h).data;
  const rowSize = (w * 3 + 3) & ~3;              // rows are padded to four bytes
  const body = rowSize * h;
  const out = new Uint8Array(54 + body);
  const dv = new DataView(out.buffer);

  out[0] = 0x42; out[1] = 0x4D;                  // "BM"
  dv.setUint32(2, out.length, true);
  dv.setUint32(10, 54, true);                    // where the pixels start
  dv.setUint32(14, 40, true);                    // BITMAPINFOHEADER
  dv.setInt32(18, w, true);
  dv.setInt32(22, h, true);
  dv.setUint16(26, 1, true);                     // planes
  dv.setUint16(28, 24, true);                    // bits per pixel
  dv.setUint32(34, body, true);
  dv.setInt32(38, 2835, true);                   // 72 dpi, in pixels per metre
  dv.setInt32(42, 2835, true);

  for (let y = 0; y < h; y++) {
    /* Bottom-up: BMP stores the last row first. */
    let p = 54 + (h - 1 - y) * rowSize;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = px[i + 3]! / 255;
      out[p++] = Math.round(px[i + 2]! * a + 255 * (1 - a));   // B
      out[p++] = Math.round(px[i + 1]! * a + 255 * (1 - a));   // G
      out[p++] = Math.round(px[i]! * a + 255 * (1 - a));       // R
    }
  }
  return new Blob([out.slice() as BlobPart], {type: 'image/bmp'});
}

/* One TIFF per page, bundled like the other page-per-file formats.
 *
 * TIFF is a multi-page format and it would be nicer to write one file with
 * every page in it — but UTIF encodes a single frame, and handing it an array
 * produces a file that decodes to solid black rather than an error. Writing
 * the IFD chaining by hand to get one file is a lot of format for very little
 * gain over a zip, so the pages are zipped exactly as the JPG and BMP ones
 * are, and the naming is identical. */
export async function pdfToTiff(
  bytes: Uint8Array, base: string, onPage?: (done: number, total: number) => void,
): Promise<Sheet[]> {
  const UTIF = (await import('utif')).default;
  const {task, doc} = await openPdf(bytes);
  const pad = String(doc.numPages).length;
  const out: Sheet[] = [];

  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const canvas = document.createElement('canvas');
      await renderPage(page, canvas, {scale: 2, dpr: 1}).done;
      const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
      const tiff = UTIF.encodeImage(data.data.buffer as ArrayBuffer, canvas.width, canvas.height);
      out.push({
        name: doc.numPages === 1
          ? `${base}.tiff`
          : `${base}-${String(n).padStart(pad, '0')}.tiff`,
        blob: new Blob([new Uint8Array(tiff).slice() as BlobPart], {type: 'image/tiff'}),
      });
      canvas.width = canvas.height = 0;
      onPage?.(n, doc.numPages);
      await new Promise(r => setTimeout(r, 0));
    }
  } finally {
    await task.destroy().catch(() => {});
  }
  if (!out.length) refuse('That PDF has no pages.');
  return out;
}

/* ── PDF to HTML ──────────────────────────────────────────────────────── */

/* Positioned text on a sized page, which is what a PDF actually is. Not a
   rebuilt document: the headings, lists and tables are not recoverable from a
   PDF, and markup that claims otherwise is markup that lies. What this gives is
   a page you can open in a browser, select from and search, with every word
   where the original put it. */
export async function pdfToHtml(bytes: Uint8Array, title: string): Promise<Blob> {
  const {task, doc} = await openPdf(bytes);
  const pages: string[] = [];

  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const vp = page.getViewport({scale: 1});
      const content = await page.getTextContent();
      const spans: string[] = [];
      for (const item of content.items) {
        if (!('str' in item) || !item.str.trim()) continue;
        const [a, , , d, x, y] = item.transform as number[];
        const size = Math.abs(d ?? 10);
        /* The horizontal scale is carried across when it differs from the
           vertical one — PDFs condense type to make it fit, and dropping that
           is what makes converted pages overflow their columns. */
        const squeeze = size > 0 && Math.abs((a ?? size) - size) > 0.5
          ? `;transform:scaleX(${((a ?? size) / size).toFixed(3)})` : '';
        spans.push(`<span style="left:${(x ?? 0).toFixed(1)}px;`
          + `bottom:${(y ?? 0).toFixed(1)}px;font-size:${size.toFixed(1)}px${squeeze}"`
          + `>${esc(item.str)}</span>`);
      }
      pages.push(`<div class="page" style="width:${vp.width.toFixed(0)}px;`
        + `height:${vp.height.toFixed(0)}px">\n${spans.join('\n')}\n</div>`);
    }
  } finally {
    await task.destroy().catch(() => {});
  }

  if (!pages.some(p => p.includes('<span'))) {
    refuse('That PDF has no text in it — its pages are images, so there is nothing to turn '
      + 'into HTML. Try PDF to JPG instead.');
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<style>
  body{margin:0;background:#f1f5f9;font-family:Helvetica,Arial,sans-serif}
  .page{position:relative;margin:24px auto;background:#fff;
        box-shadow:0 1px 3px rgba(0,0,0,.15);overflow:hidden}
  .page span{position:absolute;white-space:pre;transform-origin:left bottom;line-height:1}
</style>
</head>
<body>
${pages.join('\n')}
</body>
</html>
`;
  return new Blob([html], {type: 'text/html;charset=utf-8'});
}

const esc = (s: string) => s
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* Pages as BMP. Same walk as pdfToImages, different encoder — the browser has
   no BMP writer, so ours does it. */
export async function pdfToBmp(
  bytes: Uint8Array, base: string, onPage?: (done: number, total: number) => void,
): Promise<Sheet[]> {
  const {task, doc} = await openPdf(bytes);
  const pad = String(doc.numPages).length;
  const out: Sheet[] = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const canvas = document.createElement('canvas');
      /* .done, not the call. renderPage hands back a task object so the
         viewer can cancel a render that scrolling has already made pointless —
         awaiting the object itself resolves at once, and the page is then read
         off a canvas nothing has drawn on. With alpha:false that canvas is
         opaque black, which is exactly what came out. */
      await renderPage(page, canvas, {scale: 2, dpr: 1}).done;
      out.push({
        name: doc.numPages === 1
          ? `${base}.bmp`
          : `${base}-${String(n).padStart(pad, '0')}.bmp`,
        blob: canvasToBmp(canvas),
      });
      canvas.width = canvas.height = 0;
      onPage?.(n, doc.numPages);
      await new Promise(r => setTimeout(r, 0));
    }
  } finally {
    await task.destroy().catch(() => {});
  }
  return out;
}

/* What a file actually is, when it turned out not to be the one the page was
   expecting. Only the arrivals common enough to earn a sentence — renaming a
   file is how most people first try to convert one, so "that is a PDF" is a
   more useful answer than "that archive does not unpack". */
export function looksLike(bytes: Uint8Array): string | null {
  const head = new TextDecoder('latin1').decode(bytes.slice(0, 8));
  if (head.startsWith('%PDF')) return 'a PDF';
  if (head.startsWith('{\\rtf')) return 'an RTF document';
  if (head.startsWith('%!PS')) return 'a PostScript or EPS file';
  if (head.startsWith('\x89PNG')) return 'a PNG image';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'a JPEG image';
  if (head.startsWith('II*\0') || head.startsWith('MM\0*')) return 'a TIFF image';
  if (head.trimStart().startsWith('<')) return 'a markup file — HTML or XML';
  return null;
}

/* ── the formats that carry their own parser ──────────────────────────────
 *
 * A reader that runs to hundreds of lines lives in its own module and is
 * re-exported here, so the engine stays a single import to everything that
 * calls it and only its inside is divided.
 *
 * Each of these imports Refused from this module while this module re-exports
 * it, which is a cycle. It is harmless: none of them touches Refused until a
 * conversion actually runs, long after every module body has finished. */
export {pptxToPdf} from './formats/pptx.ts';
export {odtToPdf} from './formats/odt.ts';
export {rtfToPdf} from './formats/rtf.ts';
export {htmlToPdf} from './formats/html.ts';
export {pagesToPdf} from './formats/pages.ts';
export {dxfToPdf} from './formats/dxf.ts';
export {svgToDxf} from './formats/svgDxf.ts';
export {pdfToPptx} from './formats/pptxOut.ts';
export {pdfToEpub} from './formats/epubOut.ts';
export {imageToExcel} from './formats/imageExcel.ts';
