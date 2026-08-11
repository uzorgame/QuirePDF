/* Word 2007 and later in, a formatted document model out.
 *
 * A .docx is a zip. The words live in word/document.xml, but almost none of what
 * makes the page look like itself lives beside them: a bold heading is bold
 * because its paragraph names a style, the style is defined in word/styles.xml,
 * and that style may in turn be based on another. A bullet is a bullet because
 * the paragraph names a numbering id, which word/numbering.xml maps — through a
 * second indirection — to an abstract list whose level says which character to
 * draw. A hyperlink's target is not in the paragraph at all: the run carries a
 * relationship id and word/_rels/document.xml.rels holds the URL.
 *
 * So this reader opens four parts, not one, and resolves each chain before it
 * emits anything. That is the whole difference between the previous reader, which
 * collected w:t nodes into a string, and a converted document that still looks
 * like the original.
 *
 * What is deliberately not read: sections and their page geometry beyond the
 * first, columns, floating shapes, footnotes, headers and footers, revision
 * marks other than deletions, and embedded images. Each would change the shape of
 * the model rather than add a property to it, and a document that needs them is
 * not served by a half-implementation.
 */
import {Refused} from '../heavy.ts';
import {
  richDocToPdf,
  type Align, type Block, type Borders, type Cell, type Family,
  type Para, type RichDoc, type Span, type Table,
} from './richDoc.ts';

const refuse = (m: string): never => { throw new Refused(m); };

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/* Word stores most lengths in twentieths of a point and character sizes in
   half-points. Everything is converted here so nothing downstream has to ask. */
const twips = (v: string | null): number | undefined => {
  const n = v === null ? NaN : Number(v);
  return Number.isFinite(n) ? n / 20 : undefined;
};
const halfPoints = (v: string | null): number | undefined => {
  const n = v === null ? NaN : Number(v);
  return Number.isFinite(n) ? n / 2 : undefined;
};

const child = (el: Element, name: string): Element | null =>
  el.getElementsByTagNameNS(W, name).item(0);

/** A direct child only — w:pPr inside a nested table must not answer for us. */
function own(el: Element, name: string): Element | null {
  for (const c of Array.from(el.children)) {
    if (c.namespaceURI === W && c.localName === name) return c;
  }
  return null;
}

const ownAll = (el: Element, name: string): Element[] =>
  Array.from(el.children).filter(c => c.namespaceURI === W && c.localName === name);

const attr = (el: Element | null, name: string): string | null =>
  el ? el.getAttributeNS(W, name) ?? el.getAttribute(`w:${name}`) : null;

/* w:b and friends are on when present unless they say w:val="0". */
function flag(props: Element | null, name: string): boolean | undefined {
  if (!props) return undefined;
  const el = own(props, name);
  if (!el) return undefined;
  const val = attr(el, 'val');
  return val === null ? true : !['0', 'false', 'off', 'none'].includes(val);
}

/** The character properties a run can carry, before inheritance is applied. */
interface Chars {
  family?: Family;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  size?: number;
  colour?: [number, number, number];
}

/**
 * Which family a named typeface belongs to.
 *
 * The name is all there is to go on — the file itself is not in the .docx unless
 * it was embedded, and even then it cannot be handed to a PDF writer as-is. So
 * the question is not "which font" but "serif or not", which is what a reader
 * notices. The list is the faces that actually turn up in documents rather than
 * an attempt at completeness; anything unrecognised falls back to the default the
 * document's own styles set, not to a guess.
 */
const SERIF = [
  'times', 'georgia', 'garamond', 'cambria', 'book antiqua', 'palatino', 'baskerville',
  'liberation serif', 'dejavu serif', 'nimbus roman', 'thorndale', 'minion', 'constantia',
  'bookman', 'century', 'droid serif', 'noto serif', 'pt serif', 'source serif', 'serif',
];
const MONO = [
  'courier', 'consolas', 'monaco', 'menlo', 'liberation mono', 'dejavu sans mono',
  'lucida console', 'cumberland', 'nimbus mono', 'source code', 'roboto mono', 'monospace',
];

function familyOf(name: string | null): Family | undefined {
  if (!name) return undefined;
  const it = name.toLowerCase();
  if (MONO.some(m => it.includes(m))) return 'mono';
  if (SERIF.some(s => it.includes(s))) return 'serif';
  /* An unrecognised name is not evidence of a sans face, but every remaining
     common one is: Arial, Calibri, Helvetica, Verdana, Tahoma, Segoe, Roboto. */
  return 'sans';
}

/* w:rFonts carries up to four names, one per script. ascii is the Latin one and
   the only one that matters here; hAnsi stands in when a document sets only it,
   which older files do. */
const fontsOf = (rPr: Element | null): Family | undefined => {
  const el = rPr ? own(rPr, 'rFonts') : null;
  if (!el) return undefined;
  return familyOf(attr(el, 'ascii') ?? attr(el, 'hAnsi') ?? attr(el, 'cs'));
};

/** The paragraph properties, likewise. */
interface Marks {
  align?: Align;
  indent?: number;
  firstLine?: number;
  above?: number;
  below?: number;
  numId?: string;
  level?: number;
  outline?: number;
}

const ALIGN: Record<string, Align> = {
  left: 'left', start: 'left',
  center: 'center', centre: 'center',
  right: 'right', end: 'right',
  both: 'justify', justify: 'justify', distribute: 'justify',
};

function hexColour(v: string | null): [number, number, number] | undefined {
  if (!v || v === 'auto' || !/^[0-9a-fA-F]{6}$/.test(v)) return undefined;
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}

function charsOf(rPr: Element | null): Chars {
  if (!rPr) return {};
  const out: Chars = {};
  const family = fontsOf(rPr); if (family) out.family = family;
  const b = flag(rPr, 'b'); if (b !== undefined) out.bold = b;
  const i = flag(rPr, 'i'); if (i !== undefined) out.italic = i;
  const strike = flag(rPr, 'strike'); if (strike !== undefined) out.strike = strike;

  /* Underline is a named style, not a switch: "none" is the way a style turns
     off an underline it inherited. */
  const u = own(rPr, 'u');
  if (u) {
    const val = attr(u, 'val');
    out.underline = val !== null && val !== 'none';
  }

  const size = halfPoints(attr(own(rPr, 'sz'), 'val'));
  if (size !== undefined) out.size = size;

  const colour = hexColour(attr(own(rPr, 'color'), 'val'));
  if (colour) out.colour = colour;
  return out;
}

function marksOf(pPr: Element | null): Marks {
  if (!pPr) return {};
  const out: Marks = {};

  const jc = attr(own(pPr, 'jc'), 'val');
  if (jc && ALIGN[jc]) out.align = ALIGN[jc];

  const ind = own(pPr, 'ind');
  if (ind) {
    /* start/end are the modern names for left/right; files in the wild carry
       either, and a document that uses the new one is not less indented. */
    const left = twips(attr(ind, 'left') ?? attr(ind, 'start'));
    if (left !== undefined) out.indent = left;
    const first = twips(attr(ind, 'firstLine'));
    const hanging = twips(attr(ind, 'hanging'));
    if (hanging !== undefined) out.firstLine = -hanging;
    else if (first !== undefined) out.firstLine = first;
  }

  const spacing = own(pPr, 'spacing');
  if (spacing) {
    const before = twips(attr(spacing, 'before'));
    const after = twips(attr(spacing, 'after'));
    if (before !== undefined) out.above = before;
    if (after !== undefined) out.below = after;
  }

  const num = own(pPr, 'numPr');
  if (num) {
    const id = attr(own(num, 'numId'), 'val');
    const lvl = attr(own(num, 'ilvl'), 'val');
    if (id) out.numId = id;
    out.level = lvl === null ? 0 : Number(lvl) || 0;
  }

  const outline = attr(own(pPr, 'outlineLvl'), 'val');
  if (outline !== null) out.outline = Number(outline);
  return out;
}

/* ── styles ──────────────────────────────────────────────────────────────
 *
 * A style holds both kinds of property and may be based on another, so reading
 * one means walking up the chain. The chain is resolved once per style id and
 * cached: a document of six hundred paragraphs in two styles should walk it
 * twice, not six hundred times. */
interface Style {
  chars: Chars;
  marks: Marks;
  basedOn?: string;
  outline?: number;
}

class Styles {
  private readonly defined = new Map<string, Style>();
  private readonly resolved = new Map<string, {chars: Chars; marks: Marks}>();
  readonly docDefaults: {chars: Chars; marks: Marks} = {chars: {}, marks: {}};
  /** The style a paragraph gets when it names none. */
  private normal = 'Normal';

  constructor(xml: string | null) {
    if (!xml) return;
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.querySelector('parsererror')) return;

    const defaults = doc.getElementsByTagNameNS(W, 'docDefaults').item(0);
    if (defaults) {
      const rDef = defaults.getElementsByTagNameNS(W, 'rPrDefault').item(0);
      const pDef = defaults.getElementsByTagNameNS(W, 'pPrDefault').item(0);
      this.docDefaults.chars = charsOf(rDef ? child(rDef, 'rPr') : null);
      this.docDefaults.marks = marksOf(pDef ? child(pDef, 'pPr') : null);
    }

    for (const s of Array.from(doc.getElementsByTagNameNS(W, 'style'))) {
      const id = attr(s, 'styleId');
      if (!id) continue;
      const style: Style = {
        chars: charsOf(own(s, 'rPr')),
        marks: marksOf(own(s, 'pPr')),
      };
      const based = attr(own(s, 'basedOn'), 'val');
      if (based) style.basedOn = based;
      this.defined.set(id, style);
      if (attr(s, 'default') === '1' && attr(s, 'type') === 'paragraph') this.normal = id;
    }
  }

  /** Properties of a style with everything it inherits already folded in. */
  of(id: string | null): {chars: Chars; marks: Marks} {
    const key = id ?? this.normal;
    const hit = this.resolved.get(key);
    if (hit) return hit;

    /* A basedOn cycle is a corrupt file, and following one is a hung tab. */
    const chain: Style[] = [];
    const seen = new Set<string>();
    let at: string | undefined = key;
    while (at && !seen.has(at)) {
      seen.add(at);
      const style = this.defined.get(at);
      if (!style) break;
      chain.unshift(style);
      at = style.basedOn;
    }

    const out = {chars: {...this.docDefaults.chars}, marks: {...this.docDefaults.marks}};
    for (const style of chain) {
      Object.assign(out.chars, style.chars);
      Object.assign(out.marks, style.marks);
    }
    this.resolved.set(key, out);
    return out;
  }
}

/* ── numbering ───────────────────────────────────────────────────────────
 *
 * The marker is two lookups away: a paragraph names a w:numId, w:num maps that to
 * an abstract list, and the abstract list's level carries the format. Only the
 * bullet formats are drawn as themselves; a numbered list is given its own
 * counter here, because Word's numbering restarts on rules this reader does not
 * model and a wrong number is worse than a plain one. */
class Numbering {
  private readonly abstractOf = new Map<string, string>();
  private readonly levels = new Map<string, Map<number, {format: string; text: string}>>();
  private readonly counters = new Map<string, number>();

  constructor(xml: string | null) {
    if (!xml) return;
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.querySelector('parsererror')) return;

    for (const num of Array.from(doc.getElementsByTagNameNS(W, 'num'))) {
      const id = attr(num, 'numId');
      const abstract = attr(own(num, 'abstractNumId'), 'val');
      if (id && abstract) this.abstractOf.set(id, abstract);
    }

    for (const abstract of Array.from(doc.getElementsByTagNameNS(W, 'abstractNum'))) {
      const id = attr(abstract, 'abstractNumId');
      if (!id) continue;
      const map = new Map<number, {format: string; text: string}>();
      for (const lvl of ownAll(abstract, 'lvl')) {
        const n = Number(attr(lvl, 'ilvl') ?? '0') || 0;
        map.set(n, {
          format: attr(own(lvl, 'numFmt'), 'val') ?? 'bullet',
          text: attr(own(lvl, 'lvlText'), 'val') ?? '•',
        });
      }
      this.levels.set(id, map);
    }
  }

  /** The marker for a list item, or undefined when the list is unknown. */
  marker(numId: string, level: number): string | undefined {
    const abstract = this.abstractOf.get(numId);
    const lvl = abstract ? this.levels.get(abstract)?.get(level) : undefined;
    const format = lvl?.format ?? 'bullet';

    if (format === 'none') return undefined;
    if (format === 'bullet') {
      /* Word writes Wingdings characters for its bullets, which have no meaning
         in a Unicode face: a filled round bullet is what every one of them is
         drawn as on screen anyway. */
      const raw = lvl?.text ?? '•';
      return /^[•●▪■–⁃-]$/.test(raw) ? raw : '•';
    }

    const key = `${numId}:${level}`;
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);
    const body = format === 'lowerLetter' ? letter(next, false)
      : format === 'upperLetter' ? letter(next, true)
      : format === 'lowerRoman' ? roman(next).toLowerCase()
      : format === 'upperRoman' ? roman(next)
      : String(next);
    /* lvlText is a template like "%1." — the placeholder is the only part that
       varies, and the punctuation around it is the document's own. */
    const template = lvl?.text ?? '%1.';
    return template.replace(/%\d/g, body);
  }
}

const letter = (n: number, upper: boolean): string => {
  let out = '';
  let v = n;
  while (v > 0) {
    const r = (v - 1) % 26;
    out = String.fromCharCode((upper ? 65 : 97) + r) + out;
    v = Math.floor((v - 1) / 26);
  }
  return out;
};

const ROMAN: Array<[number, string]> = [
  [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
  [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
];

const roman = (n: number): string => {
  let out = '';
  let v = n;
  for (const [value, sign] of ROMAN) {
    while (v >= value) { out += sign; v -= value; }
  }
  return out;
};

/* ── the document body ───────────────────────────────────────────────────── */

interface Context {
  styles: Styles;
  numbering: Numbering;
  links: Map<string, string>;
}

/** Collect the runs of one paragraph into spans, resolving inherited props. */
function spansOf(p: Element, base: Chars, ctx: Context, link?: string): Span[] {
  const spans: Span[] = [];

  const push = (text: string, chars: Chars, url?: string) => {
    if (!text) return;
    const last = spans[spans.length - 1];
    const span: Span = {text};
    if (chars.family) span.family = chars.family;
    if (chars.bold) span.bold = true;
    if (chars.italic) span.italic = true;
    if (chars.underline) span.underline = true;
    if (chars.strike) span.strike = true;
    if (chars.size !== undefined) span.size = chars.size;
    if (chars.colour) span.colour = chars.colour;
    if (url) span.link = url;

    /* Runs are merged when nothing about them differs. Word splits a sentence
       into a run per spell-check region, and a hundred spans that are all the
       same is a hundred draw calls for one line. */
    if (last && sameLook(last, span)) last.text += text;
    else spans.push(span);
  };

  const walk = (node: Element, chars: Chars, url?: string) => {
    for (const el of Array.from(node.children)) {
      if (el.namespaceURI !== W) {
        /* mc:AlternateContent and the drawing namespaces wrap runs that do
           belong to the text; anything else foreign is walked into rather than
           guessed about. */
        walk(el, chars, url);
        continue;
      }
      const name = el.localName;

      /* A deleted revision is not in the document; its instruction text is
         machinery, not words. */
      if (name === 'del' || name === 'instrText' || name === 'delText') continue;

      if (name === 'r') {
        walk(el, {...chars, ...charsOf(own(el, 'rPr'))}, url);
      } else if (name === 'hyperlink') {
        const id = el.getAttributeNS(R, 'id');
        const target = id ? ctx.links.get(id) : undefined;
        const anchor = attr(el, 'anchor');
        walk(el, chars, target ?? (anchor ? undefined : url));
      } else if (name === 't') {
        push(el.textContent ?? '', chars, url);
      } else if (name === 'tab') {
        /* A tab is a jump to the next stop, and this model has no stops. Two
           spaces read as a gap without pretending to be a column. */
        push('  ', chars, url);
      } else if (name === 'br' || name === 'cr') {
        push('\n', chars, url);
      } else if (name === 'noBreakHyphen') {
        push('‑', chars, url);
      } else if (name === 'softHyphen') {
        continue;
      } else if (name === 'sym') {
        const ch = attr(el, 'char');
        if (ch) push(String.fromCodePoint(parseInt(ch, 16)), chars, url);
      } else {
        walk(el, chars, url);
      }
    }
  };

  walk(p, base, link);
  return spans;
}

const sameLook = (a: Span, b: Span): boolean =>
  a.family === b.family
  && !!a.bold === !!b.bold && !!a.italic === !!b.italic
  && !!a.underline === !!b.underline && !!a.strike === !!b.strike
  && a.size === b.size && a.link === b.link
  && String(a.colour) === String(b.colour);

function paraOf(p: Element, ctx: Context): Para {
  const pPr = own(p, 'pPr');
  const styleId = attr(pPr ? own(pPr, 'pStyle') : null, 'val');
  const style = ctx.styles.of(styleId);

  const marks = {...style.marks, ...marksOf(pPr)};
  /* The paragraph mark's own run properties are the style's, for the paragraph
     as a whole; a run may still override them. */
  const chars = {...style.chars, ...charsOf(pPr ? own(pPr, 'rPr') : null)};

  const para: Para = {spans: spansOf(p, chars, ctx)};
  if (marks.align) para.align = marks.align;
  if (marks.indent) para.indent = marks.indent;
  if (marks.firstLine) para.firstLine = marks.firstLine;
  if (marks.above) para.above = marks.above;
  if (marks.below !== undefined) para.below = marks.below;

  if (marks.numId) {
    const marker = ctx.numbering.marker(marks.numId, marks.level ?? 0);
    if (marker) {
      para.bullet = marker;
      /* A list item without an indent of its own still has to clear its own
         marker, or the bullet is drawn in the margin. */
      if (!para.indent) para.indent = 18 + (marks.level ?? 0) * 18;

      /* Word separates the marker from the text with a tab. The marker is drawn
         from para.bullet here, so that tab has nothing left to separate and
         shows up as a gap at the start of every list item. */
      const lead = para.spans[0];
      if (lead) {
        lead.text = lead.text.replace(/^[\s ]+/, '');
        if (!lead.text) para.spans.shift();
      }
    }
  }
  return para;
}

/* A side is ruled unless it says it is not. `nil` and `none` are the two ways a
   file says "no line here", and both turn up. */
const ruled = (side: Element | null): boolean => {
  if (!side) return false;
  const val = attr(side, 'val');
  return val !== null && val !== 'none' && val !== 'nil';
};

/**
 * Which sides of a cell are ruled.
 *
 * Read from the cell rather than the table, because that is where a document
 * usually puts them: the table-level w:tblBorders is one way to rule a grid, and
 * w:tcBorders on each cell is the other — LibreOffice writes the second, Word
 * writes either. An earlier version of this reader looked only at the table and
 * concluded a fully ruled table had no borders at all.
 */
function bordersOf(tc: Element, fallback: Element | null): Borders | undefined {
  const own_ = own(tc, 'tcPr');
  const source = (own_ ? own(own_, 'tcBorders') : null) ?? fallback;
  if (!source) return undefined;

  const sides = {
    top: own(source, 'top'),
    bottom: own(source, 'bottom'),
    left: own(source, 'left') ?? own(source, 'start'),
    right: own(source, 'right') ?? own(source, 'end'),
  };
  const out: Borders = {};
  if (ruled(sides.top)) out.top = true;
  if (ruled(sides.bottom)) out.bottom = true;
  if (ruled(sides.left)) out.left = true;
  if (ruled(sides.right)) out.right = true;
  if (!out.top && !out.bottom && !out.left && !out.right) return undefined;

  const colour = hexColour(attr(sides.top ?? sides.left ?? sides.bottom ?? sides.right, 'color'));
  if (colour) out.colour = colour;
  return out;
}

function tableOf(tbl: Element, ctx: Context): Table {
  const rows: Cell[][] = [];
  let widths: number[] | undefined;

  const grid = own(tbl, 'tblGrid');
  if (grid) {
    const cols = ownAll(grid, 'gridCol').map(c => twips(attr(c, 'w')) ?? 0);
    if (cols.length && cols.some(w => w > 0)) widths = cols;
  }

  const props = own(tbl, 'tblPr');
  const tblBorders = props ? own(props, 'tblBorders') : null;

  for (const tr of ownAll(tbl, 'tr')) {
    const cells: Cell[] = [];
    for (const tc of ownAll(tr, 'tc')) {
      const paras: Para[] = [];
      for (const el of Array.from(tc.children)) {
        if (el.namespaceURI !== W) continue;
        if (el.localName === 'p') paras.push(paraOf(el, ctx));
        /* A table inside a cell is flattened to its paragraphs: nesting one
           model inside another needs a second layout pass, and a nested table
           is rare enough that its words matter more than its rules. */
        else if (el.localName === 'tbl') {
          for (const row of tableOf(el, ctx).rows) for (const cell of row) paras.push(...cell.paras);
        }
      }
      if (!paras.length) paras.push({spans: []});
      const cell: Cell = {paras};
      const borders = bordersOf(tc, tblBorders);
      if (borders) cell.borders = borders;
      cells.push(cell);
    }
    if (cells.length) rows.push(cells);
  }

  const table: Table = {rows};
  if (widths) table.widths = widths;

  /* The table's own width. `dxa` is twentieths of a point, `pct` is fiftieths of
     a percent of the text column — the two units the format uses for this and
     nothing else. Anything else is left to fill the column. */
  const w = props ? own(props, 'tblW') : null;
  if (w) {
    const type = attr(w, 'type');
    const value = Number(attr(w, 'w'));
    if (Number.isFinite(value) && value > 0) {
      if (type === 'dxa') table.width = value / 20;
      else if (type === 'pct') table.pct = Math.min(1, value / 5000);
    }
  }

  /* Cell padding, from the first side that states one. A table that sets it to
     zero means zero, so an absent value and a zero are not the same thing. */
  const mar = props ? own(props, 'tblCellMar') : null;
  if (mar) {
    const side = own(mar, 'start') ?? own(mar, 'left') ?? own(mar, 'top');
    const pad = twips(attr(side, 'w'));
    if (pad !== undefined) table.pad = pad;
  }
  return table;
}

/** Page geometry from the first section, which is the only one this reader uses. */
function pageOf(body: Element): Pick<RichDoc, 'page' | 'margins'> {
  const sect = body.getElementsByTagNameNS(W, 'sectPr').item(0);
  if (!sect) return {};
  const size = child(sect, 'pgSz');
  const mar = child(sect, 'pgMar');
  const out: Pick<RichDoc, 'page' | 'margins'> = {};

  const w = twips(attr(size, 'w'));
  const h = twips(attr(size, 'h'));
  if (w && h) {
    out.page = attr(size, 'orient') === 'landscape' && w < h
      ? {width: h, height: w}
      : {width: w, height: h};
  }

  const top = twips(attr(mar, 'top'));
  const right = twips(attr(mar, 'right'));
  const bottom = twips(attr(mar, 'bottom'));
  const left = twips(attr(mar, 'left'));
  if (top !== undefined && right !== undefined && bottom !== undefined && left !== undefined) {
    /* Word's own minimum is not zero, and a document saved with a negative
       margin — they exist — would draw off the page. */
    out.margins = {
      top: Math.max(18, top), right: Math.max(18, right),
      bottom: Math.max(18, bottom), left: Math.max(18, left),
    };
  }
  return out;
}

/** Read a .docx into the shared document model. */
export async function docxToModel(bytes: Uint8Array): Promise<RichDoc> {
  const JSZip = (await import('jszip')).default;
  let zip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    return refuse('That file could not be opened. A .docx is a zip archive, and this one '
      + 'does not unpack — an older .doc from before Word 2007 is a different format '
      + 'entirely, and this page reads those too, so the file may simply be damaged.');
  }

  const part = async (name: string): Promise<string | null> => {
    const file = zip.file(name);
    return file ? file.async('string') : null;
  };

  const main = await part('word/document.xml');
  if (main === null) {
    return refuse('That zip is not a Word document — it has no word/document.xml in it.');
  }

  const doc = new DOMParser().parseFromString(main, 'application/xml');
  if (doc.querySelector('parsererror')) refuse('The document markup inside that file is not valid XML.');

  const body = doc.getElementsByTagNameNS(W, 'body').item(0)
    ?? refuse('That Word document has no body in it.');

  /* Relationship targets, for hyperlinks. External links are the only kind this
     model can honour: an internal bookmark has nowhere to point in a PDF built
     without one. */
  const links = new Map<string, string>();
  const rels = await part('word/_rels/document.xml.rels');
  if (rels) {
    const relDoc = new DOMParser().parseFromString(rels, 'application/xml');
    for (const rel of Array.from(relDoc.getElementsByTagName('Relationship'))) {
      const id = rel.getAttribute('Id');
      const target = rel.getAttribute('Target');
      const external = rel.getAttribute('TargetMode') === 'External';
      if (id && target && external) links.set(id, target);
    }
  }

  const ctx: Context = {
    styles: new Styles(await part('word/styles.xml')),
    numbering: new Numbering(await part('word/numbering.xml')),
    links,
  };

  const blocks: Block[] = [];
  for (const el of Array.from(body.children)) {
    if (el.namespaceURI !== W) continue;
    if (el.localName === 'p') blocks.push({para: paraOf(el, ctx)});
    else if (el.localName === 'tbl') blocks.push({table: tableOf(el, ctx)});
  }

  const hasText = blocks.some(b => 'para' in b
    ? b.para.spans.some(s => s.text.trim())
    : b.table.rows.some(r => r.some(c => c.paras.some(p => p.spans.some(s => s.text.trim())))));
  if (!hasText) {
    refuse('That document has no text in it. If its content is images, convert those '
      + 'to PDF instead.');
  }

  return {blocks, ...pageOf(body)};
}

export async function docxToPdf(bytes: Uint8Array): Promise<Blob> {
  return richDocToPdf(await docxToModel(bytes));
}
