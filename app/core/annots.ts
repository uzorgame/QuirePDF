/* The annotation model.
 *
 * Everything is stored in PDF points with the origin at the TOP-LEFT of the
 * page, which is the opposite of PDF's own bottom-left origin. That is a
 * deliberate choice: every pointer event, every CSS position and every canvas
 * coordinate in the browser is top-left, so keeping the model in the browser's
 * frame means exactly one flip — at the moment of writing the file — instead of
 * a conversion at every interaction. The flip lives in burn.ts and nowhere else.
 *
 * Nothing here knows about the DOM or about pdf-lib. The overlay reads it, the
 * writer reads it, and neither can quietly change the other's assumptions. */

export type ToolId =
  | 'select' | 'text' | 'edit-text' | 'draw' | 'eraser' | 'highlight'
  | 'shape' | 'image' | 'link' | 'sign' | 'stamp' | 'redact' | 'field' | 'crop';

/* The fourteen faces every PDF reader has built in. Using one of these means
   the file carries no font of its own and looks the same everywhere; anything
   else has to be embedded, which is the same work that will one day let this
   handle Cyrillic. */
export type FontId =
  | 'helvetica' | 'helvetica-bold' | 'helvetica-oblique' | 'helvetica-boldoblique'
  | 'times' | 'times-bold' | 'times-italic' | 'times-bolditalic'
  | 'courier' | 'courier-bold' | 'courier-oblique' | 'courier-boldoblique'
  | 'symbol' | 'zapf';

export const CSS_FONT: Record<FontId, string> = {
  'helvetica': 'Helvetica, Arial, sans-serif',
  'helvetica-bold': 'Helvetica, Arial, sans-serif',
  'helvetica-oblique': 'Helvetica, Arial, sans-serif',
  'helvetica-boldoblique': 'Helvetica, Arial, sans-serif',
  'times': "'Times New Roman', Times, serif",
  'times-bold': "'Times New Roman', Times, serif",
  'times-italic': "'Times New Roman', Times, serif",
  'times-bolditalic': "'Times New Roman', Times, serif",
  'courier': "'Courier New', Courier, monospace",
  'courier-bold': "'Courier New', Courier, monospace",
  'courier-oblique': "'Courier New', Courier, monospace",
  'courier-boldoblique': "'Courier New', Courier, monospace",
  'symbol': 'Symbol, serif',
  'zapf': "'Zapf Dingbats', serif",
};
/* Bold and italic are not exclusive, and the fourteen have a cut for both. The
   list used to stop at one or the other, so asking for bold on an italic run
   silently dropped the slope — the toolbar showed both pressed and the file got
   one of them. */
export const isBold = (f: FontId) => f.endsWith('-bold') || f.endsWith('bolditalic') || f.endsWith('boldoblique');
export const isItalic = (f: FontId) => f.endsWith('-oblique') || f.endsWith('-italic')
  || f.endsWith('bolditalic') || f.endsWith('boldoblique');

export interface Pt { x: number; y: number }

interface Base {
  id: string;
  page: number;      // 1-based
}

/** Freehand strokes: the pen, the highlighter and a drawn signature. */
export interface InkAnnot extends Base {
  kind: 'ink';
  variant: 'draw' | 'highlight' | 'sign';
  pts: Pt[];
  color: string;
  width: number;
}

/* Text markup: the four things you do to words you have selected.
 *
 * Stored as the rectangles the selection covered rather than as a character
 * range, because a range is only meaningful against the exact text extraction
 * that produced it — reopen the file in another reader and the offsets mean
 * something else. Rectangles are what the PDF format itself stores for these
 * (QuadPoints), so this is also the shape the writer needs. */
export interface MarkAnnot extends Base {
  kind: 'mark';
  variant: 'highlight' | 'strike' | 'underline' | 'squiggle';
  rects: Array<{x: number; y: number; w: number; h: number}>;
  color: string;
}

export interface ShapeAnnot extends Base {
  kind: 'shape';
  variant: 'rect' | 'ellipse' | 'line' | 'arrow';
  a: Pt;
  b: Pt;
  color: string;
  width: number;
  filled: boolean;
}

export interface TextAnnot extends Base {
  kind: 'text';
  at: Pt;
  w: number;
  text: string;
  size: number;
  color: string;
  font: FontId;
  /* The document's own typeface, by clean name, when the text came out of the
     page rather than out of the toolbar. The standard `font` stays as the
     fallback for readers of old sessions and for faces whose bytes pdf.js
     could not hand over. */
  face?: string;
  /* A floor, not a ceiling. Dragging the bottom of a box sets it, and the box
     keeps that height even when the words do not fill it — but typing past it
     still grows the box rather than hiding the overflow. A text box that can
     swallow what you typed is worse than one that changes shape. */
  minH?: number;
  /* Set when the box was created by Edit text — it then also paints over what
     was underneath, because you are replacing words rather than adding them. */
  cover?: {a: Pt; b: Pt};
  /* What to paint the cover in. Sampled from the page when Edit text opens a
     paragraph, because a white patch on tinted paper is its own defect. */
  coverColor?: string;
  /* This run is one line and stays one line.
   *
   * A paragraph rewritten in Edit text arrives already broken into lines: the
   * browser did the wrapping, in the document's own face, and each line came
   * back as its own run. Wrapping it a second time can only disagree, because
   * the second opinion is formed in a different typeface — and it did. A name
   * set in Segoe UI Black is wider than the same name in Arial, so the box
   * measured on screen was too narrow for the words it already held, and
   * "Mykhailo Nahreba" came back out of a move as two lines. */
  nowrap?: boolean;
  /* Extra advance per character, in page units. Carried over from Edit text,
     where the run was stretched or squeezed to the width the file says it was
     printed at. Written out as the PDF's own character spacing. */
  tracking?: number;
  /* Distance from at.y down to the first baseline, in page units, as the
   * browser laid it out.
   *
   * Where a baseline sits under the top of a line is a fact about the face —
   * its ascent — and not a constant. The writer used to guess it at 1.02 of the
   * type size; no face has that ascent, and Helvetica's 0.91 meant every
   * rewritten paragraph was written a tenth of a size below the words it
   * replaced. Measured on screen and carried, the guess is not needed. */
  lead?: number;
  /* The advance the run was measured at on screen, in page units. The writer
     fits its own character spacing to this rather than trusting a width the
     browser predicted for a face it cannot see. */
  ink?: number;
}

export interface ImageAnnot extends Base {
  kind: 'image';
  variant: 'image' | 'sign';
  at: Pt;
  w: number;
  h: number;
  /** data: URL. Held in memory only; nothing is uploaded. */
  src: string;
}

export interface StampAnnot extends Base {
  kind: 'stamp';
  at: Pt;
  label: string;
  color: string;
}

/** Rectangular regions whose meaning is in what they do, not how they look. */
export interface RegionAnnot extends Base {
  kind: 'region';
  variant: 'redact' | 'link' | 'field' | 'crop';
  a: Pt;
  b: Pt;
  url?: string;
  fieldName?: string;
  fieldType?: 'text' | 'check';
}

export type Annot = InkAnnot | MarkAnnot | ShapeAnnot | TextAnnot | ImageAnnot | StampAnnot | RegionAnnot;

export const rectOf = (a: Pt, b: Pt) => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  w: Math.abs(b.x - a.x),
  h: Math.abs(b.y - a.y),
});

/** Bounding box in page points, used for selection, hit-testing and handles. */
export function boundsOf(an: Annot): {x: number; y: number; w: number; h: number} {
  switch (an.kind) {
    case 'ink': {
      const xs = an.pts.map(p => p.x), ys = an.pts.map(p => p.y);
      const pad = an.width / 2;
      return {
        x: Math.min(...xs) - pad, y: Math.min(...ys) - pad,
        w: Math.max(...xs) - Math.min(...xs) + pad * 2,
        h: Math.max(...ys) - Math.min(...ys) + pad * 2,
      };
    }
    case 'shape':
    case 'region':
      return rectOf(an.a, an.b);
    case 'text':
      /* Height is estimated from the line count rather than measured — the
         model must not depend on a DOM being present to describe itself. */
      return {
        x: an.at.x, y: an.at.y, w: an.w,
        h: Math.max(lineCount(an) * an.size * 1.3 + 6, an.minH ?? 0),
      };
    case 'mark': {
      /* The union of the lines it covers. A selection that wraps is several
         rectangles, and the box round them is what a click has to hit. */
      const xs = an.rects.map(r => r.x), ys = an.rects.map(r => r.y);
      const x = Math.min(...xs), y = Math.min(...ys);
      return {
        x, y,
        w: Math.max(...an.rects.map(r => r.x + r.w)) - x,
        h: Math.max(...an.rects.map(r => r.y + r.h)) - y,
      };
    }
    case 'image':
      return {x: an.at.x, y: an.at.y, w: an.w, h: an.h};
    case 'stamp':
      return {x: an.at.x, y: an.at.y, w: stampWidth(an.label), h: STAMP_HEIGHT};
  }
}

/* A stamp sizes itself from its label. The arithmetic lives here so the
   overlay, the hit test and the writer cannot disagree about how big it is. */
/* A marker is opaque enough to see and transparent enough to read through.
   Shared by the overlay and the writer so screen and file agree. */
export const HIGHLIGHT_ALPHA = 0.55;

export const STAMP_HEIGHT = 26;
export const STAMP_SIZE = 11;
export const stampWidth = (label: string) => Math.max(78, label.length * STAMP_SIZE * 0.62 + 26);

export function lineCount(an: TextAnnot): number {
  return Math.max(1, an.text.split('\n').length);
}

/* An arrowhead, in the same top-left points as everything else here.
 *
 * Worked out once rather than twice. The screen and the writer each had their
 * own copy of this trigonometry, and the writer's mixed flipped and unflipped
 * coordinates in a way that only happened to come out right — so the two could
 * never be adjusted together, and neither could be read.
 *
 * Two things made the old head look blunt. The shaft ran the whole way to the
 * point with a round cap, so half a stroke width of it bulged out past the tip;
 * and the head was a wide, short wedge — a hundred degrees at the point, which
 * is a delta, not an arrow. Here the shaft stops inside the head, and the head
 * is long enough against its base to come to a proper point (about thirty-eight
 * degrees). A stubby arrow keeps its shape rather than growing a head longer
 * than itself. */
export function arrowHead(a: Pt, b: Pt, width: number): {
  tip: Pt; left: Pt; right: Pt; shaftEnd: Pt;
} {
  const dx = b.x - a.x, dy = b.y - a.y;
  const span = Math.hypot(dx, dy) || 1;
  const ux = dx / span, uy = dy / span;

  /* Long enough to read at a hairline, never longer than the arrow itself. */
  const len = Math.min(span * 0.9, Math.max(9, width * 4));
  const half = len * 0.34;

  const baseX = b.x - ux * len, baseY = b.y - uy * len;
  return {
    tip: {x: b.x, y: b.y},
    left: {x: baseX - uy * half, y: baseY + ux * half},
    right: {x: baseX + uy * half, y: baseY - ux * half},
    /* Short of the base, so the shaft's own round cap stays under the head
       instead of showing as a stub beside the point. */
    shaftEnd: {x: b.x - ux * len * 0.82, y: b.y - uy * len * 0.82},
  };
}

export function moveBy(an: Annot, dx: number, dy: number): void {
  switch (an.kind) {
    case 'ink':   for (const p of an.pts) { p.x += dx; p.y += dy; } break;
    case 'shape':
    case 'region': an.a.x += dx; an.a.y += dy; an.b.x += dx; an.b.y += dy; break;
    /* The patch stays behind. It covers the words being replaced, and those do
       not move — dragging the replacement to sit better on the line used to
       take the patch with it, which uncovered the original and blanked out
       whatever the box had been nudged over instead. */
    case 'text':  an.at.x += dx; an.at.y += dy; break;
    case 'mark':  for (const r of an.rects) { r.x += dx; r.y += dy; } break;
    case 'image':
    case 'stamp': an.at.x += dx; an.at.y += dy; break;
  }
}

/* Which way a handle pulls. The letters are the compass points of the box, so
   'nw' is the top-left corner and 'e' the right edge; an empty string in either
   axis means that axis does not move. */
export type Edge = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

const PULL: Record<Edge, {x: -1 | 0 | 1; y: -1 | 0 | 1}> = {
  nw: {x: -1, y: -1}, n: {x: 0, y: -1}, ne: {x: 1, y: -1}, e: {x: 1, y: 0},
  se: {x: 1, y: 1}, s: {x: 0, y: 1}, sw: {x: -1, y: 1}, w: {x: -1, y: 0},
};

export interface Rect {x: number; y: number; w: number; h: number}

/* The rectangle a handle drag produces.
 *
 * Each edge moves only the side it belongs to, so dragging the left edge
 * changes x and w and leaves the right side where it was. The minimums are
 * applied by pinning the opposite side rather than by clamping the width,
 * which is what stops a box turning inside out when you drag past it: pull the
 * left edge far enough right and it stops at the minimum instead of continuing
 * on to become a box with the sides swapped. */
export function dragEdge(
  start: Rect, edge: Edge, dx: number, dy: number, min: {w: number; h: number},
): Rect {
  const pull = PULL[edge];
  let {x, y, w, h} = start;

  if (pull.x < 0) { const right = x + w; x = Math.min(x + dx, right - min.w); w = right - x; }
  else if (pull.x > 0) { w = Math.max(min.w, w + dx); }

  if (pull.y < 0) { const bottom = y + h; y = Math.min(y + dy, bottom - min.h); h = bottom - y; }
  else if (pull.y > 0) { h = Math.max(min.h, h + dy); }

  return {x, y, w, h};
}

/** Puts an annotation into a rectangle. Ink and stamps keep their own size. */
export function setBounds(an: Annot, r: Rect): void {
  switch (an.kind) {
    case 'shape':
    case 'region':
      an.a = {x: r.x, y: r.y};
      an.b = {x: r.x + r.w, y: r.y + r.h};
      break;
    case 'image':
      an.at = {x: r.x, y: r.y}; an.w = r.w; an.h = r.h;
      break;
    case 'text':
      an.at = {x: r.x, y: r.y}; an.w = r.w; an.minH = r.h;
      break;
    default:
      break;
  }
}

/** The smallest a mark is allowed to get. Text needs room for a word. */
export function minSize(an: Annot): {w: number; h: number} {
  return an.kind === 'text' ? {w: 40, h: an.size * 1.3 + 6} : {w: 12, h: 12};
}

let seq = 0;
export const nextId = () => `a${++seq}`;

/* ── the store ────────────────────────────────────────────────────────── */

export class AnnotStore {
  private items: Annot[] = [];
  private listeners = new Set<(pages: Set<number>) => void>();

  onChange(fn: (pages: Set<number>) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(...pages: number[]): void {
    const set = new Set(pages);
    for (const fn of this.listeners) fn(set);
  }

  get all(): readonly Annot[] { return this.items; }
  get count(): number { return this.items.length; }

  byPage(page: number): Annot[] {
    return this.items.filter(a => a.page === page);
  }

  find(id: string): Annot | undefined {
    return this.items.find(a => a.id === id);
  }

  add(an: Annot): Annot {
    this.items.push(an);
    this.emit(an.page);
    return an;
  }

  remove(id: string): void {
    const i = this.items.findIndex(a => a.id === id);
    if (i < 0) return;
    const [gone] = this.items.splice(i, 1);
    this.emit(gone!.page);
  }

  touch(id: string): void {
    const an = this.find(id);
    if (an) this.emit(an.page);
  }

  clear(): void {
    const pages = new Set(this.items.map(a => a.page));
    this.items = [];
    this.emit(...pages);
  }

  /** Replaces everything at once, for undo and redo. */
  load(items: Annot[]): void {
    const before = this.items.map(a => a.page);
    this.items = items;
    this.emit(...before, ...items.map(a => a.page));
  }

  /* Page numbers shift when pages are inserted, removed or reordered, and an
     annotation pinned to a number that no longer means the same page is worse
     than one that is deleted — it silently lands on someone else's document. */
  remap(fn: (page: number) => number | null): void {
    const before = new Set(this.items.map(a => a.page));
    this.items = this.items.flatMap(a => {
      const next = fn(a.page);
      if (next === null) return [];
      a.page = next;
      return [a];
    });
    this.emit(...before, ...this.items.map(a => a.page));
  }

  /** Topmost annotation whose bounds contain the point, for select and erase. */
  hit(page: number, p: Pt): Annot | null {
    const here = this.byPage(page);
    for (let i = here.length - 1; i >= 0; i--) {
      const an = here[i]!;
      const b = boundsOf(an);
      if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) return an;
    }
    return null;
  }
}
