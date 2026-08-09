/* A PDF's ink, taken back out as vectors instead of a picture of vectors.
 *
 * pdf.js already turns a page's content stream into an operator list once, for
 * its own canvas renderer to play back. That list is read here instead of
 * asked to render, and the same read serves two very different destinations:
 * an SVG, which wants the paths back close to verbatim, and a DXF, which wants
 * them as lines a CAD program can snap to. So the operator list is walked
 * exactly once per page — the geometry it finds is target-agnostic — and each
 * format only decides at the end how to print what was found.
 *
 * Three things about the operator list are not what a casual read of pdf.js's
 * own OPS enum suggests, and all three were checked against a running build
 * (pdfjs-dist 6.2.108) rather than assumed:
 *
 * 1. There is no separate moveTo/lineTo/curveTo/rectangle entry in the list a
 *    content stream's path operators produce. Every one of them — including a
 *    `re` — is folded by pdf.js itself into a single `constructPath` call whose
 *    args are `[paintOp, [flatDrawOps], boundingBox]`: one packed array where
 *    a small tag (0 moveto, 1 lineto, 2 curveto, 3 quadratic, 4 close) is
 *    followed by that many coordinates, repeated until the array ends. Reading
 *    fnArray for OPS.moveTo and friends the way an older pdf.js would have
 *    needed finds nothing, because those entries are never written.
 *
 * 2. Fill and stroke are not separate operators to look for either — they are
 *    the first element of that same args tuple, since `constructPath` is only
 *    invoked once the content stream reaches whichever painting operator (S,
 *    f, f*, B, B*, s, b, b*) ends the path. That element is what says whether
 *    a shape wants a stroke, a fill, or both, and whether the fill is
 *    even-odd. A path that is only ever clipped (`W n`) reaches constructPath
 *    too, tagged with the no-ink `endPath` or `clip`/`eoClip` op, and is
 *    dropped for exactly that reason — nothing was ever inked.
 *
 * 3. Page rotation lives in neither the operator list nor in
 *    `getTextContent()`'s item transforms — both stay in the page's own
 *    unrotated content-stream space regardless of a `/Rotate` entry. What
 *    does carry the rotation is `page.getViewport()`, whose `.transform` is a
 *    ready-made matrix that pdf.js's own canvas renderer seeds its context
 *    with before playing the list back. Seeding the CTM stack with that same
 *    matrix — instead of the identity a page with no rotation would get away
 *    with — is what makes a sideways-scanned page come out right side up
 *    here too. It doubles as the Y-flip: the default viewport is already
 *    top-left, Y-down, which is exactly what SVG wants, so nothing further
 *    has to flip it. DXF wants the opposite — Y-up, CAD's native sense — and
 *    pdf.js hands that back just as directly via `{dontFlip: true}`. Both
 *    outputs start the same walk from a different ready-made matrix and
 *    neither has to think about the flip again.
 *
 * A bezier stays a bezier for SVG, which draws one natively. DXF has no true
 * curve entity worth spending R12's format on, so the same curve is flattened
 * to short straight runs there — see the note by TOL.
 */
import {Refused} from '../heavy.ts';
import {pdfjs} from '../../core/pdfjs.ts';
import type {PDFPageProxy} from '../../core/pdfjs.ts';

const refuse = (m: string): never => { throw new Refused(m); };

/* ── opening the file ─────────────────────────────────────────────────── */

/* Worded the same as heavy.ts's own openPdf on purpose: the same broken file
   should read the same whichever converter it landed on. */
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

/* ── matrices ─────────────────────────────────────────────────────────── */

/* x' = a x + c y + e, y' = b x + d y + f — PDF's and SVG's own six numbers, in
   the order both of them use them. */
type Xf = readonly [number, number, number, number, number, number];
type Pt = [number, number];

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

/* A run of text carries one angle and one size, not a full matrix — no output
   format here draws sheared type. The angle is the rotation a rigid transform
   would have; the size is the geometric mean of its two axes, which is exact
   for the uniform case every real PDF uses and the least-wrong answer for the
   rare one that does not. */
const spin = (m: Xf): number => Math.atan2(m[1], m[0]);
const grow = (m: Xf): number => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;

/* ── the geometry both outputs share ─────────────────────────────────────
 *
 * A segment is a straight run to `to`, or a cubic with two control points —
 * quadratics are elevated to cubics the moment they are read (the standard
 * exact construction: each cubic control point is the matching endpoint moved
 * two-thirds of the way to the quadratic's one control point), so nothing
 * downstream has to know a third curve kind exists.
 */
interface Seg {c1?: Pt; c2?: Pt; to: Pt}
interface SubPath {start: Pt; segs: Seg[]; closed: boolean}
interface Shape {subpaths: SubPath[]; stroke: boolean; fill: boolean; evenOdd: boolean}
interface TextRun {s: string; at: Pt; h: number; rot: number}

/* The packed path format's own tags — pdf.js's DrawOPS, not the public OPS
   enum, and not exported, so they are pinned here against the numbers found
   by inspection rather than imported. */
const DRAW_MOVE = 0, DRAW_LINE = 1, DRAW_CURVE = 2, DRAW_QUAD = 3, DRAW_CLOSE = 4;

/* Which painting operator a constructPath call ends with says whether it put
   any ink down at all, and if so which kind. Anything not listed here —
   `endPath` (a bare `n`), `clip`, `eoClip` — built a path purely to clip or
   discard it, and is worth exactly nothing to either output. */
function paintOf(opName: string): {stroke: boolean; fill: boolean; evenOdd: boolean; close: boolean} | null {
  switch (opName) {
    case 'stroke': return {stroke: true, fill: false, evenOdd: false, close: false};
    case 'closeStroke': return {stroke: true, fill: false, evenOdd: false, close: true};
    case 'fill': return {stroke: false, fill: true, evenOdd: false, close: false};
    case 'eoFill': return {stroke: false, fill: true, evenOdd: true, close: false};
    case 'fillStroke': return {stroke: true, fill: true, evenOdd: false, close: false};
    case 'eoFillStroke': return {stroke: true, fill: true, evenOdd: true, close: false};
    case 'closeFillStroke': return {stroke: true, fill: true, evenOdd: false, close: true};
    case 'closeEOFillStroke': return {stroke: true, fill: true, evenOdd: true, close: true};
    default: return null;
  }
}

/* The flat draw-ops array, mapped through the CTM as it is read. `forceClose`
   covers the `s`/`b`/`b*` operators, whose closing of the final subpath is a
   property of which painting operator was used rather than always being
   spelled out as its own DRAW_CLOSE entry in the data. */
function decodePath(flat: ArrayLike<number>, m: Xf, forceClose: boolean): SubPath[] {
  const out: SubPath[] = [];
  let cur: SubPath | null = null;
  let cx = 0, cy = 0;
  const ensure = () => { cur ??= {start: at(m, [cx, cy]), segs: [], closed: false}; return cur; };

  for (let i = 0; i < flat.length;) {
    const tag = flat[i++]!;
    if (tag === DRAW_MOVE) {
      if (cur && cur.segs.length) out.push(cur);
      cx = flat[i++]!; cy = flat[i++]!;
      cur = {start: at(m, [cx, cy]), segs: [], closed: false};
    } else if (tag === DRAW_LINE) {
      cx = flat[i++]!; cy = flat[i++]!;
      ensure().segs.push({to: at(m, [cx, cy])});
    } else if (tag === DRAW_CURVE) {
      const x1 = flat[i++]!, y1 = flat[i++]!, x2 = flat[i++]!, y2 = flat[i++]!, x3 = flat[i++]!, y3 = flat[i++]!;
      ensure().segs.push({c1: at(m, [x1, y1]), c2: at(m, [x2, y2]), to: at(m, [x3, y3])});
      cx = x3; cy = y3;
    } else if (tag === DRAW_QUAD) {
      const qx = flat[i++]!, qy = flat[i++]!, x1 = flat[i++]!, y1 = flat[i++]!;
      const c1: Pt = [cx + (2 / 3) * (qx - cx), cy + (2 / 3) * (qy - cy)];
      const c2: Pt = [x1 + (2 / 3) * (qx - x1), y1 + (2 / 3) * (qy - y1)];
      ensure().segs.push({c1: at(m, c1), c2: at(m, c2), to: at(m, [x1, y1])});
      cx = x1; cy = y1;
    } else if (tag === DRAW_CLOSE) {
      if (cur) { cur.closed = true; out.push(cur); cur = null; }
    } else {
      break;   // an unrecognised tag means the rest of the array cannot be trusted
    }
  }
  if (cur && cur.segs.length) { if (forceClose) cur.closed = true; out.push(cur); }
  return out;
}

/* ── walking one page ─────────────────────────────────────────────────── */

/* `root` is the page's own viewport transform — Y-down for SVG, Y-up for DXF,
   rotation already folded in either way — so everything this returns is
   already in the caller's coordinate system and needs no further mapping. */
async function walkPage(page: PDFPageProxy, root: Xf): Promise<{shapes: Shape[]; texts: TextRun[]}> {
  const {fnArray, argsArray} = await page.getOperatorList();
  const OPS = pdfjs.OPS;
  const names = new Map<number, string>(Object.entries(OPS).map(([k, v]) => [v as number, k]));

  const shapes: Shape[] = [];
  const stack: Xf[] = [];
  let ctm: Xf = root;

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i]!;
    const args = argsArray[i] as unknown[];
    if (fn === OPS.save) { stack.push(ctm); }
    else if (fn === OPS.restore) { ctm = stack.pop() ?? root; }
    else if (fn === OPS.transform) { ctm = mul(ctm, args as unknown as Xf); }
    else if (fn === OPS.constructPath) {
      const [op, data, ] = args as [number, [ArrayLike<number>], ArrayLike<number>];
      const paint = paintOf(names.get(op) ?? '');
      if (!paint) continue;
      const subpaths = decodePath(data[0] ?? [], ctm, paint.close);
      if (subpaths.length) shapes.push({subpaths, stroke: paint.stroke, fill: paint.fill, evenOdd: paint.evenOdd});
    }
  }

  const texts: TextRun[] = [];
  const content = await page.getTextContent();
  for (const item of content.items) {
    if (!('str' in item) || !item.str.trim()) continue;
    const local = item.transform as unknown as Xf;
    const full = mul(root, local);
    texts.push({s: item.str, at: at(full, [0, 0]), h: grow(full), rot: spin(full)});
  }

  return {shapes, texts};
}

/* ── SVG ──────────────────────────────────────────────────────────────── */

const fmt = (n: number): string => (Math.round(n * 1000) / 1000).toString();
const ptStr = (p: Pt): string => `${fmt(p[0])},${fmt(p[1])}`;

function pathData(subpaths: SubPath[]): string {
  const parts: string[] = [];
  for (const sp of subpaths) {
    if (!sp.segs.length) continue;
    parts.push(`M${ptStr(sp.start)}`);
    for (const seg of sp.segs) {
      parts.push(seg.c1 && seg.c2 ? `C${ptStr(seg.c1)} ${ptStr(seg.c2)} ${ptStr(seg.to)}` : `L${ptStr(seg.to)}`);
    }
    if (sp.closed) parts.push('Z');
  }
  return parts.join(' ');
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* One <path> per constructPath call rather than one for the whole page: each
   call carried its own fill/stroke/even-odd combination and merging them
   would mean either losing that or reverse-engineering groups, neither of
   which is worth it for a converter that already declines to carry colour. */
function svgOf(w: number, h: number, shapes: Shape[], texts: TextRun[]): string {
  const body: string[] = [];
  for (const shape of shapes) {
    const d = pathData(shape.subpaths);
    if (!d) continue;
    const fill = shape.fill ? 'black' : 'none';
    const stroke = shape.stroke ? 'black' : 'none';
    const rule = shape.fill && shape.evenOdd ? ' fill-rule="evenodd"' : '';
    const width = shape.stroke ? ' stroke-width="1"' : '';
    body.push(`<path d="${d}" fill="${fill}" stroke="${stroke}"${width}${rule}/>`);
  }
  for (const t of texts) {
    const rot = Math.abs(t.rot) > 1e-4
      ? ` transform="rotate(${fmt(t.rot * 180 / Math.PI)} ${fmt(t.at[0])} ${fmt(t.at[1])})"` : '';
    body.push(`<text x="${fmt(t.at[0])}" y="${fmt(t.at[1])}" font-size="${fmt(t.h)}"${rot}>`
      + `${xmlEscape(t.s)}</text>`);
  }
  /* Sized in points rather than millimetres: a PDF's own unit, and an SVG's
     width/height accept "pt" directly, so nothing is lost converting it. */
  return `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(w)}pt" height="${fmt(h)}pt" `
    + `viewBox="0 0 ${fmt(w)} ${fmt(h)}">\n${body.join('\n')}\n</svg>\n`;
}

export async function pdfToSvgSheets(
  bytes: Uint8Array, base: string,
): Promise<Array<{name: string; blob: Blob}>> {
  const {task, doc} = await openPdf(bytes);
  const out: Array<{name: string; blob: Blob}> = [];
  let sawInk = false;
  try {
    const pad = String(doc.numPages).length;
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const vp = page.getViewport({scale: 1});
      const {shapes, texts} = await walkPage(page, vp.transform as unknown as Xf);
      if (shapes.length || texts.length) sawInk = true;
      /* A page with nothing on it is skipped rather than shipped as an empty
         SVG — a title page or a deliberate blank is not a drawing. */
      if (!shapes.length && !texts.length) continue;
      out.push({
        name: doc.numPages === 1 ? `${base}.svg` : `${base}-${String(n).padStart(pad, '0')}.svg`,
        blob: new Blob([svgOf(vp.width, vp.height, shapes, texts)], {type: 'image/svg+xml'}),
      });
    }
  } finally {
    await task.destroy().catch(() => {});
  }

  if (!out.length) {
    refuse(sawInk
      ? 'Nothing on any page of that PDF could be turned into vectors.'
      : 'That PDF has no vector content — every page is a picture, not drawn lines and '
        + 'curves, so there is nothing here to trace. Converting the pages as images instead '
        + 'is what PDF to JPG does.');
  }
  return out;
}

/* ── DXF ──────────────────────────────────────────────────────────────── */

/* PDF points to millimetres — the format's own unit, the same conversion the
   rest of the converter suite uses wherever a physical size has to come out
   of a page measured in points. */
const PT_MM = 25.4 / 72;

/* How far a flattened curve may stray from the true one, in millimetres — see
   svgDxf.ts for the full reasoning; the number and the logic are the same
   because the constraint (a laser's kerf, a CAD user's zoom) does not care
   which format the curve arrived in. */
const TOL = 0.02;

const steps = (secondDerivative: number) =>
  Math.min(256, Math.max(1, Math.ceil(Math.sqrt(secondDerivative / (8 * TOL)))));

function flattenCubic(p0: Pt, p1: Pt, p2: Pt, p3: Pt, out: Pt[]): void {
  const a = Math.hypot(p0[0] - 2 * p1[0] + p2[0], p0[1] - 2 * p1[1] + p2[1]);
  const b = Math.hypot(p1[0] - 2 * p2[0] + p3[0], p1[1] - 2 * p2[1] + p3[1]);
  const n = steps(6 * Math.max(a, b));
  for (let k = 1; k <= n; k++) {
    const t = k / n, u = 1 - t;
    out.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ]);
  }
}

type Ent =
  | {kind: 'line'; a: Pt; b: Pt}
  | {kind: 'poly'; pts: Pt[]; closed: boolean}
  | {kind: 'text'; at: Pt; h: number; rot: number; s: string};

const same = (a: Pt, b: Pt): boolean => Math.abs(a[0] - b[0]) < 1e-7 && Math.abs(a[1] - b[1]) < 1e-7;

/* Two points and nothing between them is a LINE rather than a two-vertex
   POLYLINE — what the drawing meant, a third of the group codes, and a CAD
   trim/extend behaves better on one. */
function emitEnt(ents: Ent[], raw: Pt[], closed: boolean): void {
  const pts: Pt[] = [];
  for (const p of raw) {
    const last = pts[pts.length - 1];
    if (!last || !same(last, p)) pts.push(p);
  }
  if (closed && pts.length > 1 && same(pts[0]!, pts[pts.length - 1]!)) pts.pop();
  if (pts.length < 2) return;
  if (pts.length === 2) ents.push({kind: 'line', a: pts[0]!, b: pts[1]!});
  else ents.push({kind: 'poly', pts, closed});
}

function toEnts(shapes: Shape[], texts: TextRun[]): Ent[] {
  const ents: Ent[] = [];
  for (const shape of shapes) {
    for (const sp of shape.subpaths) {
      const pts: Pt[] = [sp.start];
      for (const seg of sp.segs) {
        if (seg.c1 && seg.c2) flattenCubic(pts[pts.length - 1]!, seg.c1, seg.c2, seg.to, pts);
        else pts.push(seg.to);
      }
      emitEnt(ents, pts, sp.closed);
    }
  }
  for (const t of texts) ents.push({kind: 'text', at: t.at, h: t.h, rot: t.rot * 180 / Math.PI, s: t.s});
  return ents;
}

interface Box {minX: number; minY: number; maxX: number; maxY: number}

function extent(ents: Ent[]): Box | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const see = (x: number, y: number) => {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  };
  for (const e of ents) {
    if (e.kind === 'line') { see(e.a[0], e.a[1]); see(e.b[0], e.b[1]); }
    else if (e.kind === 'poly') for (const p of e.pts) see(p[0], p[1]);
    else see(e.at[0], e.at[1]);
  }
  return Number.isFinite(minX) ? {minX, minY, maxX, maxY} : null;
}

const dxfNum = (n: number): string => {
  const s = n.toFixed(6);
  return s === '-0.000000' ? '0.000000' : s;
};

/* R12 (AC1009) ASCII — the same choice and the same reasoning as svgDxf.ts:
   the last version every CAD program since still opens without a fuss. */
function writeDxf(ents: Ent[], box: Box): string {
  const out: string[] = [];
  const g = (code: number, value: string | number) => { out.push(String(code), String(value)); };

  g(0, 'SECTION'); g(2, 'HEADER');
  g(9, '$ACADVER'); g(1, 'AC1009');
  g(9, '$INSUNITS'); g(70, 4);
  g(9, '$EXTMIN'); g(10, dxfNum(box.minX)); g(20, dxfNum(box.minY)); g(30, '0.0');
  g(9, '$EXTMAX'); g(10, dxfNum(box.maxX)); g(20, dxfNum(box.maxY)); g(30, '0.0');
  g(0, 'ENDSEC');

  g(0, 'SECTION'); g(2, 'TABLES');
  g(0, 'TABLE'); g(2, 'LTYPE'); g(70, 1);
  g(0, 'LTYPE'); g(2, 'CONTINUOUS'); g(70, 0); g(3, 'Solid line'); g(72, 65); g(73, 0); g(40, '0.0');
  g(0, 'ENDTAB');
  g(0, 'TABLE'); g(2, 'LAYER'); g(70, 1);
  g(0, 'LAYER'); g(2, '0'); g(70, 0); g(62, 7); g(6, 'CONTINUOUS');
  g(0, 'ENDTAB');
  g(0, 'ENDSEC');

  g(0, 'SECTION'); g(2, 'ENTITIES');
  for (const e of ents) {
    if (e.kind === 'line') {
      g(0, 'LINE'); g(8, '0');
      g(10, dxfNum(e.a[0])); g(20, dxfNum(e.a[1])); g(30, '0.0');
      g(11, dxfNum(e.b[0])); g(21, dxfNum(e.b[1])); g(31, '0.0');
    } else if (e.kind === 'poly') {
      g(0, 'POLYLINE'); g(8, '0'); g(66, 1); g(70, e.closed ? 1 : 0);
      g(10, '0.0'); g(20, '0.0'); g(30, '0.0');
      for (const p of e.pts) { g(0, 'VERTEX'); g(8, '0'); g(10, dxfNum(p[0])); g(20, dxfNum(p[1])); g(30, '0.0'); }
      g(0, 'SEQEND'); g(8, '0');
    } else {
      g(0, 'TEXT'); g(8, '0');
      g(10, dxfNum(e.at[0])); g(20, dxfNum(e.at[1])); g(30, '0.0');
      g(40, dxfNum(e.h)); g(1, e.s); g(50, dxfNum(e.rot));
    }
  }
  g(0, 'ENDSEC');
  g(0, 'EOF');
  return out.join('\r\n') + '\r\n';
}

/* One drawing per page.
 *
 * A DXF holds a single drawing, and there is no honest way to fold several
 * pages into one: they would either overlap or be laid out to a plan the
 * original never had. The first version of this refused a multi-page file and
 * told the reader to split it themselves, which is correct about the format
 * and useless in practice — almost every PDF anyone owns has more than one
 * page. So each page becomes its own DXF, and the caller bundles them the way
 * every other multi-page conversion here already does.
 *
 * A page with nothing drawn on it is skipped rather than written out empty:
 * a CAD file containing no geometry opens as a blank sheet and looks like the
 * conversion failed. Only a document with no vectors anywhere is refused. */
export async function pdfToDxfSheets(
  bytes: Uint8Array, base: string,
): Promise<Array<{name: string; blob: Blob}>> {
  const {task, doc} = await openPdf(bytes);
  const out: Array<{name: string; blob: Blob}> = [];
  const pad = String(doc.numPages).length;
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const vp = page.getViewport({scale: 1, dontFlip: true});
      const root: Xf = mul([PT_MM, 0, 0, PT_MM, 0, 0], vp.transform as unknown as Xf);
      const {shapes, texts} = await walkPage(page, root);
      const ents = toEnts(shapes, texts);
      const box = extent(ents);
      if (!box) continue;
      out.push({
        name: doc.numPages === 1
          ? `${base}.dxf`
          : `${base}-${String(n).padStart(pad, '0')}.dxf`,
        blob: new Blob([writeDxf(ents, box)], {type: 'image/vnd.dxf'}),
      });
    }
  } finally {
    await task.destroy().catch(() => {});
  }
  if (!out.length) {
    refuse('That PDF has no vector content in it — its pages are pictures, not drawn lines '
      + 'and curves, so there is nothing here to trace into a CAD file. Converting the pages '
      + 'as images instead is what PDF to JPG does.');
  }
  return out;
}
