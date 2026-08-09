import type {PDFPageProxy} from './pdfjs';
/* With the explicit extension, because tools/blocks-test.mts runs this file
   straight through Node's type stripping, and Node resolves nothing for us. */
import {registerDocFace} from './docFonts.ts';

/* Finding the paragraphs.
 *
 * A PDF has no paragraphs. It has instructions to put ink at coordinates, and
 * whatever structure a reader perceives is something they reconstruct from
 * where the ink landed. Everything an editor can offer — click a paragraph and
 * type into it — rests on guessing that structure back, and guessing it the way
 * the person who wrote the document would have drawn the boxes themselves.
 *
 * This is why the editor has been getting it wrong. Asking the user to drag a
 * rectangle round the text they mean makes the rectangle the unit of editing,
 * and a rectangle knows nothing: it cuts a paragraph in half, it takes half of
 * one column and half of the next, it has no idea which of the words inside it
 * were bold. Every one of those defects is the same defect. Find the block
 * first and they stop being possible rather than being fixed one at a time.
 *
 * Nothing here touches the DOM or the file. It reads a page and returns a
 * description of it, which is what makes the thresholds below testable against
 * a corpus rather than against an opinion. */

export interface Run {
  text: string;
  /** pdf.js's key for the face, e.g. "g_d0_f1". Meaningless outside the page. */
  fontKey: string;
  /** The face's real name, subset prefix stripped: "OpenSans-Bold". */
  face: string;
  size: number;
  bold: boolean;
  italic: boolean;
  /** Left edge and width in page points, as the file reports them. */
  x: number;
  w: number;
}

export interface Line {
  runs: Run[];
  /** Distance from the top of the page down to the baseline, in points. */
  baseline: number;
  x0: number;
  x1: number;
  /** The size most of the line is set in. */
  size: number;
  get text(): string;
}

export type Align = 'left' | 'center' | 'right' | 'justify';

export interface Block {
  id: string;
  page: number;
  /* Top-left origin, page points — the convention the whole editor uses. Only
     burn.ts knows the file counts from the bottom. */
  x: number;
  y: number;
  w: number;
  h: number;
  lines: Line[];
  align: Align;
  /** Baseline-to-baseline distance. Falls back to 1.2× size on a single line. */
  leading: number;
  /** Degrees clockwise on screen. Non-zero blocks never merge with anything. */
  angle: number;
}

/* Every threshold in one place, because each of them is a guess that survived
   contact with a corpus rather than a fact, and the next document may move it.
   The comments say what breaks when a number is wrong in each direction. */
export const TUNING = {
  /** Gap that reads as a word space, as a fraction of the type size.
   *  Too low: spaces appear inside words. Too high: words run together. */
  spaceGap: 0.18,
  /** Gap too wide to be a space — a column boundary or a tab stop.
   *  Too low: an indented sentence is torn in two. Too high: the two columns
   *  of a table are read as one line and can never be edited apart. */
  columnGap: 1.6,
  /** How far two baselines may differ and still be one line, × the size. */
  sameLine: 0.35,
  /** Baseline-to-baseline gap that still reads as the next line of the same
   *  paragraph, × the paragraph's median line height. Too low: every paragraph
   *  becomes one block per line. Too high: a heading is swallowed by the
   *  paragraph under it. */
  lineGap: 1.65,
  /** How much of the narrower line must sit under the wider one.
   *  This is the one that separates the columns of a table, and the reason a
   *  label column and a value column stay editable separately. */
  overlap: 0.4,
  /** Relative size change that forces a new block: a heading is not its body. */
  sizeJump: 0.2,
  /** How close two edges must be, in ems, to count as deliberately aligned. */
  edgeSlack: 1.5,
  /** Breathing room round the frame so it does not clip the letters. */
  pad: 1.5,
};

let seq = 0;
const nextId = (): string => `blk${++seq}`;

/* pdf.js names subset fonts the way the file does — six capitals and a plus.
   "BCDEEE+Calibri-Bold" is Calibri Bold and should say so in a font menu. */
const cleanFace = (raw: string): string => raw.replace(/^[A-Z]{6}\+/, '');

const isBold = (face: string): boolean =>
  /bold|black|heavy|semib|demi|[-_,](6|7|8|9)00\b/i.test(face);
const isItalic = (face: string): boolean => /italic|oblique/i.test(face);

/* One reading per page, ever.
 *
 * Blocks are a pure function of the page, and reading them costs an operator
 * list, a text walk and the grouping — real work. The viewer rebuilds all of
 * its layers on every zoom, and before this cache each rebuild re-derived the
 * same blocks from scratch; a burst of Ctrl+wheel events meant doing that a
 * dozen times per page while the main thread was already busy repainting,
 * which is the stall the renderer was blamed for. Keyed by the page proxy, so
 * a new document (new proxies) starts clean — and, usefully, the ids inside
 * stay stable across rebuilds, which is what lets the record of edited
 * paragraphs survive a zoom. */
const perPage = new WeakMap<PDFPageProxy, Promise<Block[]>>();

export function getBlocks(page: PDFPageProxy, pageNo: number): Promise<Block[]> {
  let pending = perPage.get(page);
  if (!pending) {
    pending = readBlocks(page, pageNo);
    pending.catch(() => perPage.delete(page));
    perPage.set(page, pending);
  }
  return pending;
}

/** Every paragraph pdf.js can see on one page, in reading order. */
async function readBlocks(page: PDFPageProxy, pageNo: number): Promise<Block[]> {
  /* The operator list is what fills commonObjs, and commonObjs is the only
     place the real font name lives — getTextContent reports every face as
     "sans-serif", which is why weight detection kept failing. */
  try { await page.getOperatorList(); } catch { /* names stay unknown */ }

  let content;
  try { content = await page.getTextContent(); } catch { return []; }

  const pageH = page.getViewport({scale: 1}).height;
  const faceOf = (key: string): string => {
    try {
      const info = (page.commonObjs as {has(k: string): boolean; get(k: string): unknown})
        .has(key) ? page.commonObjs.get(key) : null;
      const name = cleanFace(String((info as {name?: string} | null)?.name ?? ''));
      /* Seen once, remembered for the whole session: the name for the font
         menu, the key the browser already renders with, and the sanitised
         bytes so the export can embed the genuine face instead of a stand-in. */
      const bytes = (info as {data?: Uint8Array} | null)?.data ?? null;
      if (name) registerDocFace(name, key, bytes && bytes.length ? bytes : null);
      return name;
    } catch { return ''; }
  };

  type Piece = Run & {baseline: number; angle: number};
  const pieces: Piece[] = [];

  for (const item of content.items) {
    if (!('str' in item) || !item.str || !item.str.trim()) continue;
    const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = item.transform as number[];
    const size = Math.hypot(c, d) || Math.abs(d) || 10;
    const face = faceOf(item.fontName as string);
    pieces.push({
      text: item.str,
      fontKey: String(item.fontName ?? ''),
      face,
      size,
      bold: isBold(face),
      italic: isItalic(face),
      x: e,
      w: item.width || Math.hypot(a, b) * item.str.length * 0.5,
      baseline: pageH - f,
      angle: -Math.atan2(b, a) * 180 / Math.PI,
    });
  }

  if (!pieces.length) return [];

  /* Sideways text — the vertical note down the margin of a tax form — is its
     own block and merges with nothing. Reading order does not apply to it and
     neither do the horizontal rules below. */
  const upright = pieces.filter(p => Math.abs(p.angle) < 0.5);
  const turned = pieces.filter(p => Math.abs(p.angle) >= 0.5);

  const lines = toLines(upright);
  const blocks = toBlocks(lines, pageNo);

  for (const p of turned) {
    const line = makeLine([p]);
    blocks.push(finish([line], pageNo, p.angle));
  }

  /* Reading order, so Tab walks the page the way a person would. */
  blocks.sort((m, n) => m.y - n.y || m.x - n.x);
  return blocks;
}

/* ── pieces into lines ─────────────────────────────────────────────────────
 * Two things happen at once here, and they have to: the pieces on one baseline
 * are joined into a line, and the same pass decides where a gap is too wide to
 * be a space. That second decision is what keeps the label column of a table
 * from being glued to the value column — pdf.js reports them as neighbours on
 * the same baseline, and only the size of the gap says otherwise. */
function toLines(pieces: Array<Run & {baseline: number}>): Line[] {
  const rows: Array<Array<Run & {baseline: number}>> = [];

  for (const p of [...pieces].sort((m, n) => m.baseline - n.baseline || m.x - n.x)) {
    const row = rows.find(r => {
      const q = r[0]!;
      return Math.abs(q.baseline - p.baseline) < TUNING.sameLine * Math.max(q.size, p.size);
    });
    if (row) row.push(p); else rows.push([p]);
  }

  const out: Line[] = [];
  for (const row of rows) {
    row.sort((m, n) => m.x - n.x);
    const spaceAt = spaceThreshold(row);
    let run: Array<Run & {baseline: number}> = [];

    for (const p of row) {
      const prev = run[run.length - 1];
      if (prev) {
        const gap = p.x - (prev.x + prev.w);
        const em = Math.max(prev.size, p.size);
        if (gap > TUNING.columnGap * em) {
          /* Not a space. Close the line here and start another one on the same
             baseline — they will be offered to the block grouper separately. */
          out.push(makeLine(run));
          run = [];
        } else if (gap > spaceAt * em && !/\s$/.test(prev.text) && !/^\s/.test(p.text)) {
          /* pdf.js often encodes a space as a horizontal shift rather than as a
             character, which is why replacing a word used to eat the space
             beside it. Putting it back here means the editor sees the text the
             reader sees. */
          prev.text += ' ';
          prev.w += gap;
        }
      }
      run.push(p);
    }
    if (run.length) out.push(makeLine(run));
  }

  return out.sort((m, n) => m.baseline - n.baseline || m.x0 - n.x0);
}

/* How wide a gap has to be, on this line, before it means a space.
 *
 * A fixed fraction of the type size works for prose and fails on a tracked
 * heading. "0 2 / E X P E R I E N C E" is one word set with wide letter
 * spacing; pdf.js hands it over one letter at a time, every letter separated by
 * more than a fifth of an em, and a fixed threshold dutifully puts a space
 * between all of them. Click that block to edit it and you are editing gibberish.
 *
 * The tell is that on a tracked line *most* gaps look like spaces, which is
 * never true of ordinary text. So the line's own typical gap sets the bar:
 * where tracking is wide, only a gap clearly wider than the tracking counts. */
function spaceThreshold(row: Array<Run & {baseline: number}>): number {
  if (row.length < 5) return TUNING.spaceGap;

  /* The tell is not the size of the gaps — a line with a "·" separator has wide
     gaps too, and raising the bar there swallows real spaces. The tell is that
     the typesetter has handed over one letter at a time. Ordinary text arrives
     in words and phrases; only tracking produces a row of single characters. */
  const singles = row.filter(p => p.text.trim().length === 1).length;
  if (singles / row.length < 0.6) return TUNING.spaceGap;

  const ratios: number[] = [];
  for (let i = 1; i < row.length; i++) {
    const prev = row[i - 1]!;
    const gap = row[i]!.x - (prev.x + prev.w);
    const em = Math.max(prev.size, row[i]!.size);
    /* Column-sized gaps are excluded: two columns share a baseline, and one of
       those gaps in the sample would drag the typical value up and cost the
       line every one of its real spaces. */
    if (gap > 0 && em > 0 && gap / em < TUNING.columnGap) ratios.push(gap / em);
  }
  if (!ratios.length) return TUNING.spaceGap;

  ratios.sort((m, n) => m - n);
  const typical = ratios[Math.floor((ratios.length - 1) / 2)]!;
  if (typical <= TUNING.spaceGap) return TUNING.spaceGap;

  /* Half again as wide as the tracking. On a tracked line the word spaces do
     stand out, but not by much, so the margin has to be modest. */
  return Math.min(typical * 1.45, TUNING.columnGap * 0.9);
}

function makeLine(runs: Array<Run & {baseline: number}>): Line {
  const first = runs[0]!;
  const x1 = Math.max(...runs.map(r => r.x + r.w));
  /* The dominant size, not the largest: a footnote marker must not make the
     whole line count as bigger type and split the paragraph. */
  const sizes = runs.map(r => r.size).sort((m, n) => m - n);
  return {
    runs: runs.map(({baseline: _b, ...r}) => r),
    baseline: first.baseline,
    x0: Math.min(...runs.map(r => r.x)),
    x1,
    size: sizes[Math.floor((sizes.length - 1) / 2)]!,
    get text() { return this.runs.map(r => r.text).join(''); },
  };
}

/* ── lines into blocks ─────────────────────────────────────────────────────
 * A line joins the block above it only if all four tests pass. Any one of them
 * failing starts a new block, and each guards against a different way of being
 * wrong — vertical distance against merging a heading into its body, horizontal
 * overlap against merging two columns, size against merging two levels of
 * heading, alignment against merging a centred title into left-aligned prose. */
function toBlocks(lines: Line[], pageNo: number): Block[] {
  const out: Block[] = [];
  let group: Line[] = [];

  const flush = () => { if (group.length) out.push(finish(group, pageNo, 0)); group = []; };

  for (const line of lines) {
    if (!group.length) { group = [line]; continue; }
    if (joins(group, line)) group.push(line); else { flush(); group = [line]; }
  }
  flush();
  return out;
}

/* A line that announces itself as a new item: a dash, a bullet, or a number
   followed by a stop. Every list in the corpus otherwise came out as one tall
   block covering the whole list, which is the opposite of useful — you want to
   click one bullet and rewrite it, not inherit six. */
const BULLET = /^\s*(?:[-–—•·*‣▪◦]|\(?\d{1,3}[.)])\s*\S/;

function joins(group: Line[], next: Line): boolean {
  const last = group[group.length - 1]!;

  /* 0. a new list item is a new block, however tidily it lines up */
  if (BULLET.test(next.text)) return false;

  /* 1. vertical distance */
  const heights = group.length > 1
    ? group.slice(1).map((l, i) => l.baseline - group[i]!.baseline)
    : [last.size * 1.2];
  const typical = heights.slice().sort((m, n) => m - n)[Math.floor((heights.length - 1) / 2)]!;
  const gap = next.baseline - last.baseline;
  if (gap <= 0 || gap > TUNING.lineGap * typical) return false;

  /* 2. horizontal overlap — the test that keeps table columns apart */
  const left = Math.max(last.x0, next.x0);
  const right = Math.min(last.x1, next.x1);
  const shared = right - left;
  const narrower = Math.min(last.x1 - last.x0, next.x1 - next.x0);
  if (narrower <= 0 || shared / narrower < TUNING.overlap) return false;

  /* 3. type size */
  if (Math.abs(last.size - next.size) / Math.max(last.size, next.size) > TUNING.sizeJump) {
    return false;
  }

  /* 4. a shared edge. Prose keeps one of its margins straight; two lines that
        agree on neither are two different things that happen to be near each
        other. Centred text agrees on its axis instead. */
  const slack = TUNING.edgeSlack * Math.max(last.size, next.size);
  const sameLeft = Math.abs(last.x0 - next.x0) < slack;
  const sameRight = Math.abs(last.x1 - next.x1) < slack;
  const sameAxis = Math.abs((last.x0 + last.x1) / 2 - (next.x0 + next.x1) / 2) < slack;
  return sameLeft || sameRight || sameAxis;
}

function finish(lines: Line[], pageNo: number, angle: number): Block {
  const x0 = Math.min(...lines.map(l => l.x0));
  const x1 = Math.max(...lines.map(l => l.x1));
  const size = lines[0]!.size;

  const gaps = lines.slice(1).map((l, i) => l.baseline - lines[i]!.baseline);
  const leading = gaps.length
    ? gaps.reduce((n, g) => n + g, 0) / gaps.length
    : size * 1.2;

  /* The box has to clear the letters, not the baselines: ascenders rise above
     the first baseline and descenders fall below the last. */
  const top = lines[0]!.baseline - size * 0.92 - TUNING.pad;
  const bottom = lines[lines.length - 1]!.baseline + size * 0.28 + TUNING.pad;

  return {
    id: nextId(),
    page: pageNo,
    x: x0 - TUNING.pad,
    y: top,
    w: x1 - x0 + TUNING.pad * 2,
    h: bottom - top,
    lines,
    align: alignOf(lines),
    leading,
    angle,
  };
}

function alignOf(lines: Line[]): Align {
  if (lines.length === 1) return 'left';
  const slack = TUNING.edgeSlack * lines[0]!.size;
  const spread = (ns: number[]) => Math.max(...ns) - Math.min(...ns);

  const flushLeft = spread(lines.map(l => l.x0)) < slack;
  /* The last line of a justified paragraph is short by design, so it is left
     out of the right-edge test — including it would call every justified
     paragraph left-aligned. */
  const body = lines.length > 2 ? lines.slice(0, -1) : lines;
  const flushRight = spread(body.map(l => l.x1)) < slack;
  const centred = spread(lines.map(l => (l.x0 + l.x1) / 2)) < slack;

  if (flushLeft && flushRight && lines.length > 1) return 'justify';
  if (centred && !flushLeft) return 'center';
  if (flushRight && !flushLeft) return 'right';
  return 'left';
}
