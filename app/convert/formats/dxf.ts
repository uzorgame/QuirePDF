/* AutoCAD DXF, drawn onto a page.
 *
 * DXF is a stream of group codes: one line holding a number, the next holding
 * its value, forever. The ENTITIES section is the drawing; BLOCKS holds the
 * reusable pieces that INSERT stamps out, and in practice most of a real
 * drawing lives there rather than in ENTITIES — a reader that ignores blocks
 * renders half the files in the world as an empty page.
 *
 * What comes out is a printed drawing, not a CAD file: one ink colour, one pen
 * width, scaled to fit a sheet. Anything that cannot honestly be drawn is
 * counted and named in the page margin rather than quietly dropped, because a
 * drawing that is missing a wall and does not say so is worse than one that
 * admits it.
 */
import {
  PDFDocument, StandardFonts, rgb, degrees,
  LineCapStyle, LineJoinStyle,
  pushGraphicsState, popGraphicsState, setStrokingColor, setFillingColor,
  setLineWidth, setLineCap, setLineJoin,
  moveTo, lineTo, appendBezierCurve, closePath, stroke, fill,
} from 'pdf-lib';
import type {PDFFont, PDFOperator, PDFPage} from 'pdf-lib';
import {Refused} from '../heavy.ts';
import {needsUnicode, unicodeFont} from '../../core/unicodeFont.ts';

const refuse = (m: string): never => { throw new Refused(m); };

/* ── the sheet ────────────────────────────────────────────────────────── */

const A4 = {w: 595.28, h: 841.89};
const MARGIN = 36;

/* One ink for everything. DXF colours are an index into a palette whose
   seventh entry — the default, and the colour of most of every drawing — means
   "white on black, black on white", because CAD is drawn on a dark screen and
   plotted on paper. Carrying the palette across literally would put white
   lines on a white page. */
const INK = rgb(0.09, 0.11, 0.15);

/* And one pen. Lineweight in DXF is a per-layer property almost always left at
   BYLAYER with no value anywhere in the file; a plotter handed that draws
   every line with its thinnest pen, which is what this is. */
const HAIRLINE = 0.5;

/* Cap height as a fraction of the em, for Helvetica and for the DejaVu face
   that stands in when the text needs one — 0.718 and 0.729 respectively. DXF
   text height is the height of a capital letter, so the font size that yields
   it is the height divided by this. Using the height as the size directly
   makes every label in the drawing a third too small, which is the usual look
   of a careless conversion. */
const CAP = 0.72;

/* A ceiling on how much geometry is worth turning into a page. Two hundred
   thousand strokes is already a PDF no viewer opens comfortably, and past it a
   pathological file would simply hang the tab. */
const MAX_PATHS = 200_000;

/* ── reading the file ─────────────────────────────────────────────────── */

type Pair = [code: number, value: string];
interface Rec {type: string; pairs: Pair[]}

/* Text out of bytes.
 *
 * From R2007 (AC1021) DXF is UTF-8 and there is nothing to decide. Before that
 * the file is in whatever code page wrote it, named in $DWGCODEPAGE — so a
 * Cyrillic drawing from 2004 read as UTF-8 arrives as a page of replacement
 * characters. Most exporters dodge the problem by writing non-ASCII as \U+XXXX
 * escapes, which is why it is rarely noticed, and why those escapes are
 * unpacked later whatever the encoding turned out to be. */
function decode(bytes: Uint8Array): string {
  if (bytes.length < 32) refuse('That file is too small to be a DXF drawing.');
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 4096));

  if (head.startsWith('AutoCAD Binary DXF')) {
    refuse('That is a binary DXF: its group codes are packed bytes rather than lines of '
      + 'text, and this reads the text form. Re-export it with "ASCII DXF" chosen in the '
      + 'save dialog.');
  }
  if (/^AC1\d{3}/.test(head)) {
    refuse('That is a DWG — AutoCAD’s own binary drawing format, not a DXF. DWG is '
      + 'undocumented and cannot be read here. Open it in a CAD program and export DXF.');
  }

  const version = /\$ACADVER\s*[\r\n]+\s*1\s*[\r\n]+\s*(AC\d+)/.exec(head)?.[1] ?? '';
  const page = /\$DWGCODEPAGE\s*[\r\n]+\s*3\s*[\r\n]+\s*(ANSI_\d+)/i.exec(head)?.[1] ?? '';

  if (version && version < 'AC1021' && page && page.toUpperCase() !== 'ANSI_1252') {
    try {
      return new TextDecoder(page.replace(/^ANSI_/i, 'windows-')).decode(bytes);
    } catch {
      /* A code page this browser has no table for. Falling through to UTF-8 is
         the better answer than giving up: the structure is ASCII either way,
         so the drawing still comes out and only its labels suffer. */
    }
  }
  return new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, '');
}

/* Group codes into records. A record starts at every code 0 and runs to the
   next one; that single rule covers entities, block headers, table entries and
   section markers alike, so there is one loop rather than four. */
function records(text: string): {recs: Rec[]; truncated: boolean} {
  const lines = text.split(/\r\n|\r|\n/);
  /* Trailing blank lines are just how the file ended. Dropping them first
     means a blank line encountered later is a real fault rather than the
     end of the file arriving. */
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  let i = 0;
  while (i < lines.length && !lines[i]!.trim()) i++;

  const recs: Rec[] = [];
  let cur: Rec | null = null;
  let truncated = false;

  for (; i + 1 < lines.length; i += 2) {
    const head = lines[i]!.trim();
    const code = Number(head);
    if (!head || !Number.isInteger(code)) {
      /* The pairing is positional, so one line out of step means everything
         after it is read against the wrong code. Stopping here keeps what was
         already understood; the page says so rather than pretending the
         drawing was complete. */
      truncated = true;
      break;
    }
    const value = lines[i + 1]!;
    if (code === 0) {
      if (cur) recs.push(cur);
      if (value.trim() === 'EOF') { cur = null; break; }
      cur = {type: value.trim(), pairs: []};
      continue;
    }
    /* Codes before the first 0 belong to nothing — a stray 999 comment at the
       top of the file, usually. */
    cur?.pairs.push([code, value]);
  }
  if (cur) recs.push(cur);

  if (!recs.length) {
    refuse('That file is not a DXF. A DXF is pairs of lines — a group code, then its '
      + 'value — and this one has none.');
  }
  return {recs, truncated};
}

const str = (rec: Rec, code: number): string | undefined =>
  rec.pairs.find(([c]) => c === code)?.[1];

function num(rec: Rec, code: number, dflt: number): number {
  const raw = str(rec, code);
  if (raw === undefined) return dflt;
  const n = Number(raw.trim());
  return Number.isFinite(n) ? n : dflt;
}

type Pt = [number, number];
interface Block {base: Pt; recs: Rec[]}
interface File {
  entities: Rec[];
  blocks: Map<string, Block>;
  hidden: Set<string>;
  truncated: boolean;
}

/* Sort the records into the three things that matter: the entities, the block
   definitions they refer to, and which layers were switched off. */
function shelve(recs: Rec[], truncated: boolean): File {
  const entities: Rec[] = [];
  const blocks = new Map<string, Block>();
  const hidden = new Set<string>();

  let section = '';
  let table = '';
  let block: {name: string; base: Pt; recs: Rec[]} | null = null;

  for (const rec of recs) {
    switch (rec.type) {
      case 'SECTION': section = str(rec, 2)?.trim() ?? ''; table = ''; block = null; continue;
      case 'ENDSEC': section = ''; table = ''; block = null; continue;
      case 'TABLE': table = str(rec, 2)?.trim() ?? ''; continue;
      case 'ENDTAB': table = ''; continue;
      case 'BLOCK':
        if (section === 'BLOCKS') {
          block = {
            name: str(rec, 2)?.trim() ?? '',
            base: [num(rec, 10, 0), num(rec, 20, 0)],
            recs: [],
          };
        }
        continue;
      case 'ENDBLK':
        if (block?.name) blocks.set(block.name, {base: block.base, recs: block.recs});
        block = null;
        continue;
      case 'LAYER':
        /* A layer is off when its colour is written negative, and frozen when
           bit 1 of its flags is set. Either way the author did not want to see
           it, and a conversion that ignores that arrives covered in
           construction lines. */
        if (section === 'TABLES' && table === 'LAYER') {
          const name = str(rec, 2)?.trim();
          if (name && (num(rec, 62, 1) < 0 || (num(rec, 70, 0) & 1) === 1)) hidden.add(name);
        }
        continue;
      default: break;
    }
    if (section === 'ENTITIES') entities.push(rec);
    else if (section === 'BLOCKS' && block) block.recs.push(rec);
  }

  return {entities, blocks, hidden, truncated};
}

/* ── geometry ─────────────────────────────────────────────────────────── */

/* A segment is a straight run to `to`, or a cubic with two control points.
   Circles and arcs become cubics rather than a fan of short chords for two
   reasons: a circle costs four segments instead of sixty, and — the reason it
   is worth doing — an affine transform maps a cubic exactly onto another
   cubic. So a block scaled unevenly turns its circles into true ellipses with
   no special case anywhere, because every number describing the curve is just
   another point to push through the matrix. */
interface Seg {to: Pt; c1?: Pt; c2?: Pt}
interface Path {start: Pt; segs: Seg[]; closed: boolean}
interface Label {
  s: string; at: Pt; h: number; rot: number;
  hj: 'l' | 'c' | 'r'; vj: 'base' | 'bot' | 'mid' | 'top';
}

/* x' = a x + c y + e, y' = b x + d y + f — the six numbers PDF and SVG use, in
   the order they use them. */
type Xf = readonly [number, number, number, number, number, number];
const UNIT: Xf = [1, 0, 0, 1, 0, 0];

const at = (m: Xf, p: Pt): Pt =>
  [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];

/** `o` applied after `i`. */
const mul = (o: Xf, i: Xf): Xf => [
  o[0] * i[0] + o[2] * i[1],
  o[1] * i[0] + o[3] * i[1],
  o[0] * i[2] + o[2] * i[3],
  o[1] * i[2] + o[3] * i[3],
  o[0] * i[4] + o[2] * i[5] + o[4],
  o[1] * i[4] + o[3] * i[5] + o[5],
];

/* Every arc in DXF runs anticlockwise from the first angle to the second,
   however the two numbers compare — an arc from 350° to 10° is twenty degrees
   long, not minus three hundred and forty. */
function ccw(sweep: number): number {
  if (!Number.isFinite(sweep)) return 2 * Math.PI;
  const t = sweep % (2 * Math.PI);
  return t <= 1e-12 ? t + 2 * Math.PI : t;
}

/* An arc as cubics, never more than a quarter turn each — past that the
   four-thirds-tangent approximation starts to visibly bulge. */
function arc(cx: number, cy: number, r: number, a0: number, sweep: number): Path {
  const n = Math.max(1, Math.min(64, Math.ceil(Math.abs(sweep) / (Math.PI / 2))));
  const step = sweep / n;
  const k = (4 / 3) * Math.tan(step / 4);
  const on = (a: number): Pt => [cx + r * Math.cos(a), cy + r * Math.sin(a)];

  const segs: Seg[] = [];
  let a = a0;
  for (let i = 0; i < n; i++) {
    const b = a + step;
    const p0 = on(a), p3 = on(b);
    segs.push({
      c1: [p0[0] - k * r * Math.sin(a), p0[1] + k * r * Math.cos(a)],
      c2: [p3[0] + k * r * Math.sin(b), p3[1] - k * r * Math.cos(b)],
      to: p3,
    });
    a = b;
  }
  return {start: on(a0), segs, closed: false};
}

/* The arc a polyline bulge stands for. Bulge is the tangent of a quarter of
   the included angle, signed anticlockwise, so its sign carries the direction
   and its size carries how far the edge bows out. The centre sits off the
   chord's midpoint by cos(θ/2) times the radius — a factor that turns negative
   on its own past a half turn and puts the centre on the far side without a
   second case. */
function bulgeArc(p0: Pt, p1: Pt, bulge: number): Path {
  const theta = 4 * Math.atan(bulge);
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
  const d = Math.hypot(dx, dy);
  const half = Math.sin(theta / 2);
  if (!d || !half) return {start: p0, segs: [{to: p1}], closed: false};
  const r = d / (2 * half);
  const off = r * Math.cos(theta / 2);
  const cx = (p0[0] + p1[0]) / 2 - (dy / d) * off;
  const cy = (p0[1] + p1[1]) / 2 + (dx / d) * off;
  return arc(cx, cy, Math.abs(r), Math.atan2(p0[1] - cy, p0[0] - cx), theta);
}

function xform(m: Xf, p: Path): Path {
  if (m === UNIT) return p;
  return {
    start: at(m, p.start),
    segs: p.segs.map(s => (s.c1 && s.c2
      ? {c1: at(m, s.c1), c2: at(m, s.c2), to: at(m, s.to)}
      : {to: at(m, s.to)})),
    closed: p.closed,
  };
}

/* ── entities into geometry ───────────────────────────────────────────── */

interface Out {
  paths: Path[];
  fills: Path[];
  labels: Label[];
  points: Pt[];
  skipped: Map<string, number>;
}

/* Types that put no mark on the sheet, so their absence is not worth
   reporting. ATTDEF is the blank template of a block attribute — the filled-in
   copy arrives as ATTRIB, which is drawn. */
const SILENT = new Set([
  'SEQEND', 'VERTEX', 'ATTDEF', 'VIEWPORT', 'XLINE', 'RAY',
  'ACAD_PROXY_ENTITY', 'OLE2FRAME', 'WIPEOUT',
]);

function skip(out: Out, type: string): void {
  if (SILENT.has(type)) return;
  out.skipped.set(type, (out.skipped.get(type) ?? 0) + 1);
}

function keep(out: Out, list: Path[], p: Path): void {
  if (out.paths.length + out.fills.length >= MAX_PATHS) {
    refuse('That drawing has more than two hundred thousand separate strokes in it. A PDF '
      + 'that size would not open usefully — export a smaller area, or fewer layers.');
  }
  if (p.segs.length) list.push(p);
}

/* Which entities keep their coordinates in a plane of their own rather than in
   the drawing's. It is not all of them, and the distinction is easy to miss
   because every entity may carry an extrusion direction: on a LINE or an
   ELLIPSE that direction only says which way a thickness sticks out, and the
   points are already in world coordinates. Applying the flip below to one of
   those would mirror geometry that was never mirrored. */
const OCS = new Set([
  'CIRCLE', 'ARC', 'LWPOLYLINE', 'POLYLINE', 'SOLID', 'TRACE',
  'TEXT', 'ATTRIB', 'INSERT', 'DIMENSION', 'SHAPE',
]);

/* The plane such an entity was drawn on. Recovering world coordinates from an
   arbitrary one needs the arbitrary axis algorithm; the case worth handling is
   a normal of (0,0,-1), which is what every mirror operation produces and what
   that algorithm works out to exactly a flip of X. Anything genuinely tilted is
   reported rather than drawn flat, because a tilted circle laid down as a
   circle is a lie about the geometry rather than a simplification of it. */
function plane(rec: Rec): Xf | null {
  if (!OCS.has(rec.type)) return UNIT;
  const nx = num(rec, 210, 0), ny = num(rec, 220, 0), nz = num(rec, 230, 1);
  if (Math.abs(nx) < 1e-9 && Math.abs(ny) < 1e-9) {
    return nz < 0 ? [-1, 0, 0, 1, 0, 0] : UNIT;
  }
  return null;
}

function collect(
  recs: Rec[], xf: Xf, out: Out, file: File, stack: string[], layers: boolean,
): void {
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i]!;
    const layer = str(rec, 8)?.trim();
    /* Layer 0 is never filtered: entities on it inherit the layer of whatever
       block inserted them, so its own visibility says nothing about theirs.
       Sidestepping that inheritance rule is worth more than the handful of
       entities it lets through. */
    if (layers && layer && layer !== '0' && file.hidden.has(layer)) continue;

    const ocs = plane(rec);
    if (!ocs) { skip(out, rec.type); continue; }
    const m = ocs === UNIT ? xf : mul(xf, ocs);

    switch (rec.type) {
      case 'LINE':
        keep(out, out.paths, xform(m, {
          start: [num(rec, 10, 0), num(rec, 20, 0)],
          segs: [{to: [num(rec, 11, 0), num(rec, 21, 0)]}],
          closed: false,
        }));
        break;

      case 'CIRCLE':
        keep(out, out.paths, xform(m, {
          ...arc(num(rec, 10, 0), num(rec, 20, 0), num(rec, 40, 0), 0, 2 * Math.PI),
          closed: true,
        }));
        break;

      case 'ARC': {
        const a0 = num(rec, 50, 0) * Math.PI / 180;
        const a1 = num(rec, 51, 0) * Math.PI / 180;
        keep(out, out.paths, xform(m,
          arc(num(rec, 10, 0), num(rec, 20, 0), num(rec, 40, 0), a0, ccw(a1 - a0))));
        break;
      }

      case 'ELLIPSE': {
        /* The major axis is stored as a vector from the centre and the minor
           as a ratio of it, which makes the ellipse a unit circle under a
           matrix built from those two vectors — exactly the transform the
           cubics already travel through. */
        const mx = num(rec, 11, 1), my = num(rec, 21, 0);
        const ratio = num(rec, 40, 1);
        const t0 = num(rec, 41, 0);
        const frame: Xf = [mx, my, -my * ratio, mx * ratio, num(rec, 10, 0), num(rec, 20, 0)];
        keep(out, out.paths, xform(mul(m, frame),
          arc(0, 0, 1, t0, ccw(num(rec, 42, 2 * Math.PI) - t0))));
        break;
      }

      case 'LWPOLYLINE':
        for (const p of chain(vertices(rec), (num(rec, 70, 0) & 1) === 1)) {
          keep(out, out.paths, xform(m, p));
        }
        break;

      case 'POLYLINE': {
        /* The vertices are separate records following this one until a SEQEND,
           rather than being folded into it — the only entity in the format
           built that way, and the reason this loop is indexed. */
        const verts: Array<{p: Pt; bulge: number}> = [];
        let j = i + 1;
        for (; j < recs.length; j++) {
          const v = recs[j]!;
          if (v.type !== 'VERTEX') break;
          /* A polyface mesh writes its faces as vertices too, told apart by
             carrying corner indices instead of a position. Reading those as
             points on an outline turns the mesh into a scribble. */
          if (str(v, 71) !== undefined) continue;
          verts.push({p: [num(v, 10, 0), num(v, 20, 0)], bulge: num(v, 42, 0)});
        }
        const flags = num(rec, 70, 0);
        if (flags & (16 | 64)) skip(out, 'POLYLINE mesh');
        else for (const p of chain(verts, (flags & 1) === 1)) keep(out, out.paths, xform(m, p));
        i = j - 1;
        break;
      }

      case 'POINT':
        out.points.push(at(m, [num(rec, 10, 0), num(rec, 20, 0)]));
        break;

      case 'SOLID':
      case 'TRACE': {
        /* The corners are stored 1, 2, 4, 3: the last two are swapped relative
           to the order you would draw them in, and taking them at face value
           gives a bow tie instead of a quadrilateral. Filled, because that is
           what a SOLID is — and because every arrowhead on every dimension in
           every drawing is one. */
        const q: Pt[] = [
          [num(rec, 10, 0), num(rec, 20, 0)],
          [num(rec, 11, 0), num(rec, 21, 0)],
          [num(rec, 13, num(rec, 12, 0)), num(rec, 23, num(rec, 22, 0))],
          [num(rec, 12, 0), num(rec, 22, 0)],
        ];
        keep(out, out.fills, xform(m, {start: q[0]!, segs: q.slice(1).map(p => ({to: p})), closed: true}));
        break;
      }

      case '3DFACE': {
        const q = [10, 11, 12, 13].map(c => [num(rec, c, 0), num(rec, c + 10, 0)] as Pt);
        keep(out, out.paths, xform(m, {start: q[0]!, segs: q.slice(1).map(p => ({to: p})), closed: true}));
        break;
      }

      case 'TEXT':
      case 'ATTRIB':
        label(rec, m, out);
        break;

      case 'MTEXT':
        paragraph(rec, m, out);
        break;

      case 'INSERT':
        insert(rec, m, out, file, stack, layers);
        break;

      case 'DIMENSION': {
        /* A dimension carries a pre-drawn anonymous block holding its lines,
           arrows and text, already in world coordinates. Drawing that block is
           both easier and more faithful than re-deriving the geometry from the
           definition points, which would mean reimplementing dimension
           styles. */
        const name = str(rec, 2)?.trim();
        const block = name ? file.blocks.get(name) : undefined;
        if (!name || !block) { skip(out, 'DIMENSION'); break; }
        if (stack.includes(name)) break;
        stack.push(name);
        collect(block.recs, mul(m, [1, 0, 0, 1, -block.base[0], -block.base[1]]),
                out, file, stack, layers);
        stack.pop();
        break;
      }

      default:
        skip(out, rec.type);
    }
  }
}

/* LWPOLYLINE keeps every vertex in one record, so the coordinates have to be
   read in file order: a new vertex begins at each code 10, and a bulge belongs
   to whichever vertex it followed. Pairing the 10s and 20s up by index works
   until the first polyline that bulges only some of its corners, and then it
   silently bends the wrong ones. */
function vertices(rec: Rec): Array<{p: Pt; bulge: number}> {
  const out: Array<{p: Pt; bulge: number}> = [];
  let cur: {x: number; y: number; bulge: number} | null = null;
  const flush = () => { if (cur) out.push({p: [cur.x, cur.y], bulge: cur.bulge}); cur = null; };
  for (const [code, raw] of rec.pairs) {
    const n = Number(raw.trim());
    if (!Number.isFinite(n)) continue;
    if (code === 10) { flush(); cur = {x: n, y: 0, bulge: 0}; }
    else if (code === 20 && cur) cur.y = n;
    else if (code === 42 && cur) cur.bulge = n;
  }
  flush();
  return out;
}

function chain(verts: Array<{p: Pt; bulge: number}>, closed: boolean): Path[] {
  if (verts.length < 2) return [];
  const paths: Path[] = [];
  const edges = closed ? verts.length : verts.length - 1;
  /* Straight edges are gathered into one running path, so a hundred-segment
     outline is one stroke rather than a hundred; a bulged edge interrupts the
     run with its own arc and a new run starts after it. */
  let run: Path | null = null;
  for (let i = 0; i < edges; i++) {
    const a = verts[i]!, b = verts[(i + 1) % verts.length]!;
    if (a.bulge) {
      if (run) { paths.push(run); run = null; }
      paths.push(bulgeArc(a.p, b.p, a.bulge));
    } else {
      if (!run) run = {start: a.p, segs: [], closed: false};
      run.segs.push({to: b.p});
    }
  }
  if (run) paths.push(run);
  return paths;
}

/* ── blocks ───────────────────────────────────────────────────────────── */

function insert(
  rec: Rec, xf: Xf, out: Out, file: File, stack: string[], layers: boolean,
): void {
  const name = str(rec, 2)?.trim();
  const block = name ? file.blocks.get(name) : undefined;
  if (!name || !block) { skip(out, 'INSERT'); return; }
  /* A block that reaches itself, directly or through another, would recurse
     until the stack gives out. AutoCAD forbids it; a hand-edited file does
     not. */
  if (stack.includes(name)) return;

  const ix = num(rec, 10, 0), iy = num(rec, 20, 0);
  const sx = num(rec, 41, 1) || 1, sy = num(rec, 42, 1) || 1;
  const rot = num(rec, 50, 0) * Math.PI / 180;
  const cos = Math.cos(rot), sin = Math.sin(rot);

  const cols = Math.max(1, Math.round(num(rec, 70, 1)));
  const rows = Math.max(1, Math.round(num(rec, 71, 1)));
  const cgap = num(rec, 44, 0), rgap = num(rec, 45, 0);
  if (cols * rows > 10_000) {
    refuse(`One block in that drawing is arrayed ${cols} by ${rows} times, which is more `
      + 'copies than a page can hold. Explode or trim the array before exporting.');
  }

  stack.push(name);
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      /* Array spacing runs along the block's own rotated axes, not the
         drawing's — a rotated row of studs walks off at its own angle. */
      const ox = ix + cos * c * cgap - sin * r * rgap;
      const oy = iy + sin * c * cgap + cos * r * rgap;
      /* Translate to the insertion point, rotate, scale, and put the block's
         base point at the origin first — the base point is the handle the
         block is held by, not necessarily its own origin. */
      const local: Xf = [
        cos * sx, sin * sx, -sin * sy, cos * sy,
        ox - (cos * sx * block.base[0] - sin * sy * block.base[1]),
        oy - (sin * sx * block.base[0] + cos * sy * block.base[1]),
      ];
      collect(block.recs, mul(xf, local), out, file, stack, layers);
    }
  }
  stack.pop();
}

/* ── text ─────────────────────────────────────────────────────────────── */

/* The formatting codes that predate MTEXT and still turn up everywhere. %%c is
   the diameter sign; U+2300 is the strictly correct character but it is absent
   from most faces, and Ø renders in all of them. */
function codes(s: string): string {
  return s
    .replace(/%%[dD]/g, '°').replace(/%%[cC]/g, 'Ø').replace(/%%[pP]/g, '±')
    .replace(/%%[uUoOkK]/g, '')
    .replace(/%%(\d{3})/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    /* Control bytes make pdf-lib throw when the document is saved, and a stray
       one is not worth losing the whole drawing over. Newline survives because
       MTEXT splits its lines on it a moment later. */
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, ' ');
}

/* MTEXT stores its formatting inline. Some codes take an argument terminated
   by a semicolon and some are bare toggles — treating the second kind as the
   first swallows everything up to the next semicolon, which is how converted
   drawings lose half of their notes. */
const ARGUED = new Set(['H', 'W', 'A', 'C', 'c', 'T', 'Q', 'f', 'F', 'p']);
const TOGGLE = new Set(['L', 'l', 'O', 'o', 'K', 'k', 'N', 'X']);

function plain(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '{' || ch === '}') continue;
    if (ch !== '\\') { out += ch; continue; }
    const next = s[i + 1];
    if (next === undefined) break;
    if (next === 'P') { out += '\n'; i++; continue; }
    if (next === '~') { out += ' '; i++; continue; }
    /* \U+0416 is a character, not a formatting instruction. It has to survive
       this pass intact for the one below to turn it back into a letter —
       dropping the backslash here is what leaves "+0416" in the middle of a
       Cyrillic note. */
    if (next === 'U' && s[i + 2] === '+') { out += s.slice(i, i + 7); i += 6; continue; }
    if (next === '\\' || next === '{' || next === '}') { out += next; i++; continue; }
    if (next === 'S') {
      /* A stacked fraction: numerator, a divider, denominator. Flattened to a
         slash, which is what it means and all that one line of type can show. */
      const end = s.indexOf(';', i + 2);
      out += (end < 0 ? s.slice(i + 2) : s.slice(i + 2, end)).replace(/[\^#/]/, '/');
      i = end < 0 ? s.length : end;
      continue;
    }
    if (ARGUED.has(next)) {
      const end = s.indexOf(';', i + 2);
      i = end < 0 ? s.length : end;
      continue;
    }
    if (TOGGLE.has(next)) { i++; continue; }
    i++;
  }
  return out;
}

/* What a block's transform means for a piece of type: one angle and one size.
   A mirrored block would strictly need mirrored glyphs, which no PDF font
   offers — its labels come out readable instead, which is the more useful of
   the two wrong answers. */
const spin = (m: Xf): number => Math.atan2(m[1], m[0]);
const grow = (m: Xf): number => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;

function label(rec: Rec, m: Xf, out: Out): void {
  const s = codes(str(rec, 1) ?? '').trim();
  if (!s) return;
  const hcode = num(rec, 72, 0), vcode = num(rec, 73, 0);

  /* The insertion point at code 10 is the anchor only for plain left-baseline
     text. The moment any justification is set, the point that matters is the
     second one at code 11 — and reading 10 regardless scatters every centred
     label in the drawing off to one side. */
  const p1: Pt = [num(rec, 10, 0), num(rec, 20, 0)];
  const p2: Pt = [num(rec, 11, p1[0]), num(rec, 21, p1[1])];
  const anchor: Pt = hcode === 3 || hcode === 5
    ? [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2]
    : (hcode !== 0 || vcode !== 0) ? p2 : p1;

  const hj = hcode === 2 ? 'r'
    : hcode === 0 ? 'l' : 'c';
  const vj = hcode === 4 ? 'mid'
    : vcode === 1 ? 'bot' : vcode === 2 ? 'mid' : vcode === 3 ? 'top' : 'base';

  out.labels.push({
    s, at: at(m, anchor), h: num(rec, 40, 1) * grow(m),
    rot: num(rec, 50, 0) * Math.PI / 180 + spin(m), hj, vj,
  });
}

function paragraph(rec: Rec, m: Xf, out: Out): void {
  /* Anything over 250 characters is split across repeated code 3 chunks with
     the tail left in code 1, in that order. */
  const chunks = rec.pairs.filter(([c]) => c === 3).map(([, v]) => v).join('');
  const lines = codes(plain(chunks + (str(rec, 1) ?? ''))).split('\n')
    .map(l => l.replace(/\s+$/, ''));
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  if (!lines.length) return;

  const h = num(rec, 40, 1) * grow(m);
  /* Three-on-five: MTEXT's default leading is five thirds of the text height,
     and code 44 scales that. */
  const lead = h * (5 / 3) * (num(rec, 44, 1) || 1);
  const anchor = num(rec, 71, 1);
  const hj = anchor % 3 === 2 ? 'c' : anchor % 3 === 0 ? 'r' : 'l';

  /* 1–3 hang from the top, 4–6 straddle the middle, 7–9 sit on the bottom. */
  const block = (lines.length - 1) * lead + h;
  const first = anchor <= 3 ? -h : anchor <= 6 ? block / 2 - h : block - h;

  /* The angle is normally code 50, but some exporters give a direction vector
     at 11/21 and leave 50 out entirely. */
  const rot = (str(rec, 50) !== undefined
    ? num(rec, 50, 0) * Math.PI / 180
    : Math.atan2(num(rec, 21, 0), num(rec, 11, 1))) + spin(m);
  const base = at(m, [num(rec, 10, 0), num(rec, 20, 0)]);
  const cos = Math.cos(rot), sin = Math.sin(rot);

  lines.forEach((s, i) => {
    if (!s.trim()) return;
    const dy = first - i * lead;
    out.labels.push({s, at: [base[0] - sin * dy, base[1] + cos * dy], h, rot, hj, vj: 'base'});
  });
}

/* ── the page ─────────────────────────────────────────────────────────── */

export async function dxfToPdf(bytes: Uint8Array): Promise<Blob> {
  const {recs, truncated} = records(decode(bytes));
  const file = shelve(recs, truncated);
  if (!file.entities.length) {
    refuse('That DXF has no entities in it — its ENTITIES section is empty, so there is '
      + 'nothing to draw.');
  }

  /* Model space and paper space are two drawings in one file at wildly
     different scales: the model in millimetres of building, the layout in
     millimetres of sheet. Fitting both onto one page shrinks the model to a
     smudge inside the title block. The model is what people mean by "the
     drawing", so it wins — and a file that has only a layout still gets one. */
  const model = file.entities.filter(r => num(r, 67, 0) !== 1);
  const space = model.length ? model : file.entities;

  let out = build(space, file, true);
  /* If honouring the off and frozen layers left nothing at all, either the
     layer table was read wrongly or the author hid the entire drawing. An
     empty page is the worse answer, so draw everything. */
  if (!out.paths.length && !out.fills.length && !out.labels.length && !out.points.length) {
    out = build(space, file, false);
  }

  const box = extent(out);
  if (!box) {
    const seen = [...out.skipped.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
      .map(([t, n]) => `${n} ${t}`).join(', ');
    return refuse(seen
      ? `Nothing in that DXF could be drawn. What it holds — ${seen} — is past what this `
        + 'reads: lines, polylines, circles, arcs, ellipses, solids, dimensions and text.'
      : 'Nothing in that DXF could be drawn — its entities carry no coordinates.');
  }

  const w = Math.max(box.maxX - box.minX, 1e-9);
  const h = Math.max(box.maxY - box.minY, 1e-9);
  /* Whichever way round the sheet holds the drawing larger. A site plan is
     wide and a lift shaft is tall, and forcing either onto portrait throws
     away half the paper. */
  const fit = (pw: number, ph: number) => Math.min((pw - MARGIN * 2) / w, (ph - MARGIN * 2) / h);
  const portrait = fit(A4.w, A4.h) >= fit(A4.h, A4.w);
  const size = portrait ? A4 : {w: A4.h, h: A4.w};
  const scale = fit(size.w, size.h);

  const doc = await PDFDocument.create();
  const page = doc.addPage([size.w, size.h]);
  /* Y is up in both formats, so there is no flip — but the drawing's origin is
     wherever the draughtsman left it, which for a surveyed site plan is
     several hundred kilometres away. Only the extents can place it. */
  const ox = MARGIN + (size.w - MARGIN * 2 - w * scale) / 2 - box.minX * scale;
  const oy = MARGIN + (size.h - MARGIN * 2 - h * scale) / 2 - box.minY * scale;
  const map = (p: Pt): Pt => [ox + p[0] * scale, oy + p[1] * scale];

  emit(page, out, map);

  if (out.labels.length) {
    const font = needsUnicode(out.labels.map(l => l.s).join(''))
      ? await unicodeFont(doc, 'sans')
      : await doc.embedFont(StandardFonts.Helvetica);
    for (const one of out.labels) write(page, one, font, map, scale);
  }

  const note = notice(out, file.truncated);
  if (note) {
    /* In the margin, under the drawing, small and grey: this is a note about
       the conversion, not part of the drawing, and it must not be mistaken for
       one. */
    page.drawText(note, {
      x: MARGIN, y: MARGIN / 2.4, size: 6.5,
      font: await doc.embedFont(StandardFonts.Helvetica),
      color: rgb(0.45, 0.48, 0.53),
    });
  }

  return new Blob([(await doc.save()).slice() as BlobPart], {type: 'application/pdf'});
}

function build(space: Rec[], file: File, layers: boolean): Out {
  const out: Out = {paths: [], fills: [], labels: [], points: [], skipped: new Map()};
  collect(space, UNIT, out, file, [], layers);
  return out;
}

/* Where a cubic doubles back — the points between its ends at which one
   coordinate stops growing and starts shrinking. The derivative of a cubic is
   a quadratic, so this is the quadratic formula twice, once per axis, keeping
   only the roots that fall inside the segment. Together with the two endpoints
   they are the whole extent of the curve. */
function turns(p0: Pt, c1: Pt, c2: Pt, p3: Pt): Pt[] {
  const on = (t: number): Pt => {
    const u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    return [
      a * p0[0] + b * c1[0] + c * c2[0] + d * p3[0],
      a * p0[1] + b * c1[1] + c * c2[1] + d * p3[1],
    ];
  };

  const out: Pt[] = [];
  for (const k of [0, 1] as const) {
    const a = p3[k] - 3 * c2[k] + 3 * c1[k] - p0[k];
    const b = 2 * (c2[k] - 2 * c1[k] + p0[k]);
    const c = c1[k] - p0[k];
    const take = (t: number) => { if (t > 0 && t < 1) out.push(on(t)); };
    if (Math.abs(a) < 1e-12) {
      if (Math.abs(b) > 1e-12) take(-c / b);
    } else {
      const disc = b * b - 4 * a * c;
      if (disc >= 0) {
        const root = Math.sqrt(disc);
        take((-b + root) / (2 * a));
        take((-b - root) / (2 * a));
      }
    }
  }
  return out;
}

/* The drawing's own extents, measured from what is about to be drawn.
 *
 * $EXTMIN and $EXTMAX in the header claim to say the same thing and are not to
 * be trusted: they are refreshed only when the drawing is regenerated, so an
 * exporter that never regenerates writes whatever the drawing looked like
 * several edits ago — sometimes the extents of an empty file, which would put
 * everything off the page.
 *
 * Curves are measured where they actually turn, not by the box around their
 * control points. The hull would be the easy answer and it is safe — a cubic
 * never leaves it — but for a quarter-circle it overstates the height by a
 * third, and a drawing whose shape is one big arc would then be laid down a
 * third smaller than the sheet allows. */
function extent(out: Out): {minX: number; minY: number; maxX: number; maxY: number} | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (p: Pt) => {
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) return;
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  };

  for (const list of [out.paths, out.fills]) {
    for (const path of list) {
      add(path.start);
      let from = path.start;
      for (const seg of path.segs) {
        add(seg.to);
        if (seg.c1 && seg.c2) for (const p of turns(from, seg.c1, seg.c2, seg.to)) add(p);
        from = seg.to;
      }
    }
  }
  for (const p of out.points) add(p);
  for (const l of out.labels) {
    add(l.at);
    /* An estimate, and it has to be one: the real width needs a font, and
       which font gets embedded is not settled until every label has been read.
       Six tenths of the cap height per character is close for Helvetica, and
       erring wide only pulls the label further inside the page. */
    const wide = l.s.length * l.h * 0.6, tall = l.h * 1.25;
    const cos = Math.cos(l.rot), sin = Math.sin(l.rot);
    const x0 = l.hj === 'c' ? -wide / 2 : l.hj === 'r' ? -wide : 0;
    const corners: Pt[] = [
      [x0, -tall * 0.3], [x0 + wide, -tall * 0.3], [x0, tall], [x0 + wide, tall],
    ];
    for (const [dx, dy] of corners) {
      add([l.at[0] + cos * dx - sin * dy, l.at[1] + sin * dx + cos * dy]);
    }
  }
  return Number.isFinite(minX) ? {minX, minY, maxX, maxY} : null;
}

function emit(page: PDFPage, out: Out, map: (p: Pt) => Pt): void {
  /* pushOperators is variadic, and a drawing's worth of operators handed to it
     in one call is an argument list long enough to overflow the stack. */
  const flush = (ops: PDFOperator[]) => {
    for (let i = 0; i < ops.length; i += 2048) page.pushOperators(...ops.slice(i, i + 2048));
  };

  const trace = (path: Path, ops: PDFOperator[]) => {
    const s = map(path.start);
    ops.push(moveTo(s[0], s[1]));
    for (const seg of path.segs) {
      const t = map(seg.to);
      if (seg.c1 && seg.c2) {
        const a = map(seg.c1), b = map(seg.c2);
        ops.push(appendBezierCurve(a[0], a[1], b[0], b[1], t[0], t[1]));
      } else {
        ops.push(lineTo(t[0], t[1]));
      }
    }
    if (path.closed) ops.push(closePath());
  };

  if (out.fills.length) {
    const ops: PDFOperator[] = [pushGraphicsState(), setFillingColor(INK)];
    for (const path of out.fills) trace(path, ops);
    ops.push(fill(), popGraphicsState());
    flush(ops);
  }

  if (out.paths.length || out.points.length) {
    const ops: PDFOperator[] = [
      pushGraphicsState(), setStrokingColor(INK), setLineWidth(HAIRLINE),
      setLineCap(LineCapStyle.Round), setLineJoin(LineJoinStyle.Round),
    ];
    /* Stroked in batches rather than as one path running the length of the
       drawing: a single path object with a hundred thousand subpaths in it is
       legal PDF and still defeats several viewers. */
    let n = 0;
    for (const path of out.paths) {
      trace(path, ops);
      if (++n % 500 === 0) ops.push(stroke());
    }
    /* A point is a marker rather than geometry, so it keeps one size on the
       sheet however far the drawing around it was scaled. */
    for (const p of out.points) {
      const q = map(p);
      ops.push(moveTo(q[0] - 1.5, q[1]), lineTo(q[0] + 1.5, q[1]),
               moveTo(q[0], q[1] - 1.5), lineTo(q[0], q[1] + 1.5));
    }
    ops.push(stroke(), popGraphicsState());
    flush(ops);
  }
}

function write(
  page: PDFPage, one: Label, font: PDFFont, map: (p: Pt) => Pt, scale: number,
): void {
  const size = one.h * scale / CAP;
  if (size < 0.4) return;      // below this it is a grey smear, not writing
  const p = map(one.at);
  const width = font.widthOfTextAtSize(one.s, size);

  /* pdf-lib puts the given point at the left end of the baseline, so every
     other justification is an offset — measured along the text's own axes,
     which is why it is applied through the rotation rather than to x and y. */
  const dx = one.hj === 'c' ? -width / 2 : one.hj === 'r' ? -width : 0;
  const dy = one.vj === 'top' ? -size * CAP
    : one.vj === 'mid' ? -size * CAP / 2
      : one.vj === 'bot' ? size * 0.21     // the descender, roughly
        : 0;
  const cos = Math.cos(one.rot), sin = Math.sin(one.rot);

  page.drawText(one.s, {
    x: p[0] + cos * dx - sin * dy,
    y: p[1] + sin * dx + cos * dy,
    size, font, color: INK, rotate: degrees(one.rot * 180 / Math.PI),
  });
}

/** What the page could not show, said out loud. */
function notice(out: Out, truncated: boolean): string {
  const parts: string[] = [];
  const listed = [...out.skipped.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (listed.length) {
    parts.push('Not drawn: ' + listed.map(([t, n]) => `${n} ${t}`).join(', ') + '.');
  }
  if (truncated) {
    parts.push('The file ends part-way through a group code; the rest could not be read.');
  }
  return parts.join('  ');
}
