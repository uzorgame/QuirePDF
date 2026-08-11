/* A web page onto paper — as a reading of the document, not a rendering of it.
 *
 * Laying out HTML properly is a browser engine's whole job: cascade, floats,
 * flex, columns, fonts fetched from three domains. There is no engine to borrow
 * here and writing a tenth of one would produce pages that are wrong in ways
 * that look deliberate. So the scope is drawn where it can be kept honestly.
 *
 * The markup already says which words are a heading, which are a list item and
 * which are quoted. That is structure the document really carries, and it comes
 * across: sizes, indents, markers, a rule down the side of a quotation. The
 * stylesheet says the rest — colour, column width, where the picture sits — and
 * none of that survives, because none of it can be read out of the file without
 * the engine that interprets it.
 *
 * What comes out is the page's content, in its own order, still readable. What
 * does not come out is listed at the bottom of this file, and is worth reading
 * before anyone is surprised by it.
 *
 * Not routed through textToPdf, which is the usual home for "text on pages":
 * that lays one size in one face, and a document where the heading, the code
 * block and the paragraph are all 11pt Helvetica has thrown away the only thing
 * this conversion has to offer. The wrapping loop below is the same idea with a
 * font and a size per block, plus hanging indents for list markers.
 */
import {PDFDocument, StandardFonts, rgb} from 'pdf-lib';
import type {PDFFont} from 'pdf-lib';
import {Refused} from '../heavy.ts';
import {needsUnicode, unicodeFont} from '../../core/unicodeFont.ts';
import type {Face} from '../../core/unicodeFont.ts';

const refuse = (m: string): never => { throw new Refused(m); };

/* ── what the parser keeps ─────────────────────────────────────────────── */

type Kind = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'p' | 'li' | 'pre' | 'rule';

interface Block {
  kind: Kind;
  text: string;
  /** Steps of indentation: one per enclosing list or blockquote. */
  indent: number;
  /** Inside a blockquote, which is drawn with a rule and lighter ink. */
  quoted: boolean;
  /** The bullet or number of a list item, drawn in the hanging indent. */
  marker?: string;
}

/* Elements whose text is not the document's text. Script and style are code;
   nav is a list of somewhere else to go; noscript and template hold markup that
   was never shown; and an <svg> carries <title> and <text> nodes that read as
   stray words dropped into the middle of a sentence.

   header, footer and aside are deliberately not here, though they look like
   they belong. They mean "furniture" only on a page built like a website. On a
   document — and a document is what somebody converting to PDF has — <header>
   is where the title lives: a CV run through this lost the person's name,
   because their name was an <h1> inside one. Keeping a site's banner costs a
   line of navigation nobody minds; dropping it costs the heading, which is the
   one line they would have noticed. */
const DROP = new Set([
  'script', 'style', 'nav',
  'noscript', 'template', 'head', 'svg', 'math', 'iframe', 'object',
  'audio', 'video', 'canvas', 'map', 'select', 'datalist',
]);

/* Elements that begin and end a line of their own. The list is deliberately
   wider than the ones that get their own styling — a <div> is not a paragraph,
   but running the text of two adjacent divs together is worse than treating it
   as one. */
const BLOCK = new Set([
  'p', 'div', 'section', 'article', 'main', 'figure', 'figcaption',
  'dl', 'dt', 'dd', 'address', 'details', 'summary', 'table', 'thead',
  'tbody', 'tfoot', 'caption', 'fieldset', 'legend', 'form', 'center',
  'hgroup', 'search', 'dialog',
]);

/* Bullets by depth. All three are in WinAnsi, so an English page with a list
   still draws in a standard font and carries no embedded face — a nicer bullet
   from higher up in Unicode would cost every bulleted document a 739 kB font
   download for one glyph. */
const BULLETS = ['•', '–', '·'];

interface ListLevel {ordered: boolean; n: number}

function parse(html: string): {blocks: Block[]; title: string} {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const root = doc.body ?? doc.documentElement;
  if (!root) refuse('That file could not be parsed as HTML.');

  const blocks: Block[] = [];
  const lists: ListLevel[] = [];
  let buf = '';
  let kind: Kind = 'p';
  let indent = 0;
  let quoted = false;
  let marker: string | undefined;

  const flush = () => {
    const text = collapse(buf);
    if (text) blocks.push({kind, text, indent, quoted, marker});
    buf = '';
    kind = 'p';
    marker = undefined;
  };

  const walk = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) { buf += clean(child.nodeValue ?? ''); continue; }
      if (child.nodeType !== 1) continue;
      const el = child as Element;
      const name = el.localName;
      if (DROP.has(name)) continue;

      switch (name) {
        case 'br':
          buf += '\n';
          break;

        case 'hr':
          flush();
          blocks.push({kind: 'rule', text: '', indent, quoted});
          break;

        /* Whitespace is the content here, so this branch never goes near the
           collapsing the rest of the document gets. */
        case 'pre': {
          flush();
          const text = preText(el).replace(/^\n/, '').replace(/\s+$/, '');
          if (text) blocks.push({kind: 'pre', text, indent, quoted});
          break;
        }

        case 'h1': case 'h2': case 'h3':
        case 'h4': case 'h5': case 'h6':
          flush();
          kind = name;
          walk(el);
          flush();
          break;

        case 'ul': case 'ol': {
          flush();
          /* `start` is how a numbered list continues after an interruption, and
             dropping it renumbers the document's own references to itself. */
          const from = Number(el.getAttribute('start'));
          lists.push({ordered: name === 'ol', n: Number.isFinite(from) && from ? from : 1});
          indent++;
          walk(el);
          indent--;
          lists.pop();
          break;
        }

        case 'li': {
          flush();
          const list = lists[lists.length - 1];
          const value = Number(el.getAttribute('value'));
          if (list && Number.isFinite(value) && value) list.n = value;
          kind = 'li';
          marker = list?.ordered
            ? `${list.n++}.`
            : BULLETS[Math.max(0, lists.length - 1) % BULLETS.length];
          walk(el);
          flush();
          break;
        }

        case 'blockquote': {
          flush();
          const was = quoted;
          quoted = true;
          indent++;
          walk(el);
          indent--;
          quoted = was;
          flush();
          break;
        }

        /* A table is not reproduced as a table — see the limits at the foot of
           the file — but its text is the page's text and dropping it would lose
           real content. One row to a line, cells separated visibly, so it is at
           least clear where one cell ended. */
        case 'tr':
          flush();
          walk(el);
          flush();
          break;

        case 'td': case 'th':
          if (buf.trim()) buf += ' · ';
          walk(el);
          break;

        default:
          if (BLOCK.has(name)) { flush(); walk(el); flush(); }
          else walk(el);            // span, a, em, strong, code, label, …
      }
    }
  };

  walk(root);
  flush();

  return {blocks, title: (doc.querySelector('title')?.textContent ?? '').trim()};
}

/* The text of a <pre> exactly as written, minus the elements that are never
   text. <br> is a line break even in here, because a page that hand-wrote one
   meant it. */
function preText(el: Element): string {
  let out = '';
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === 3) out += clean(child.nodeValue ?? '');
    else if (child.nodeType === 1) {
      const kid = child as Element;
      if (DROP.has(kid.localName)) continue;
      out += kid.localName === 'br' ? '\n' : preText(kid);
    }
  }
  return out;
}

/* HTML's own whitespace rule: any run of spaces, tabs and newlines in the
   source is one space on screen. The exception is the newline this parser puts
   in for <br>, which is a break the author asked for rather than an accident of
   how the file was indented — so horizontal space collapses around it and it
   stays. */
const collapse = (s: string) => s
  .replace(/[^\S\n]*\n[^\S\n]*/g, '\n')
  .replace(/[^\S\n]+/g, ' ')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

/* Control bytes become spaces or pdf-lib throws on save and takes the whole
   conversion with it. Nothing above Latin-1 is touched — that is what the
   Unicode face is for. */
function clean(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (c === 0x0a || c === 0x09) { out += ch; continue; }
    /* A non-breaking space survives HTML's collapsing, but there is no reflow
       on a finished page for it to prevent, and it is one more glyph a face can
       be missing. It has done its job by the time the text is here. */
    if (c === 0xa0) { out += ' '; continue; }
    out += c < 0x20 || c === 0x7f || (c >= 0x80 && c <= 0x9f) ? ' ' : ch;
  }
  return out;
}

/* ── the page ──────────────────────────────────────────────────────────── */

const A4 = {w: 595.28, h: 841.89};
const M = 56;                       // the margin the plain-text route uses
const STEP = 18;                    // one level of list or quote indent
/* Past a handful of levels the indent stops being structure and starts being a
   margin. Generated markup nests lists dozens deep, and honouring all of it
   walks the text off the right-hand edge of the paper — where it is not so much
   badly laid out as gone. */
const MAX_INDENT = 6;
const BODY = 11;

const INK = rgb(0.09, 0.11, 0.15);
const MUTED = rgb(0.28, 0.32, 0.38);
const HAIRLINE = rgb(0.82, 0.85, 0.89);

interface Style {size: number; face: Face; lead: number; above: number; below: number}

/* Sizes rather than a stylesheet: the point is that a reader can see the shape
   of the document at arm's length, not that it matches the site it came from. */
const STYLE: Record<Kind, Style> = {
  h1:   {size: 21,   face: 'bold', lead: 1.25, above: 20, below: 8},
  h2:   {size: 16.5, face: 'bold', lead: 1.28, above: 17, below: 6},
  h3:   {size: 13.5, face: 'bold', lead: 1.30, above: 14, below: 5},
  h4:   {size: 12,   face: 'bold', lead: 1.35, above: 12, below: 4},
  h5:   {size: 11,   face: 'bold', lead: 1.40, above: 11, below: 3},
  h6:   {size: 10,   face: 'bold', lead: 1.40, above: 10, below: 3},
  p:    {size: BODY, face: 'sans', lead: 1.45, above: 0,  below: 7},
  li:   {size: BODY, face: 'sans', lead: 1.45, above: 0,  below: 3},
  pre:  {size: 9,    face: 'mono', lead: 1.35, above: 8,  below: 10},
  rule: {size: 0,    face: 'sans', lead: 0,    above: 12, below: 12},
};

const STANDARD: Record<Face, StandardFonts> = {
  sans: StandardFonts.Helvetica,
  bold: StandardFonts.HelveticaBold,
  italic: StandardFonts.HelveticaOblique,
  bolditalic: StandardFonts.HelveticaBoldOblique,
  serif: StandardFonts.TimesRoman,
  serifbold: StandardFonts.TimesRomanBold,
  serifitalic: StandardFonts.TimesRomanItalic,
  serifbolditalic: StandardFonts.TimesRomanBoldItalic,
  mono: StandardFonts.Courier,
};


/**
 * Turns an HTML file into a PDF of its readable content.
 *
 * Takes the raw bytes where they are available, so the file's own declared
 * encoding can be honoured; a string is accepted for callers that have already
 * decoded one.
 */
export async function htmlToPdf(source: Uint8Array | string): Promise<Blob> {
  const html = typeof source === 'string' ? source : decode(source);
  guardBinary(html);

  const {blocks, title} = parse(html);
  if (!blocks.some(b => b.text)) {
    refuse('That page has no readable text in it. Everything in it was script, style, '
      + 'navigation or images, and none of those become words on a page.');
  }

  const doc = await PDFDocument.create();
  if (title) doc.setTitle(title);

  /* One decision for the whole document, taken before anything is drawn: the
     moment a single word needs a glyph the standard fourteen faces do not have,
     every face in the file becomes the embedded one. Mixing them would put a
     Cyrillic heading in DejaVu above a Latin paragraph in Helvetica, which
     reads as two documents stapled together. Markers are left out of the
     question deliberately — the bullet is in WinAnsi either way. */
  const uni = needsUnicode(blocks.map(b => b.text).join('\n') + title);
  const fonts = new Map<Face, Promise<PDFFont>>();
  const faceOf = (face: Face): Promise<PDFFont> => {
    let pending = fonts.get(face);
    if (!pending) {
      pending = uni ? unicodeFont(doc, face) : doc.embedFont(STANDARD[face]);
      fonts.set(face, pending);
    }
    return pending;
  };

  let page = doc.addPage([A4.w, A4.h]);
  let y = A4.h - M;
  const feed = () => { page = doc.addPage([A4.w, A4.h]); y = A4.h - M; };

  for (const block of blocks) {
    const style = STYLE[block.kind];
    const left = M + Math.min(block.indent, MAX_INDENT) * STEP;

    if (block.kind === 'rule') {
      y -= style.above;
      if (y < M) feed();
      page.drawLine({start: {x: left, y}, end: {x: A4.w - M, y},
                     thickness: 0.7, color: HAIRLINE});
      y -= style.below;
      continue;
    }

    const font = await faceOf(style.face);
    /* Hanging indent: the marker sits in the margin of the item and every line
       of the item lines up past it, which is what makes a wrapped list item
       still look like one item. */
    const hang = block.marker
      ? Math.max(16, font.widthOfTextAtSize(block.marker, style.size) + 7)
      : 0;
    const width = A4.w - M - left - hang;
    const lines = wrap(prepare(block), font, style.size, width);
    const step = style.size * style.lead;

    y -= style.above;
    /* A heading stranded alone at the foot of a page is a heading in the wrong
       place, so it takes its first line of text with it. */
    if (y - step - (/^h[1-6]$/.test(block.kind) ? BODY * 1.45 : 0) < M) feed();

    lines.forEach((line, i) => {
      if (y - step < M) feed();
      const base = y - style.size;
      if (block.quoted) {
        /* Drawn a line at a time rather than once for the whole block: the
           segments abut and read as one rule, and a quotation that runs over a
           page break gets its rule on both pages without any bookkeeping. */
        page.drawLine({start: {x: left - 10, y: base - step * 0.3},
                       end: {x: left - 10, y: base + style.size * 0.9},
                       thickness: 2, color: HAIRLINE});
      }
      if (i === 0 && block.marker) {
        page.drawText(block.marker, {x: left, y: base, size: style.size, font, color: INK});
      }
      if (line) {
        page.drawText(line, {x: left + hang, y: base, size: style.size, font,
                             color: block.quoted ? MUTED : INK});
      }
      y -= step;
    });
    y -= style.below;
  }

  return new Blob([(await doc.save()).slice() as BlobPart], {type: 'application/pdf'});
}

/* A tab has no meaning in a PDF — there are no tab stops, and drawing one is
   either nothing or a missing-glyph box — so indentation that arrived as tabs
   is spelled out in spaces while it still can be. Four, not eight, because
   deeply nested code at eight is off the right edge of A4 before it starts. */
const prepare = (block: Block) =>
  block.kind === 'pre' ? block.text.replace(/\t/g, '    ') : block.text;

/* Wrapped by measuring the font rather than by counting characters, so a line
   of capitals does not overrun where a line of lowercase fits. */
function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    if (!para) { out.push(''); continue; }
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      const next = line + word;
      /* line.trim() rather than line: a run of leading spaces is the
         indentation of a code line, and breaking before the first word of it
         would throw that indentation away. */
      if (font.widthOfTextAtSize(next, size) > width && line.trim()) {
        out.push(line.replace(/\s+$/, ''));
        line = word.replace(/^\s+/, '');
      } else {
        line = next;
      }
    }
    out.push(line);
  }
  return out.flatMap(line => split(line, font, size, width));
}

/* One word wider than the column is a real thing in HTML — a URL, a hash, a
   long line of code — and it is the one case word wrapping cannot help with.
   Broken by character, because the alternative is text that runs off the edge
   of the paper and is simply not there. */
function split(line: string, font: PDFFont, size: number, width: number): string[] {
  if (!line || font.widthOfTextAtSize(line, size) <= width) return [line];
  const out: string[] = [];
  let cur = '';
  for (const ch of line) {
    if (cur && font.widthOfTextAtSize(cur + ch, size) > width) { out.push(cur); cur = ''; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/* ── getting to the text in the first place ────────────────────────────── */

/* A saved web page is not necessarily UTF-8, and it is not necessarily honest
   about it either. The order here is the order a browser uses: a byte order
   mark outranks everything, then the file's own declaration, then a guess. */
function decode(bytes: Uint8Array): string {
  const b0 = bytes[0], b1 = bytes[1], b2 = bytes[2];
  if (b0 === 0xef && b1 === 0xbb && b2 === 0xbf) return utf8(bytes.subarray(3));
  if (b0 === 0xff && b1 === 0xfe) return label(bytes.subarray(2), 'utf-16le');
  if (b0 === 0xfe && b1 === 0xff) return label(bytes.subarray(2), 'utf-16be');

  /* The declaration is looked for in the first 2 kB read as Latin-1 — enough to
     clear <head>, and Latin-1 never fails on bytes that turn out to be
     something else, which a UTF-8 read of a Windows-1252 file would. */
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 2048));
  const declared = /<meta[^>]+?charset\s*=\s*["']?\s*([\w:.-]+)/i.exec(head)?.[1];
  if (declared && !/^utf-?8$/i.test(declared)) {
    try {
      return label(bytes, declared);
    } catch {
      /* An encoding the browser has never heard of is not worth refusing the
         file over; UTF-8 with replacement characters is still readable. */
    }
  }

  /* Undeclared and not valid UTF-8 means a legacy page, and Windows-1252 is
     what every browser falls back to for one — a fallback that turns curly
     quotes and dashes into the characters they were, instead of a line of
     replacement diamonds. */
  try {
    return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  } catch {
    try { return label(bytes, 'windows-1252'); } catch { return utf8(bytes); }
  }
}

const utf8 = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const label = (bytes: Uint8Array, name: string) => new TextDecoder(name).decode(bytes);

/* Something renamed .html that is not text at all produces a page of noise
   rather than a document, and it is worth saying so instead. */
function guardBinary(text: string): void {
  const sample = text.slice(0, 4096);
  let control = 0;
  for (const ch of sample) {
    const c = ch.codePointAt(0) ?? 0;
    if ((c < 0x20 && c !== 0x0a && c !== 0x0d && c !== 0x09) || c === 0xfffd) control++;
  }
  if (control > sample.length * 0.05) {
    refuse('That file is not HTML — it contains binary data. Check the extension matches '
      + 'what the file actually is.');
  }
}

/* ── what this does not do ─────────────────────────────────────────────────
 *
 * No CSS is applied. Nothing the stylesheet said about type, colour, spacing,
 * floats, flexbox, grid or multiple columns is read at all, so a page's own
 * design does not survive; what survives is the order the content is written in
 * the file, which is not always the order it appeared on screen.
 *
 * No images. Photographs, diagrams, icons and background art are dropped, and
 * so is alt text — inventing a line of prose where a picture was would read as
 * part of the document.
 *
 * No bold or italic inside a paragraph. Emphasis is drawn as ordinary text; the
 * faces change per block, not per word.
 *
 * No links. The words of a link are kept, its address is not.
 *
 * Tables lose their grid. Each row becomes one line with the cells separated by
 * a middle dot, so the content is all there and the columns are not.
 *
 * Nothing that needed to run. Content a page assembles with JavaScript after it
 * loads is not in the file, and there is no engine here to run it — a saved
 * page from a single-page app is often close to empty for that reason.
 */
