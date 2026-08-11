/* One shape for a formatted document, and one writer that lays it out.
 *
 * Two very different readers feed this: .docx is a zip of XML, .doc is a tree of
 * binary records in an OLE2 container. Nothing about laying out a bold run or
 * drawing a table border differs between them, so neither reader draws anything
 * — each one produces the model below and stops.
 *
 * The model is deliberately smaller than Word. It carries what a document
 * actually uses to look like itself: which words are bold, italic or underlined,
 * how big they are, how the paragraph sits on the line, how far it is indented,
 * whether it is a list item, and where a table's cells begin and end. It does
 * not carry sections, columns, floating frames, or anything that would require a
 * second layout pass — and the pagination it produces is its own, not Word's.
 * A page break can therefore land in a different place than in Word; every other
 * visible property is the document's.
 *
 * Sizes are points throughout, because that is what both formats store and what
 * pdf-lib draws in: Word's half-points and twentieths-of-a-point are converted
 * at the edge, by the reader, so nothing downstream has to remember which unit
 * it is holding.
 */
import {PDFDocument, StandardFonts, rgb} from 'pdf-lib';
import type {PDFFont, PDFPage, PDFRef} from 'pdf-lib';

import {needsUnicode, unicodeFont, type Face} from '../../core/unicodeFont';

/**
 * Which family a run asks for.
 *
 * Not the typeface itself: a converter that runs in a browser cannot embed
 * Cambria because a document names it. What it can do is answer the *kind* of
 * face asked for, which is what a reader actually notices — a contract set in
 * Times and converted into a sans face looks wrong at a glance, while the same
 * contract in a different serif looks like the same document.
 */
export type Family = 'serif' | 'sans' | 'mono';

/** A stretch of text that shares one set of character properties. */
export interface Span {
  text: string;
  family?: Family;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** Points. Missing means the document's default body size. */
  size?: number;
  /** RGB, each channel 0-255. Missing means black. */
  colour?: [number, number, number];
  /** Target of a hyperlink this span belongs to. */
  link?: string;
}

export type Align = 'left' | 'center' | 'right' | 'justify';

export interface Para {
  spans: Span[];
  align?: Align;
  /** Points from the left margin. */
  indent?: number;
  /** Extra points on the first line only; negative for a hanging indent. */
  firstLine?: number;
  /** Points above and below. */
  above?: number;
  below?: number;
  /** The marker a list item is drawn with, already resolved to text. */
  bullet?: string;
}

/** Which of a cell's four sides are ruled, and in what colour. */
export interface Borders {
  top?: boolean;
  right?: boolean;
  bottom?: boolean;
  left?: boolean;
  /** RGB 0-255. Grey when absent. */
  colour?: [number, number, number];
}

export interface Cell {
  paras: Para[];
  borders?: Borders;
}

export interface Table {
  rows: Cell[][];
  /** Relative column widths. Equal columns when absent. */
  widths?: number[];
  /** Total width in points. The full text column when absent. */
  width?: number;
  /** Or a fraction of the text column, which is the other unit a file may use. */
  pct?: number;
  /** Padding inside each cell, in points. */
  pad?: number;
}

export type Block = {para: Para} | {table: Table};

export interface RichDoc {
  blocks: Block[];
  /** Page size in points. A4 portrait unless the document says otherwise. */
  page?: {width: number; height: number};
  margins?: {top: number; right: number; bottom: number; left: number};
}

const A4 = {width: 595.28, height: 841.89};
const DEFAULT_MARGINS = {top: 56, right: 56, bottom: 56, left: 56};
const BODY = 11;

/* Word's own default, and the reason a converted document does not look
   cramped: a paragraph's lines sit closer together than its neighbours do. */
const LEAD = 1.32;

/** Every distinct face the writer may need, resolved once per document. */
interface Fonts {
  get(family: Family, bold: boolean, italic: boolean): PDFFont;
}

/* The standard fourteen cover every family and slant, and cost nothing: a
   Latin-only document embeds no font at all. */
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

/* Mono has one Unicode face rather than four. A bold line of code in a converted
   document is worth less than three more fonts on the wire, and the standard
   Courier set still covers the Latin case in all four slants. */
const MONO_STANDARD: Record<string, StandardFonts> = {
  'false,false': StandardFonts.Courier,
  'true,false': StandardFonts.CourierBold,
  'false,true': StandardFonts.CourierOblique,
  'true,true': StandardFonts.CourierBoldOblique,
};

function faceOf(family: Family, bold: boolean, italic: boolean): Face {
  if (family === 'mono') return 'mono';
  const prefix = family === 'serif' ? 'serif' : '';
  if (bold && italic) return (prefix ? 'serifbolditalic' : 'bolditalic') as Face;
  if (bold) return (prefix ? 'serifbold' : 'bold') as Face;
  if (italic) return (prefix ? 'serifitalic' : 'italic') as Face;
  return (prefix ? 'serif' : 'sans') as Face;
}

/* Every face is resolved up front rather than lazily per run: a document that
   turns out to be Cyrillic needs the Unicode set, and discovering that halfway
   through a page would mean measuring the first half with one face and drawing
   it with another. */
async function fontsFor(doc: PDFDocument, text: string): Promise<Fonts> {
  const uni = needsUnicode(text);
  const faces = new Map<string, PDFFont>();

  const key = (family: Family, bold: boolean, italic: boolean) => `${family},${bold},${italic}`;

  for (const family of ['serif', 'sans', 'mono'] as Family[]) {
    for (const bold of [false, true]) {
      for (const italic of [false, true]) {
        const font = uni
          ? await unicodeFont(doc, faceOf(family, bold, italic))
          : await doc.embedFont(family === 'mono'
            ? MONO_STANDARD[`${bold},${italic}`]!
            : STANDARD[faceOf(family, bold, italic)]);
        faces.set(key(family, bold, italic), font);
      }
    }
  }
  return {get: (family, bold, italic) => faces.get(key(family, bold, italic))!};
}

/** A span measured and ready to draw at a position on a line. */
interface Piece {
  text: string;
  font: PDFFont;
  size: number;
  width: number;
  underline: boolean;
  strike: boolean;
  colour: [number, number, number];
  link?: string;
}

interface Line {
  pieces: Piece[];
  width: number;
  /** Tallest piece on the line decides how far the baseline drops. */
  height: number;
  /** Whether justification may stretch this line — the last one never is. */
  stretch: boolean;
}

const spaceRuns = (s: string): string[] => s.split(/(\s+)/).filter(p => p !== '');

/**
 * Break one paragraph into drawn lines inside a given width.
 *
 * Wrapping is per word across span boundaries, which is the whole reason spans
 * are not laid out one at a time: a bold word followed by a plain one belongs on
 * the same line, and a naive per-span layout puts a break between them.
 */
function wrap(para: Para, fonts: Fonts, width: number, firstWidth: number): Line[] {
  const lines: Line[] = [];
  let pieces: Piece[] = [];
  let used = 0;
  let limit = firstWidth;

  const flush = (stretch: boolean) => {
    /* Trailing space must not count towards the line's width, or a
       right-aligned line drifts left by one space. */
    while (pieces.length && /^\s+$/.test(pieces[pieces.length - 1]!.text)) {
      used -= pieces.pop()!.width;
    }
    const height = pieces.reduce((h, p) => Math.max(h, p.size), BODY);
    lines.push({pieces, width: used, height, stretch});
    pieces = [];
    used = 0;
    limit = width;
  };

  for (const span of para.spans) {
    const size = span.size ?? BODY;
    const font = fonts.get(span.family ?? 'sans', !!span.bold, !!span.italic);
    const colour = span.colour ?? [0, 0, 0];

    for (const chunk of spaceRuns(span.text)) {
      /* A hard break inside a run ends the line wherever it stands. */
      if (chunk === '\n') { flush(false); continue; }

      const w = font.widthOfTextAtSize(chunk, size);
      const blank = /^\s+$/.test(chunk);

      if (used + w > limit && !blank && pieces.length) flush(true);
      /* A leading space on a fresh line is Word's own doing, not the reader's:
         dropping it keeps the left edge straight. */
      if (blank && !pieces.length) continue;

      pieces.push({
        text: chunk, font, size, width: w,
        underline: !!span.underline, strike: !!span.strike, colour,
        ...(span.link ? {link: span.link} : {}),
      });
      used += w;
    }
  }
  flush(false);
  /* An empty paragraph is a blank line, not nothing: Word documents space
     themselves with them. */
  if (!lines.length) lines.push({pieces: [], width: 0, height: BODY, stretch: false});
  return lines;
}

/** Height a wrapped paragraph will occupy, before it is committed to a page. */
const heightOf = (lines: Line[], para: Para): number =>
  (para.above ?? 0) + lines.reduce((h, l) => h + l.height * LEAD, 0) + (para.below ?? 0);

/* ── the writer ──────────────────────────────────────────────────────────── */

class Writer {
  private page: PDFPage;
  private y: number;
  private readonly links: Array<{page: PDFPage; rect: [number, number, number, number]; url: string}> = [];

  constructor(
    private readonly doc: PDFDocument,
    private readonly size: {width: number; height: number},
    private readonly margins: {top: number; right: number; bottom: number; left: number},
    private readonly fonts: Fonts,
  ) {
    this.page = doc.addPage([size.width, size.height]);
    this.y = size.height - margins.top;
  }

  private get bottom(): number { return this.margins.bottom; }
  get textWidth(): number { return this.size.width - this.margins.left - this.margins.right; }

  private room(need: number): void {
    if (this.y - need >= this.bottom) return;
    this.page = this.doc.addPage([this.size.width, this.size.height]);
    this.y = this.size.height - this.margins.top;
  }

  /** Draw one wrapped paragraph, breaking pages between its lines. */
  paragraph(para: Para, lines: Line[], left: number, width: number): void {
    this.y -= para.above ?? 0;

    lines.forEach((line, i) => {
      this.room(line.height * LEAD);
      const first = i === 0;
      /* A list item's first line is not offset: the hanging indent belongs to the
         marker, which is drawn into it, and the text lines up with itself down the
         whole item. Offsetting the text as well is what put the second line of a
         bullet further right than the first. */
      const indent = first && !para.bullet ? (para.firstLine ?? 0) : 0;
      const avail = width - indent;

      let x = left + indent;
      if (para.align === 'center') x += (avail - line.width) / 2;
      else if (para.align === 'right') x += avail - line.width;

      /* Justification stretches the gaps, never the words: a line whose spaces
         grow is Word's own behaviour, and stretching glyphs is not. */
      let extra = 0;
      if (para.align === 'justify' && line.stretch) {
        const gaps = line.pieces.filter(p => /^\s+$/.test(p.text)).length;
        if (gaps) extra = (avail - line.width) / gaps;
      }

      const baseline = this.y - line.height;

      if (first && para.bullet) {
        const lead = para.spans[0];
        const font = this.fonts.get(lead?.family ?? 'sans', !!lead?.bold, false);
        const size = lead?.size ?? line.height;
        const w = font.widthOfTextAtSize(para.bullet, size);
        /* Into the hanging indent the document declared, when it declared one:
           that is exactly what the negative first-line offset is reserved for.
           Failing that, just outside the text. */
        const hang = para.firstLine !== undefined && para.firstLine < 0
          ? para.firstLine
          : -(w + 6);
        this.page.drawText(para.bullet, {
          x: left + hang, y: baseline, size, font, color: rgb(0, 0, 0),
        });
      }

      for (const piece of line.pieces) {
        const blank = /^\s+$/.test(piece.text);
        if (!blank) {
          const [r, g, b] = piece.colour;
          this.page.drawText(piece.text, {
            x, y: baseline, size: piece.size, font: piece.font,
            color: rgb(r / 255, g / 255, b / 255),
          });
          if (piece.underline || piece.strike) {
            const thick = Math.max(0.5, piece.size * 0.055);
            const at = piece.underline ? baseline - piece.size * 0.12 : baseline + piece.size * 0.28;
            this.page.drawRectangle({
              x, y: at, width: piece.width, height: thick,
              color: rgb(r / 255, g / 255, b / 255),
            });
          }
          if (piece.link) {
            this.links.push({
              page: this.page,
              rect: [x, baseline - piece.size * 0.2, x + piece.width, baseline + piece.size],
              url: piece.link,
            });
          }
        }
        x += piece.width + (blank ? extra : 0);
      }

      this.y -= line.height * LEAD;
    });

    this.y -= para.below ?? 0;
  }

  /**
   * Draw a table.
   *
   * Row height is whatever its tallest cell needs, so a cell that wraps to three
   * lines makes the row three lines tall rather than spilling over its
   * neighbours. A row taller than a whole page is drawn anyway on a fresh page
   * and allowed to overflow, because splitting a cell mid-row needs a second
   * layout pass and a document that has one is broken in Word too.
   */
  table(table: Table, fonts: Fonts): void {
    const cols = Math.max(1, ...table.rows.map(r => r.length));
    const rel = table.widths?.length === cols
      ? table.widths
      : Array.from({length: cols}, () => 1);
    const total = rel.reduce((a, b) => a + b, 0);
    const pad = table.pad ?? 4;
    /* A table declares its own width and most do not fill the column: a
       three-column price list ruled across the whole page is not the table the
       document has. Wider than the text column is clamped, because the page is
       the page. */
    const declared = table.width ?? (table.pct ? table.pct * this.textWidth : undefined);
    const span = Math.min(declared ?? this.textWidth, this.textWidth);
    const widths = rel.map(w => (w / total) * span);

    for (const row of table.rows) {
      /* Wrap every cell first: the row cannot be placed until its height is
         known, and its height is the tallest wrapped cell. */
      const laid = row.map((cell, i) => {
        const inner = (widths[i] ?? widths[0]!) - pad * 2;
        return cell.paras.map(p => ({para: p, lines: wrap(p, fonts, inner, inner)}));
      });
      const height = Math.max(
        14,
        ...laid.map(cell => cell.reduce((h, c) => h + heightOf(c.lines, c.para), 0) + pad * 2),
      );

      this.room(height);
      const top = this.y;
      let x = this.margins.left;

      laid.forEach((cell, i) => {
        const w = widths[i] ?? widths[0]!;
        this.rule(row[i]?.borders, x, top - height, w, height);

        /* Each cell lays out inside its own column, so the writer's cursor is
           borrowed and put back rather than shared. */
        const keep = this.y;
        this.y = top - pad;
        for (const {para, lines} of cell) this.paragraph(para, lines, x + pad, w - pad * 2);
        this.y = keep;
        x += w;
      });

      this.y = top - height;
    }
  }

  /* Sides are drawn one at a time rather than as a rectangle: a cell can be
     ruled on three sides, and the borders a document declares are per side. */
  private rule(borders: Borders | undefined, x: number, y: number, w: number, h: number): void {
    if (!borders) return;
    const [r, g, b] = borders.colour ?? [128, 128, 128];
    const colour = rgb(r / 255, g / 255, b / 255);
    const line = (x0: number, y0: number, x1: number, y1: number) => {
      this.page.drawLine({start: {x: x0, y: y0}, end: {x: x1, y: y1}, thickness: 0.5, color: colour});
    };
    if (borders.top) line(x, y + h, x + w, y + h);
    if (borders.bottom) line(x, y, x + w, y);
    if (borders.left) line(x, y, x, y + h);
    if (borders.right) line(x + w, y, x + w, y + h);
  }

  /** Attach the collected hyperlinks. Called once, after all drawing. */
  finish(): void {
    if (!this.links.length) return;
    const byPage = new Map<PDFPage, PDFRef[]>();
    for (const link of this.links) {
      const action = this.doc.context.obj({Type: 'Action', S: 'URI', URI: this.doc.context.obj(link.url)});
      const annot = this.doc.context.obj({
        Type: 'Annot', Subtype: 'Link', Rect: link.rect,
        Border: [0, 0, 0], C: [], A: action,
      });
      const ref = this.doc.context.register(annot);
      const list = byPage.get(link.page) ?? [];
      list.push(ref);
      byPage.set(link.page, list);
    }
    for (const [page, refs] of byPage) {
      page.node.set(this.doc.context.obj('Annots'), this.doc.context.obj(refs));
    }
  }
}

/** Flatten every string in the document, to decide which font set is needed. */
function allText(doc: RichDoc): string {
  const out: string[] = [];
  const para = (p: Para) => { for (const s of p.spans) out.push(s.text); if (p.bullet) out.push(p.bullet); };
  for (const block of doc.blocks) {
    if ('para' in block) para(block.para);
    else for (const row of block.table.rows) for (const cell of row) for (const p of cell.paras) para(p);
  }
  return out.join('');
}

/** Lay a document model out as a PDF. */
export async function richDocToPdf(model: RichDoc): Promise<Blob> {
  const doc = await PDFDocument.create();
  const fonts = await fontsFor(doc, allText(model));
  const size = model.page ?? A4;
  const margins = model.margins ?? DEFAULT_MARGINS;
  const writer = new Writer(doc, size, margins, fonts);

  for (const block of model.blocks) {
    if ('table' in block) {
      writer.table(block.table, fonts);
    } else {
      const {para} = block;
      const indent = para.indent ?? 0;
      const width = writer.textWidth - indent;
      /* The first line is only narrower when the text itself is offset, which a
         list item's is not — its offset is spent on the marker. */
      const firstWidth = para.bullet ? width : width - (para.firstLine ?? 0);
      writer.paragraph(para, wrap(para, fonts, width, firstWidth), margins.left + indent, width);
    }
  }

  writer.finish();
  return new Blob([(await doc.save()).slice() as BlobPart], {type: 'application/pdf'});
}
