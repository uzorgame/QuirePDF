/* OpenDocument text in, pages out.
 *
 * An .odt is a zip whose content.xml is the document. Two things about it
 * decide whether a conversion is any good.
 *
 * The first is where the words are. A .docx wraps every run of text in a <w:t>
 * element, so the Word route can walk elements alone and find everything. ODF
 * does not: the text of a paragraph is an ordinary XML text node, sitting
 * directly inside <text:p> beside whatever <text:span> elements happen to be
 * there. Walk only the elements here and the document comes out empty.
 *
 * The second is spacing. ODF treats the whitespace in the file as
 * insignificant — a producer may indent content.xml however it likes — and
 * stores the whitespace that matters as markup instead: <text:s> for a run of
 * spaces, <text:tab> for a tab, <text:line-break> for a break. So a converter
 * that strips tags keeps exactly the whitespace that means nothing and loses
 * exactly the whitespace that means something. Both are handled below, and a
 * tab is drawn against a real tab stop rather than padded out with spaces.
 *
 * What is deliberately not attempted is the page design. ODF keeps it in
 * styles.xml as named styles with their own inheritance, page masters and
 * measurement units; resolving that is a typesetting engine and not a
 * converter, and one that guessed would produce a document that looks
 * deliberate and is wrong. So this reflows onto A4 and keeps the structure the
 * file states outright: heading levels, list markers, table rows, footnotes.
 */
import {PDFDocument, StandardFonts, rgb} from 'pdf-lib';
import type {PDFFont} from 'pdf-lib';
import {Refused, looksLike} from '../heavy.ts';
import {needsUnicode, unicodeFont} from '../../core/unicodeFont.ts';

const refuse = (m: string): never => { throw new Refused(m); };

/* ── the XML ──────────────────────────────────────────────────────────── */

/* Read with a hand-written scan rather than DOMParser, which is a window-only
 * API: a module that reaches for it cannot run in a worker and cannot be
 * checked against real files outside a browser. What is needed from a parser
 * here is elements, attributes, text, and the order the two arrived in.
 *
 * It is a scan and not a pattern over tags, because a `>` inside an attribute
 * value is legal XML and an expression that stops at the first one silently
 * loses the rest of the paragraph. */
interface XEl {name: string; attrs: Record<string, string>; kids: Array<XEl | string>}

const ENTITY: Record<string, string> = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'"};

function decode(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (all: string, body: string) => {
    if (body[0] === '#') {
      const n = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : Number(body.slice(1));
      /* A reference outside Unicode is dropped rather than thrown on: one bad
         escape in a footer should not cost the whole document. */
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    }
    return ENTITY[body] ?? all;
  });
}

/* Where the current tag ends, counting quotes so an angle bracket inside an
   attribute value does not end it early. */
function tagEnd(src: string, from: number): number {
  let quote = '';
  for (let i = from; i < src.length; i++) {
    const c = src[i]!;
    if (quote) { if (c === quote) quote = ''; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return i;
  }
  return -1;
}

function attrsOf(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of src.matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const key = m[1];
    const val = m[2] ?? m[3];
    if (key && val !== undefined) out[key] = decode(val);
  }
  return out;
}

function parseXml(src: string): XEl {
  const root: XEl = {name: '#doc', attrs: {}, kids: []};
  const stack: XEl[] = [root];
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    if (lt > i) stack[stack.length - 1]!.kids.push(decode(src.slice(i, lt)));

    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt);
      i = end < 0 ? src.length : end + 3;
    } else if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt);
      stack[stack.length - 1]!.kids.push(src.slice(lt + 9, end < 0 ? src.length : end));
      i = end < 0 ? src.length : end + 3;
    } else if (src.startsWith('<?', lt) || src.startsWith('<!', lt)) {
      const end = tagEnd(src, lt + 1);
      i = end < 0 ? src.length : end + 1;
    } else {
      const end = tagEnd(src, lt + 1);
      if (end < 0) break;
      const inner = src.slice(lt + 1, end);
      i = end + 1;
      if (inner[0] === '/') {
        /* Unwound to the matching element rather than popped blindly, so one
           unbalanced tag costs the element it is in and not everything after. */
        const name = inner.slice(1).trim();
        for (let d = stack.length - 1; d > 0; d--) {
          if (stack[d]!.name === name) { stack.length = d; break; }
        }
      } else {
        const empty = inner.endsWith('/');
        const body = empty ? inner.slice(0, -1) : inner;
        const name = /^[^\s/>]+/.exec(body)?.[0] ?? '';
        const el: XEl = {name, attrs: attrsOf(body.slice(name.length)), kids: []};
        stack[stack.length - 1]!.kids.push(el);
        if (!empty) stack.push(el);
      }
    }
  }
  return root;
}

/* Prefixes in an ODF file are conventional, not fixed — text:, office:, table:
   and style: are what every producer writes, but a conforming document may
   declare its own. Matching on the part after the colon is prefix-blind, and
   the local names ODF uses across those four namespaces do not collide. */
const local = (name: string) => name.slice(name.indexOf(':') + 1);
const els = (el: XEl): XEl[] => el.kids.filter((k): k is XEl => typeof k !== 'string');
const attr = (el: XEl, name: string): string => {
  for (const [k, v] of Object.entries(el.attrs)) if (local(k) === name) return v;
  return '';
};
function descendant(el: XEl, name: string): XEl | undefined {
  for (const k of els(el)) {
    if (local(k.name) === name) return k;
    const hit = descendant(k, name);
    if (hit) return hit;
  }
  return undefined;
}

/* ── list markers ─────────────────────────────────────────────────────── */

interface Level {bullet: string; format: string; prefix: string; suffix: string; start: number}

/* The bullet or the number is not on the list item — ODF keeps it in a
   <text:list-style>, one entry per nesting level, which the list points at by
   name. So the marker drawn below is the one the document itself declares
   rather than a bullet invented for every list alike, and a document whose
   style cannot be found gets no marker instead of a wrong one. */
function listStyles(roots: XEl[]): Map<string, Map<number, Level>> {
  const out = new Map<string, Map<number, Level>>();
  const visit = (el: XEl): void => {
    if (local(el.name) === 'list-style') {
      const name = attr(el, 'name');
      if (name) {
        const levels = new Map<number, Level>();
        for (const lv of els(el)) {
          const kind = local(lv.name);
          const n = Number(attr(lv, 'level')) || 1;
          if (kind === 'list-level-style-bullet') {
            levels.set(n, {bullet: bulletChar(attr(lv, 'bullet-char')), format: '',
                           prefix: '', suffix: '', start: 1});
          } else if (kind === 'list-level-style-number') {
            levels.set(n, {bullet: '', format: attr(lv, 'num-format') || '1',
                           prefix: attr(lv, 'num-prefix'), suffix: attr(lv, 'num-suffix'),
                           start: Number(attr(lv, 'start-value')) || 1});
          } else if (kind === 'list-level-style-image') {
            /* A picture bullet is a stored image at a stated size. Drawing it is
               possible and pointless — it is three pixels of decoration — so a
               plain bullet stands in, which is what the level means. */
            levels.set(n, {bullet: '•', format: '', prefix: '', suffix: '', start: 1});
          }
        }
        out.set(name, levels);
      }
      return;
    }
    for (const k of els(el)) visit(k);
  };
  for (const root of roots) visit(root);
  return out;
}

/* Word and its converters write bullets as private-use codepoints out of
   Wingdings, which no embedded font here has a glyph for — the character would
   come out as a blank or a box. */
function bulletChar(ch: string): string {
  const c = ch.codePointAt(0);
  if (!c || (c >= 0xe000 && c <= 0xf8ff)) return '•';
  return String.fromCodePoint(c);
}

function counter(n: number, format: string): string {
  if (format === 'a' || format === 'A') {
    let s = '', v = Math.max(1, n);
    while (v > 0) { s = String.fromCharCode(97 + (v - 1) % 26) + s; v = Math.floor((v - 1) / 26); }
    return format === 'A' ? s.toUpperCase() : s;
  }
  if (format === 'i' || format === 'I') {
    const parts: Array<[number, string]> = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'],
      [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'],
      [1, 'i']];
    let s = '', v = Math.max(1, n);
    for (const [value, sign] of parts) while (v >= value) { s += sign; v -= value; }
    return format === 'I' ? s.toUpperCase() : s;
  }
  return String(n);
}

const markerFor = (level: Level | undefined, n: number): string =>
  !level ? ''
    : level.bullet ? level.bullet
    : level.format ? level.prefix + counter(n, level.format) + level.suffix
    : '';

/* ── reading the body ─────────────────────────────────────────────────── */

interface Line {
  text: string;
  /* 0 is body text; 1 and up is the outline level of a heading. */
  level: number;
  /* Nesting, in list steps rather than points, so the drawing decides the size
     of a step in one place. */
  depth: number;
  marker: string;
  /* Set on everything inside a list item or a footnote, marker or no marker, so
     that the second paragraph of an item starts under the first one's text
     rather than under its bullet. */
  hang: boolean;
  /* Which table this row belongs to, 0 for anything that is not one. Rows of
     one table have to be measured together to know where its columns go, and
     the measuring cannot happen until the font is chosen. */
  group: number;
}

/* Content that is in content.xml but is not the document.
 *
 * The deleted halves of tracked changes live in <text:tracked-changes> and
 * would otherwise come back from the dead in the PDF. A comment is somebody's
 * note to a colleague, and a converter that quietly printed those into a file
 * about to be sent out would be the worst kind of surprise. */
const SKIP = new Set(['tracked-changes', 'deletion',
                      'annotation', 'annotation-end', 'binary-data',
                      'event-listeners', 'forms', 'sequence-decls', 'variable-decls',
                      'user-field-decls', 'change', 'change-start', 'change-end']);

/* A space that came from <text:s> rather than from the file's own layout. XML
   1.0 cannot carry a literal 0x01, so nothing in a well-formed content.xml can
   collide with it — which is what makes it safe to use as a mark that survives
   the whitespace collapsing below and is turned back into a space after. */
const HARD = String.fromCharCode(1);

function readBody(body: XEl, styles: Map<string, Map<number, Level>>): Line[] {
  const out: Line[] = [];
  /* The marker the next paragraph will consume. A list item's bullet belongs to
     its first paragraph, not to all of them, and this is what makes the second
     paragraph of an item line up under the first instead of repeating it. */
  let pending = '';

  let tables = 0;

  /* The inline content of one paragraph. Deferred blocks are the things that
     are legal inside a paragraph but are not part of its sentence — a frame, a
     table, the body of a footnote — and are emitted after it rather than
     spliced into the middle of the text. */
  const inline = (el: XEl, after: Array<{el: XEl; mark: string; note: boolean}>): string => {
    let s = '';
    const walk = (node: XEl): void => {
      for (const kid of node.kids) {
        if (typeof kid === 'string') {
          /* Collapsed, because ODF says the whitespace in the file is not the
             document's. A pretty-printed content.xml would otherwise put the
             indentation of its own source into the middle of every sentence. */
          s += kid.replace(/[\t\r\n ]+/g, ' ');
          continue;
        }
        const n = local(kid.name);
        if (SKIP.has(n)) continue;
        if (n === 's') { s += HARD.repeat(Math.max(1, Number(attr(kid, 'c')) || 1)); continue; }
        if (n === 'tab') { s += '\t'; continue; }
        if (n === 'line-break') { s += '\n'; continue; }
        if (n === 'note') {
          /* The citation mark stays in the sentence where it was; the note
             itself follows the paragraph, carrying that same mark. Running the
             note's text inline instead would splice a sentence into the middle
             of another one. */
          const cite = descendant(kid, 'note-citation');
          const mark = cite ? inline(cite, after).trim() : '';
          s += mark;
          const note = descendant(kid, 'note-body');
          if (note) after.push({el: note, mark, note: true});
          continue;
        }
        if (n === 'p' || n === 'h' || n === 'list' || n === 'table' || n === 'frame') {
          /* A frame is deferred whole rather than walked into. Its text box is
             worth keeping and comes back as paragraphs of its own; the <svg:desc>
             and <svg:title> beside it are the alternative text of a picture, and
             walking in would splice those into the middle of the sentence the
             picture was anchored to. */
          after.push({el: kid, mark: '', note: false});
          continue;
        }
        walk(kid);
      }
    };
    walk(el);
    /* Leading and trailing whitespace of a paragraph is the file's, not the
       document's — real indentation arrives as <text:s> and is marked. */
    return s.replace(/^ +/, '').replace(/ +$/, '').replaceAll(HARD, ' ');
  };

  const paragraph = (el: XEl, depth: number, hang: boolean): void => {
    const level = local(el.name) === 'h'
      ? Math.min(10, Math.max(1, Number(attr(el, 'outline-level')) || 1))
      : 0;
    const after: Array<{el: XEl; mark: string; note: boolean}> = [];
    const text = inline(el, after);
    const marker = pending;
    pending = '';
    out.push({text, level, depth, marker, hang, group: 0});
    for (const item of after) {
      pending = item.mark;
      node(item.el, depth + 1, '', item.note || hang);
      pending = '';
    }
  };

  /* A row reads as a row. Read cell by cell into separate paragraphs a table
     becomes a vertical list of fragments that nobody can follow, so the cells
     of one row are joined with tabs and given a column of their own to land in.
     The widths are not the document's — those live in the table's column styles
     in a unit this does not resolve — they are measured from the text, so a
     wide cell wraps inside its column rather than shunting the row sideways. */
  const table = (el: XEl, depth: number, hang: boolean): void => {
    const group = ++tables;
    const rows: XEl[] = [];
    const find = (e: XEl): void => {
      for (const k of els(e)) {
        if (local(k.name) === 'table-cell') continue;
        if (local(k.name) === 'table-row') rows.push(k);
        else find(k);
      }
    };
    find(el);
    for (const row of rows) {
      const cells = els(row)
        .filter(c => local(c.name) === 'table-cell' || local(c.name) === 'covered-table-cell')
        .map(cell => {
          const parts: string[] = [];
          const gather = (e: XEl): void => {
            for (const k of els(e)) {
              const n = local(k.name);
              if (SKIP.has(n)) continue;
              if (n === 'p' || n === 'h') parts.push(inline(k, []));
              else gather(k);
            }
          };
          gather(cell);
          /* A tab or a break inside a cell would move the rest of the row to
             the wrong column, so within a cell they become spaces. */
          return parts.join(' ').replace(/[\t\n]+/g, ' ').trim();
        });
      if (cells.some(c => c)) {
        out.push({text: cells.join('\t'), level: 0, depth, marker: '', hang, group});
      }
    }
  };

  const list = (el: XEl, depth: number, inherited: string, level: number): void => {
    /* A nested list usually names no style of its own and continues the one it
       is inside, which is where its deeper levels are defined. */
    const style = attr(el, 'style-name') || inherited;
    const spec = styles.get(style)?.get(level);
    let count = spec?.start ?? 1;
    for (const item of els(el)) {
      const kind = local(item.name);
      if (kind !== 'list-item' && kind !== 'list-header') {
        node(item, depth, style, false);
        continue;
      }
      const start = Number(attr(item, 'start-value'));
      if (start) count = start;
      /* A list header is the unnumbered lead-in paragraph of a list, so it
         takes no marker and does not advance the count. */
      pending = kind === 'list-item' ? markerFor(spec, count) : '';
      /* The step of indentation goes on the item's content rather than on the
         list, so that a list and the paragraph inside it do not each add one. */
      for (const kid of els(item)) {
        if (local(kid.name) === 'list') list(kid, depth + 1, style, level + 1);
        else node(kid, depth + 1, style, true);
      }
      pending = '';
      if (kind === 'list-item') count++;
    }
  };

  function node(el: XEl, depth: number, style: string, hang: boolean): void {
    const n = local(el.name);
    if (SKIP.has(n)) return;
    if (n === 'p' || n === 'h') paragraph(el, depth, hang);
    else if (n === 'list') list(el, depth, style, 1);
    else if (n === 'table') table(el, depth, hang);
    else for (const kid of els(el)) node(kid, depth, style, hang);
  }

  for (const kid of els(body)) node(kid, 0, '', false);
  return out;
}

/* ── drawing ──────────────────────────────────────────────────────────── */

const A4 = {w: 595.28, h: 841.89};
const M = 56;
const BODY = 11;
/* Headings are set in bold and stepped down in size by outline level. Past the
   sixth the size stops changing — a document nested that deep has run out of
   ways to look different, and shrinking further would put a heading below its
   own body text. */
const HEAD = [19, 16, 13.5, 12, 11.5, 11];
/* 1.25 cm, which is LibreOffice's default tab stop. The document's own stops
   are in its paragraph styles, and those are not resolved here. */
const TAB = 35.43;
const STEP = 18;
const INK = rgb(0.09, 0.11, 0.15);

/* Text with tabs in it, measured and drawn by the same walk so that what was
   measured for the wrap is what lands on the page. Returns the width used.
 *
 * `stops` is where the columns of a table start, offsets from the beginning of
 * the line; past the end of it, and for the tabs somebody typed into ordinary
 * prose, tabs fall back to the regular stop. A column that has already been
 * overrun advances to the next one rather than backing up, which is what keeps
 * an over-wide cell from writing on top of its neighbour. */
function run(
  text: string, font: PDFFont, size: number, x0: number,
  stops: number[] | undefined, put?: (s: string, x: number) => void,
): number {
  const parts = text.split('\t');
  let x = x0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (part) { put?.(part, x); x += font.widthOfTextAtSize(part, size); }
    if (i === parts.length - 1) break;
    const stop = stops?.[i];
    x = x0 + (stop !== undefined
      ? Math.max(stop, x - x0 + 6)
      : (Math.floor((x - x0) / TAB) + 1) * TAB);
  }
  return x - x0;
}

function wrap(
  text: string, font: PDFFont, size: number, width: number, stops?: number[],
): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    const push = () => {
      /* A single token wider than the column — a long URL, a file path — is cut
         rather than drawn off the edge of the page, which is the one failure a
         reader cannot see has happened. */
      let rest = line.replace(/[ \t]+$/, '');
      while (run(rest, font, size, 0, stops) > width && rest.length > 1) {
        let cut = rest.length;
        while (cut > 1 && run(rest.slice(0, cut), font, size, 0, stops) > width) cut--;
        out.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      out.push(rest);
    };
    for (const word of para.split(/([ \t]+)/)) {
      const next = line + word;
      if (run(next, font, size, 0, stops) > width && line.trim()) {
        push();
        line = word.replace(/^ +/, '');
      } else {
        line = next;
      }
    }
    push();
  }
  return out;
}

/* Where each table's columns begin, measured from the widest thing in them.
 *
 * A table has to be measured whole before any of it is drawn, or the second row
 * lands in different columns from the first — which is the difference between a
 * table and a heap of words. Columns that together want more room than the page
 * has are scaled to fit rather than dropped, and the text inside them wraps. */
function columns(lines: Line[], font: PDFFont): Map<number, number[]> {
  const tables = new Map<number, Line[]>();
  for (const line of lines) {
    if (!line.group) continue;
    const rows = tables.get(line.group);
    if (rows) rows.push(line); else tables.set(line.group, [line]);
  }

  const out = new Map<number, number[]>();
  for (const [group, lot] of tables) {
    const rows = lot.map(l => l.text.split('\t'));
    /* Reduced rather than spread into Math.max: a spreadsheet pasted into a
       document is a table of thousands of rows, and that many arguments
       overflows the call stack. */
    const widths: number[] = [];
    for (const row of rows) {
      row.forEach((cell, c) => {
        const w = font.widthOfTextAtSize(clean(cell), BODY) + 14;
        if (w > (widths[c] ?? 0)) widths[c] = w;
      });
    }
    const room = A4.w - M * 2 - Math.min(lot[0]!.depth, 8) * STEP;
    const total = widths.reduce((a, b) => a + b, 0);
    const squeeze = total > room ? room / total : 1;
    let at = 0;
    out.set(group, widths.slice(0, -1).map(w => (at += w * squeeze)));
  }
  return out;
}

/* Control bytes only. XML cannot legally carry them, but the marks this module
   puts in itself can reach here if a paragraph ends unexpectedly, and pdf-lib
   does not fail quietly — WinAnsi has no glyph for 0x81 and the save throws.
   The C1 range goes with them because needsUnicode counts 0x80–0x9F as Latin-1
   and would leave that text on Helvetica, where those are the undefined ones. */
function clean(text: string): string {
  let out = '';
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    out += (c < 0x20 && c !== 0x09 && c !== 0x0a) || (c >= 0x7f && c <= 0x9f) ? ' ' : ch;
  }
  return out;
}

async function render(lines: Line[]): Promise<Blob> {
  const doc = await PDFDocument.create();
  const all = lines.map(l => l.marker + l.text).join('\n');
  const uni = needsUnicode(all);
  const body = uni ? await unicodeFont(doc, 'sans') : await doc.embedFont(StandardFonts.Helvetica);
  const bold = uni ? await unicodeFont(doc, 'bold') : await doc.embedFont(StandardFonts.HelveticaBold);

  const stops = columns(lines, body);
  let page = doc.addPage([A4.w, A4.h]);
  let y = A4.h - M;
  const feed = () => { page = doc.addPage([A4.w, A4.h]); y = A4.h - M; };

  for (const item of lines) {
    const heading = item.level > 0;
    const size = heading ? HEAD[Math.min(item.level, HEAD.length) - 1]! : BODY;
    const font = heading ? bold : body;
    const lead = size * 1.45;
    /* Nesting stops widening the margin after eight steps. ODF puts no limit on
       how deep a list may go, and a document that goes twenty deep would
       otherwise indent its text off the right edge of the page. */
    const indent = M + Math.min(item.depth, 8) * STEP;
    const marker = clean(item.marker);
    /* One gutter for the whole of a list, wide enough for its widest marker, so
       the text of every item starts in the same place. */
    const gutter = marker || item.hang
      ? Math.max(STEP, run(marker, font, size, 0, undefined) + 6)
      : 0;
    const x = indent + gutter;
    const width = Math.max(120, A4.w - M - x);
    const table = stops.get(item.group);
    const rows = wrap(clean(item.text), font, size, width, table);

    if (heading) {
      /* Air above a heading, and never a heading alone at the foot of a page:
         a page that ends on its own title reads as a mistake. */
      if (y < A4.h - M) y -= size * 0.7;
      if (y - lead - BODY * 1.45 < M) feed();
    }
    rows.forEach((text, n) => {
      if (y - lead < M) feed();
      if (n === 0 && marker) page.drawText(marker, {x: indent, y: y - size, size, font, color: INK});
      if (text.trim()) {
        run(text, font, size, x, table, (part, at) =>
          page.drawText(part, {x: at, y: y - size, size, font, color: INK}));
      }
      y -= lead;
    });
    if (heading) y -= size * 0.3;
  }
  return new Blob([(await doc.save()).slice() as BlobPart], {type: 'application/pdf'});
}

/* ── the conversion ───────────────────────────────────────────────────── */

/* Which OpenDocument this is. The first entry of the zip is a stored, unpacked
   `mimetype` file for exactly this purpose, so a spreadsheet or a drawing
   handed to the wrong converter can be named rather than half-read. */
const TEXT_KINDS = /^application\/vnd\.oasis\.opendocument\.text/;
const OTHER_KINDS: Array<[RegExp, string]> = [
  [/\.spreadsheet/, 'That is an OpenDocument spreadsheet (.ods), not a text document. '
    + 'The Excel to PDF converter reads it.'],
  [/\.presentation/, 'That is an OpenDocument presentation (.odp), not a text document. '
    + 'There is nothing here that would lay its slides out.'],
  [/\.(graphics|chart|image)/, 'That is an OpenDocument drawing (.odg), not a text document. '
    + 'Its artwork is vector shapes that only a drawing program renders.'],
  [/^application\/vnd\.sun\.xml/, 'That is an OpenOffice 1.x document (.sxw), which is a '
    + 'different format under the same idea — its markup predates OpenDocument entirely. '
    + 'Open it and save it as .odt first.'],
];

export async function odtToPdf(bytes: Uint8Array): Promise<Blob> {
  const JSZip = (await import('jszip')).default;
  const zip = await (async () => {
    try { return await JSZip.loadAsync(bytes); }
    catch {
      /* D0 CF 11 E0 is the old OLE compound file — a Word 97 .doc, most often
         renamed by hand in the hope that the extension is what matters. */
      const ole = bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
      const what = looksLike(bytes);
      return refuse(ole
        ? 'That file is a Word 97-2003 .doc, not an OpenDocument one — renaming it does not '
          + 'change what is inside. Open it and save it as .odt or .docx.'
        : what
        ? `That file is ${what}, not an OpenDocument one — renaming it does not change what `
          + 'is inside.'
        : 'That file could not be opened. An .odt is a zip archive, and this one does not '
          + 'unpack — it may be damaged.');
    }
  })();

  const read = async (name: string): Promise<string | undefined> => {
    const entry = zip.file(name);
    return entry && !Array.isArray(entry) ? entry.async('string') : undefined;
  };

  const kind = (await read('mimetype'))?.trim() ?? '';
  if (kind && !TEXT_KINDS.test(kind)) {
    for (const [pattern, message] of OTHER_KINDS) if (pattern.test(kind)) refuse(message);
  }

  /* An ODF file can be encrypted with a password, and the zip still opens: the
     entries are there, deflated and then enciphered, and only the manifest says
     so. Without that check content.xml parses to nothing and the answer would
     be "this document has no text in it", which is both wrong and unhelpful. */
  const manifest = await read('META-INF/manifest.xml');
  if (manifest?.includes('encryption-data')) {
    refuse('That document is password protected. ODF encrypts the file itself, so there is '
      + 'nothing to read without the password — open it and save an unprotected copy.');
  }

  const content = await read('content.xml');
  if (!content) {
    return refuse(zip.file('word/document.xml')
      ? 'That is a Word document with the wrong extension on it — a .docx is a zip too, but '
        + 'nothing inside the two is the same. The Word to PDF converter reads it.'
      : 'That zip has no content.xml in it, so it is not an OpenDocument file.');
  }

  const root = parseXml(content);
  const body = descendant(root, 'body');
  const text = body && descendant(body, 'text');
  if (!text) {
    return refuse('That content.xml has no text body in it. The file unpacks, but what is '
      + 'inside is not an OpenDocument text document.');
  }

  /* styles.xml as well as content.xml, because a list style that came with the
     document's template is declared there while one created while typing is
     declared in content.xml, and a document usually has both. */
  const styleParts = [root];
  const styles = await read('styles.xml');
  if (styles) styleParts.push(parseXml(styles));

  const lines = readBody(text, listStyles(styleParts));
  if (!lines.some(l => l.text.trim())) {
    refuse('That document has no text in it. If what is in it is pictures or drawings, those '
      + 'are laid out by the word processor itself and a browser cannot redraw them — export '
      + 'the PDF from LibreOffice to keep them.');
  }
  return render(lines);
}
