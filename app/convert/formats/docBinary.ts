/* Word 97-2003 in, a formatted document model out.
 *
 * A .doc is not a zip and not markup. It is an OLE2 compound file (opened by
 * ./ole.ts, shared with the .ppt reader) holding two streams that matter:
 * `WordDocument`, which begins with the FIB and contains the text, and a table
 * stream named either `0Table` or `1Table` — a flag in the FIB says which — that
 * holds every index into it.
 *
 * Three of those indexes are read here.
 *
 * The piece table (Clx) is the reason text cannot simply be sliced out of the
 * stream. A document that has been edited is stored as pieces in whatever order
 * the editor left them, and each piece independently says whether its characters
 * are one byte (Windows-1252) or two (UTF-16LE). Walking the piece table is the
 * only way to read the text in document order and the only way to get the
 * encoding right — the reason a naive extractor produces text with holes in it or
 * NUL bytes between every letter.
 *
 * The character and paragraph bin tables (PlcfbteChpx, PlcfbtePapx) point at
 * 512-byte "formatted disk pages", each of which is a small index of its own:
 * which stretches of the file share one set of properties, and where that set
 * lives inside the page. The properties themselves are SPRMs — two-byte opcodes
 * whose operand size is encoded in the opcode — applied in order like a diff.
 *
 * What is read: bold, italic, underline, strike-through, size, colour, the font
 * family, alignment, indents and paragraph spacing.
 *
 * What is not: tables. In this format a table is not a container at all — it is a
 * run of ordinary paragraphs each flagged as being in one, with the row structure
 * carried in separate properties. Reconstructing that is a second reader's worth
 * of work, and a .doc that needs it converts correctly through .docx after ten
 * seconds in Word. Lists are likewise left as their text: the numbering lives in
 * yet another table and a wrong number is worse than none.
 */
import {Refused, looksLike} from '../heavy.ts';
import {isOle2, openOle2} from './ole.ts';
import {
  richDocToPdf,
  type Align, type Block, type Family, type Para, type RichDoc, type Span,
} from './richDoc.ts';

const refuse = (m: string): never => { throw new Refused(m); };

/* ── the FIB ──────────────────────────────────────────────────────────────
 *
 * Four variable-length arrays back to back, each preceded by its own count. The
 * one wanted is the last, and its entries are (offset, length) pairs into the
 * table stream. Walking to it rather than using a fixed offset is what makes this
 * work on the several FIB versions in the wild. */
function rgFcLcbAt(dv: DataView): number {
  let off = 32;
  const csw = dv.getUint16(off, true); off += 2 + csw * 2;
  const cslw = dv.getUint16(off, true); off += 2 + cslw * 4;
  const cbRgFcLcb = dv.getUint16(off, true); off += 2;
  if (cbRgFcLcb < 34) {
    refuse('That file is a Word document from before Word 97, and its layout is different '
      + 'enough that this reader cannot follow it. Opening it in Word or LibreOffice and '
      + 'saving as .docx converts it here exactly.');
  }
  return off;
}

/** Индекси в rgFcLcb, за нумерацією формату. */
const I_CHPX = 12, I_PAPX = 13, I_FFN = 15, I_CLX = 33;

const pair = (dv: DataView, base: number, index: number): {fc: number; lcb: number} => ({
  fc: dv.getUint32(base + index * 8, true),
  lcb: dv.getUint32(base + index * 8 + 4, true),
});

/* ── the piece table ─────────────────────────────────────────────────────── */

interface Piece {
  /** Character position where this piece starts in the document. */
  cp: number;
  /** How many characters it holds. */
  length: number;
  /** Byte offset of its text in the WordDocument stream. */
  fc: number;
  /** One byte per character rather than two. */
  compressed: boolean;
}

function readPieces(clx: Uint8Array): Piece[] {
  const dv = new DataView(clx.buffer, clx.byteOffset, clx.byteLength);
  let at = 0;

  /* Any number of property runs come first, each announcing its own length, and
     then exactly one piece table. Skipping rather than reading them: they hold
     properties for the pieces, which this reader takes from the bin tables. */
  while (at < clx.length && clx[at] === 0x01) {
    const cb = dv.getInt16(at + 1, true);
    at += 3 + cb;
  }
  if (at >= clx.length || clx[at] !== 0x02) {
    refuse('That Word document has no piece table, which is where its text is indexed. '
      + 'The file is either damaged or an older format than this reader handles.');
  }

  const lcb = dv.getUint32(at + 1, true);
  const body = at + 5;
  /* Each piece costs 8 bytes of descriptor and shares a 4-byte position with its
     neighbour, plus one for the end. */
  const count = Math.floor((lcb - 4) / 12);
  if (count <= 0) refuse('That Word document has an empty piece table.');

  const pieces: Piece[] = [];
  for (let i = 0; i < count; i++) {
    const cp = dv.getUint32(body + i * 4, true);
    const next = dv.getUint32(body + (i + 1) * 4, true);
    const pcd = body + (count + 1) * 4 + i * 8;
    const raw = dv.getUint32(pcd + 2, true);
    /* Bit 30 says the piece is one byte per character, and doubles as a flag the
       offset itself has to be cleared of and halved. */
    const compressed = (raw & 0x40000000) !== 0;
    const fc = compressed ? (raw & 0x3fffffff) / 2 : (raw & 0x3fffffff);
    pieces.push({cp, length: next - cp, fc, compressed});
  }
  return pieces;
}

/* Windows-1252 differs from Latin-1 only in 0x80-0x9F, and that range is where
   the quotation marks and the dash a contract is full of live. Decoding it as
   Latin-1 turns every one of them into a control character. */
const CP1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021,
  0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178,
];

/** One character of the document, with the byte it came from. */
interface Ch {
  ch: string;
  /** Where its properties are looked up. */
  fc: number;
}

function readText(main: Uint8Array, pieces: Piece[]): Ch[] {
  const out: Ch[] = [];
  const dv = new DataView(main.buffer, main.byteOffset, main.byteLength);

  for (const piece of pieces) {
    for (let i = 0; i < piece.length; i++) {
      if (piece.compressed) {
        const at = piece.fc + i;
        if (at >= main.length) break;
        const b = main[at]!;
        const code = b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80]! : b;
        out.push({ch: String.fromCharCode(code), fc: at});
      } else {
        const at = piece.fc + i * 2;
        if (at + 1 >= main.length) break;
        out.push({ch: String.fromCharCode(dv.getUint16(at, true)), fc: at});
      }
    }
  }
  return out;
}

/* ── SPRMs ───────────────────────────────────────────────────────────────
 *
 * A property is a two-byte opcode followed by an operand whose width the opcode
 * itself declares, in three bits of it. That is the whole reason a run of them
 * can be walked without knowing what any of them mean. */
const SPRA_SIZE = [1, 1, 2, 4, 2, 2, -1, 3];

interface Sprm {op: number; at: number; size: number}

function readSprms(grp: Uint8Array): Sprm[] {
  const dv = new DataView(grp.buffer, grp.byteOffset, grp.byteLength);
  const out: Sprm[] = [];
  let at = 0;
  while (at + 2 <= grp.length) {
    const op = dv.getUint16(at, true);
    const spra = (op >> 13) & 7;
    let size = SPRA_SIZE[spra]!;
    let body = at + 2;
    if (size === -1) {
      /* Variable length, and one opcode announces it in two bytes instead of
         one — the exception the format documents by name. */
      if (op === 0xd608) { size = dv.getUint16(body, true); body += 2; }
      else { size = grp[body]!; body += 1; }
    }
    if (body + size > grp.length) break;
    out.push({op, at: body, size});
    at = body + size;
  }
  return out;
}

const CHAR_SPRM = {
  bold: 0x0835, italic: 0x0836, strike: 0x0837, underline: 0x2a3e,
  size: 0x4a43, font: 0x4a4f, colour24: 0x6870,
} as const;

const PARA_SPRM = {
  align: 0x2403, left: 0x840f, right: 0x840e, firstLine: 0x8411,
  before: 0xa413, after: 0xa414, inTable: 0x2416,
} as const;

/* 0 is off and 1 is on. 128 and 129 mean "as the style" and "the opposite of the
   style", which need a style this reader does not resolve — inheriting is the
   honest answer to both. */
const toggle = (v: number): boolean | undefined => (v === 0 ? false : v === 1 ? true : undefined);

interface Chars {
  family?: Family;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  size?: number;
  colour?: [number, number, number];
}

function applyChars(into: Chars, grp: Uint8Array, fonts: Family[]): void {
  const dv = new DataView(grp.buffer, grp.byteOffset, grp.byteLength);
  for (const {op, at, size} of readSprms(grp)) {
    switch (op) {
      case CHAR_SPRM.bold: { const v = toggle(grp[at]!); if (v !== undefined) into.bold = v; break; }
      case CHAR_SPRM.italic: { const v = toggle(grp[at]!); if (v !== undefined) into.italic = v; break; }
      case CHAR_SPRM.strike: { const v = toggle(grp[at]!); if (v !== undefined) into.strike = v; break; }
      case CHAR_SPRM.underline: into.underline = grp[at] !== 0; break;
      case CHAR_SPRM.size: if (size >= 2) into.size = dv.getUint16(at, true) / 2; break;
      case CHAR_SPRM.font: {
        if (size >= 2) {
          const family = fonts[dv.getUint16(at, true)];
          if (family) into.family = family;
        }
        break;
      }
      case CHAR_SPRM.colour24: {
        /* Three bytes of colour and a fourth that says whether to use them. */
        if (size >= 4 && grp[at + 3] === 0xff) into.colour = [grp[at]!, grp[at + 1]!, grp[at + 2]!];
        break;
      }
      default: break;
    }
  }
}

const ALIGN: Record<number, Align> = {0: 'left', 1: 'center', 2: 'right', 3: 'justify'};

interface Marks {
  align?: Align;
  indent?: number;
  firstLine?: number;
  above?: number;
  below?: number;
  inTable?: boolean;
}

function applyMarks(into: Marks, grp: Uint8Array): void {
  const dv = new DataView(grp.buffer, grp.byteOffset, grp.byteLength);
  for (const {op, at, size} of readSprms(grp)) {
    switch (op) {
      case PARA_SPRM.align: { const a = ALIGN[grp[at]!]; if (a) into.align = a; break; }
      case PARA_SPRM.left: if (size >= 2) into.indent = dv.getInt16(at, true) / 20; break;
      case PARA_SPRM.firstLine: if (size >= 2) into.firstLine = dv.getInt16(at, true) / 20; break;
      case PARA_SPRM.before: if (size >= 2) into.above = dv.getUint16(at, true) / 20; break;
      case PARA_SPRM.after: if (size >= 2) into.below = dv.getUint16(at, true) / 20; break;
      case PARA_SPRM.inTable: into.inTable = grp[at] !== 0; break;
      default: break;
    }
  }
}

/* ── the bin tables and their pages ────────────────────────────────────── */

/** A stretch of the file, and the properties that apply to it. */
interface Run {from: number; to: number; grp: Uint8Array}

/**
 * Walk one bin table into a flat list of runs.
 *
 * The table is a PLC: positions first, then one page number per gap between
 * them. Each page is 512 bytes and indexes itself — a count in its last byte, a
 * list of file positions, then one offset per position saying where in the page
 * that position's properties sit. Paragraph and character pages differ only in
 * how wide those offsets are and whether a length byte precedes the properties.
 */
function readBin(table: Uint8Array, main: Uint8Array, fc: number, lcb: number, para: boolean): Run[] {
  if (!lcb || fc + lcb > table.length) return [];
  const plc = table.subarray(fc, fc + lcb);
  const dv = new DataView(plc.buffer, plc.byteOffset, plc.byteLength);
  /* n positions and n-1 pages, four bytes each. */
  const count = Math.floor((lcb - 4) / 8);
  const runs: Run[] = [];

  for (let i = 0; i < count; i++) {
    const pn = dv.getUint32((count + 1) * 4 + i * 4, true) & 0x003fffff;
    const page = main.subarray(pn * 512, pn * 512 + 512);
    if (page.length < 512) continue;
    const pdv = new DataView(page.buffer, page.byteOffset, page.byteLength);
    const crun = page[511]!;
    if (!crun) continue;

    for (let j = 0; j < crun; j++) {
      const from = pdv.getUint32(j * 4, true);
      const to = pdv.getUint32((j + 1) * 4, true);
      let grp: Uint8Array;

      if (para) {
        /* A paragraph entry is 13 bytes; the first two are the offset in words,
           and the properties begin with a length in words after a style id. */
        const rgb = (crun + 1) * 4 + j * 13;
        const word = pdv.getUint16(rgb, true);
        if (!word) continue;
        const papx = word * 2;
        let cb = page[papx]! * 2;
        let body = papx + 1;
        if (cb === 0) { cb = page[papx + 1]! * 2; body = papx + 2; }
        /* Two bytes of style id sit in front of the properties themselves. */
        grp = page.subarray(body + 2, body + cb);
      } else {
        const rgb = (crun + 1) * 4 + j;
        const word = page[rgb]!;
        if (!word) continue;
        const chpx = word * 2;
        const cb = page[chpx]!;
        grp = page.subarray(chpx + 1, chpx + 1 + cb);
      }
      if (grp.length) runs.push({from, to, grp});
    }
  }
  return runs;
}

/** Properties in force at a byte position. */
const runAt = (runs: Run[], fc: number): Uint8Array | null => {
  for (const run of runs) if (fc >= run.from && fc < run.to) return run.grp;
  return null;
};

/* ── the font table ──────────────────────────────────────────────────────
 *
 * Names, in order, so a character property that says "font 3" can be answered.
 * Each entry announces its own length and holds the name as UTF-16 after a fixed
 * header; only the family it belongs to is kept. */
const SERIF = ['times', 'georgia', 'garamond', 'cambria', 'book antiqua', 'palatino',
  'liberation serif', 'dejavu serif', 'nimbus roman', 'thorndale', 'century', 'bookman',
  'constantia', 'minion', 'serif'];
const MONO = ['courier', 'consolas', 'monaco', 'menlo', 'liberation mono', 'lucida console',
  'cumberland', 'nimbus mono', 'monospace'];

function familyOf(name: string): Family {
  const it = name.toLowerCase();
  if (MONO.some(m => it.includes(m))) return 'mono';
  if (SERIF.some(s => it.includes(s))) return 'serif';
  return 'sans';
}

/* Fixed part of one entry before the name begins: its own length byte, flags,
   weight, charset, the alternate-name index, ten bytes of PANOSE and twenty-four
   of font signature. */
const FFN_HEADER = 40;

/**
 * The names, in order.
 *
 * The count in front of them is two or four bytes depending on the writer, and
 * nothing in the table says which. So the start is found rather than assumed: the
 * right one is the offset whose first entry declares a length long enough to
 * contain a name at all. Guessing wrong yields a zero length and an empty table,
 * which is what happened before this looked.
 */
function readFonts(table: Uint8Array, fc: number, lcb: number): Family[] {
  if (!lcb || fc + lcb > table.length) return [];
  const stt = table.subarray(fc, fc + lcb);
  const dv = new DataView(stt.buffer, stt.byteOffset, stt.byteLength);

  const start = [4, 2, 6].find(at => {
    const cb = stt[at];
    return cb !== undefined && cb > FFN_HEADER && at + 1 + cb <= stt.length;
  });
  if (start === undefined) return [];

  const out: Family[] = [];
  let at = start;
  let guard = 0;
  while (at < stt.length && guard++ < 1000) {
    const cb = stt[at]!;
    if (cb <= FFN_HEADER || at + cb + 1 > stt.length) break;
    let name = '';
    for (let i = at + FFN_HEADER; i + 1 < at + 1 + cb; i += 2) {
      const code = dv.getUint16(i, true);
      if (!code) break;
      name += String.fromCharCode(code);
    }
    out.push(familyOf(name));
    at += cb + 1;
  }
  return out;
}

/* ── assembling the document ─────────────────────────────────────────────── */

function checkSignature(bytes: Uint8Array): void {
  if (isOle2(bytes)) return;
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    refuse('That file is a zip archive, which means it is a modern .docx rather than a '
      + '97-2003 .doc — this page reads both, so try it again and it will be taken as .docx.');
  }
  const what = looksLike(bytes);
  refuse(what
    ? `That file is ${what}, not a Word 97-2003 document — renaming it does not change what `
      + 'is inside.'
    : 'That file is not a Word 97-2003 (.doc) document. Its first eight bytes are not the '
      + 'OLE2 compound-file signature every .doc begins with.');
}

/** Read a .doc into the shared document model. */
export async function docToModel(bytes: Uint8Array): Promise<RichDoc> {
  checkSignature(bytes);
  const ole = openOle2(bytes);

  const main = ole.stream('WordDocument')
    ?? refuse('That OLE2 file has no WordDocument stream, so it is not a Word document — '
      + 'it may be an Excel or PowerPoint file from the same era.');

  const dv = new DataView(main.buffer, main.byteOffset, main.byteLength);
  if (dv.getUint16(0, true) !== 0xa5ec) {
    refuse('That file has a Word document stream but not a Word header at the start of it, '
      + 'so it is damaged.');
  }

  /* A bit in the FIB says which of the two possible table streams is the live
     one. A document that has been saved repeatedly has both, and reading the
     stale one gives properties that belong to an older version of the text. */
  const flags = dv.getUint16(0x0a, true);
  const tableName = (flags & 0x0200) ? '1Table' : '0Table';
  const table = ole.stream(tableName)
    ?? refuse(`That Word document is missing its ${tableName} stream, where the index to its `
      + 'text lives, so it cannot be read.');

  const base = rgFcLcbAt(dv);
  const clxAt = pair(dv, base, I_CLX);
  if (!clxAt.lcb || clxAt.fc + clxAt.lcb > table.length) {
    refuse('That Word document\'s piece table is missing or points outside the file, which '
      + 'means it is damaged.');
  }

  const pieces = readPieces(table.subarray(clxAt.fc, clxAt.fc + clxAt.lcb));
  const chars = readText(main, pieces);
  if (!chars.length) refuse('That Word document has no text in it.');

  const ffn = pair(dv, base, I_FFN);
  const fonts = readFonts(table, ffn.fc, ffn.lcb);

  /* In this format the body font is normally set by the Normal style rather than
     by any run, and the stylesheet is a reader of its own. The first entry of the
     font table is the one the writer put the document's own default at, which is
     the same answer without that reader. Failing even that, serif: Word 97-2003
     shipped Times New Roman as its default, so an unstyled .doc is a serif
     document, and rendering it in a sans face is the most visible way a
     conversion can look wrong. */
  const defaultFamily: Family = fonts[0] ?? 'serif';

  const chpxAt = pair(dv, base, I_CHPX);
  const papxAt = pair(dv, base, I_PAPX);
  const chpx = readBin(table, main, chpxAt.fc, chpxAt.lcb, false);
  const papx = readBin(table, main, papxAt.fc, papxAt.lcb, true);

  /* Split on the paragraph mark and build spans as the character properties
     change. A cell mark (0x07) ends a paragraph too — its table is not
     reconstructed, but its text must not run into the next cell's. */
  const blocks: Block[] = [];
  let spans: Span[] = [];
  let text = '';
  let look: Chars = {};
  let endFc = chars[chars.length - 1]!.fc;

  const flushSpan = () => {
    if (!text) return;
    const span: Span = {text};
    span.family = look.family ?? defaultFamily;
    if (look.bold) span.bold = true;
    if (look.italic) span.italic = true;
    if (look.underline) span.underline = true;
    if (look.strike) span.strike = true;
    if (look.size !== undefined) span.size = look.size;
    if (look.colour) span.colour = look.colour;
    spans.push(span);
    text = '';
  };

  const flushPara = (fc: number) => {
    flushSpan();
    const marks: Marks = {};
    const grp = runAt(papx, fc);
    if (grp) applyMarks(marks, grp);

    const para: Para = {spans};
    if (marks.align) para.align = marks.align;
    if (marks.indent) para.indent = marks.indent;
    if (marks.firstLine) para.firstLine = marks.firstLine;
    if (marks.above) para.above = marks.above;
    if (marks.below !== undefined) para.below = marks.below;
    blocks.push({para});
    spans = [];
  };

  /* A field is stored as its instruction and then its result, between three
     marks: begin, separator, end. The instruction is machinery — leaving it in is
     how `HYPERLINK "mailto:..."` ends up printed in front of the address it was
     supposed to link. The result after the separator is the text the document
     shows, so that is the half that is kept. */
  let inInstruction = false;

  for (const {ch, fc} of chars) {
    if (ch === '\x13') { flushSpan(); inInstruction = true; continue; }
    if (ch === '\x14') { inInstruction = false; continue; }
    if (ch === '\x15') continue;
    if (inInstruction) continue;

    /* Drawing anchors and the picture placeholder are not text. */
    if (ch === '\x01' || ch === '\x08') continue;

    if (ch === '\r' || ch === '\x07') { endFc = fc; flushPara(fc); continue; }

    const next: Chars = {};
    const grp = runAt(chpx, fc);
    if (grp) applyChars(next, grp, fonts);

    const same = next.bold === look.bold && next.italic === look.italic
      && next.underline === look.underline && next.strike === look.strike
      && next.size === look.size && next.family === look.family
      && String(next.colour) === String(look.colour);
    if (!same) { flushSpan(); look = next; }

    if (ch === '\v') text += '\n';           // a soft line break
    else if (ch === '\t') text += '  ';
    else if (ch === '\x1e') text += '‑'; // non-breaking hyphen
    else if (ch >= ' ' || ch === '\n') text += ch;
  }
  flushPara(endFc);

  const hasText = blocks.some(b => 'para' in b && b.para.spans.some(s => s.text.trim()));
  if (!hasText) {
    refuse('That Word document has no text in it. If its content is images, convert those '
      + 'to PDF instead.');
  }
  return {blocks};
}

export async function docToPdf(bytes: Uint8Array): Promise<Blob> {
  return richDocToPdf(await docToModel(bytes));
}
