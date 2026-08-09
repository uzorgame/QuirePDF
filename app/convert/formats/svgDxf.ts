/* An SVG's geometry as a DXF a CAD program will open.
 *
 * The two formats agree on almost nothing. SVG is a painter's format — fills,
 * strokes, gradients, clipping, text laid out by whatever font engine happens
 * to be there. DXF is a draughtsman's one — lines, arcs and polylines in a
 * coordinate system with real units. What genuinely crosses between them is the
 * outline of the shapes, so that is what this writes and all it writes: every
 * <line>, <polyline>, <polygon>, <rect>, <circle>, <ellipse> and <path>, in
 * millimetres, on layer 0. Colour, stroke width and fill are left behind on
 * purpose — a DXF carrying them would be making a promise about how the drawing
 * prints that no CAD program is going to keep.
 *
 * Three things are easy to get wrong here and each of them is silent.
 *
 * SVG's Y axis points down and DXF's points up. A converter that skips the flip
 * produces a drawing that is mirrored, opens fine, and looks plausible.
 *
 * SVG coordinates are user units, which are not a length until the root
 * width/height and viewBox are read together. Emitting the raw numbers gives a
 * CAD file that is the right shape and the wrong size — a 210 mm page arriving
 * as 794 mm because nobody divided by 96 dpi.
 *
 * And a transform on an ancestor moves everything under it. Where one turns up
 * that cannot be worked out, the file is refused rather than converted, because
 * geometry in the wrong place is worse than no geometry at all.
 *
 * Output is DXF R12 (AC1009). Not for nostalgia: R12 is the last version whose
 * ASCII form is a header, a table of layers and a list of entities with no
 * handles, no object dictionary and no class table, and every CAD program
 * written since still reads it. R13 and later would buy LWPOLYLINE and a real
 * ELLIPSE entity in exchange for a much larger file that more readers get
 * fussy about.
 */
import {Refused} from '../heavy.ts';

const refuse = (m: string): never => { throw new Refused(m); };

type Pt = [number, number];

/* [a b c d e f] — SVG's matrix, mapping (x,y) to (ax+cy+e, bx+dy+f). */
type M = [number, number, number, number, number, number];

interface El {name: string; attrs: Map<string, string>; kids: El[]}

type Ent =
  | {kind: 'line'; a: Pt; b: Pt}
  | {kind: 'poly'; pts: Pt[]; closed: boolean}
  | {kind: 'circle'; c: Pt; r: number};

/* How far a flattened curve may stray from the real one, in millimetres.
 *
 * Curves become short straight runs rather than DXF splines. A spline entity
 * would be the same shape described exactly, but writing one means emitting
 * knot vectors and control points that R12 has no room for, and at any zoom a
 * CAD user actually works at, twenty microns of chord error is well under the
 * width of the line drawn on top of it. Twenty microns is also finer than a
 * laser cutter's kerf or a router bit's runout, so nothing downstream can tell.
 */
const TOL = 0.02;

const PI = Math.PI;
const PX_MM = 25.4 / 96;

/* ── the file ─────────────────────────────────────────────────────────── */

export async function svgToDxf(svg: string): Promise<Blob> {
  if (!svg.trim()) refuse('That file is empty, so there is no drawing in it to convert.');

  /* A stylesheet can move geometry with `transform`, and this reads attributes
     rather than cascading CSS. Everything else a <style> block does — fill,
     stroke, colour — is discarded anyway, so only that one property is worth
     stopping for. */
  for (const block of svg.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    if (/(^|[;{}\s])transform\s*:/i.test(block[1] ?? '')) {
      refuse('That SVG positions its shapes with a CSS transform in a <style> block. This '
        + 'converter reads the drawing, not a stylesheet, so following it would put the '
        + 'geometry somewhere it does not belong. Re-export the file with the transforms '
        + 'applied to the shapes themselves.');
    }
  }

  const {root, ids} = parseXml(svg);
  const svgEl = root.kids.find(k => k.name.toLowerCase() === 'svg')
    ?? refuse('That file has no <svg> element in it, so there is no drawing to convert. '
      + 'Check the extension matches what the file actually is.');

  const frame = readFrame(svgEl);
  /* The whole document transform in one matrix: scale to millimetres, move the
     viewBox corner to the origin, and turn the Y axis over. Every point in the
     drawing goes through this and nothing else has to remember the flip. */
  const rootM: M = [
    frame.sx, 0, 0, -frame.sy,
    -frame.sx * frame.x, frame.sy * (frame.y + frame.h),
  ];

  const ctx: Ctx = {
    ents: [], ids, vw: frame.w, vh: frame.h, sawText: false, sawImage: false,
  };
  /* The root's own transform counts — SVG 1.1 did not allow one there, SVG 2
     does, and a drawing that carries one is a drawing that means it. */
  const own = transformOf(svgEl);
  for (const kid of svgEl.kids) walk(kid, own ? mul(rootM, own) : rootM, ctx, 0);

  const ents = ctx.ents;
  if (!ents.length) {
    refuse(ctx.sawText || ctx.sawImage
      ? 'That SVG has no shapes in it — what it holds is text and pictures, and a DXF is '
        + 'made of lines and curves. Turning lettering into outlines needs the glyphs from '
        + 'the font, which an SVG does not carry.'
      : 'That SVG has no shapes in it. Nothing was found to draw: no lines, paths, '
        + 'rectangles, circles or polygons.');
  }

  const box = extents(ents);
  /* A file with neither a viewBox nor a height gives nothing to flip about, so
     the drawing is flipped about zero and then lifted until it sits on the X
     axis. Anywhere else and the whole thing would open below the origin. */
  if (frame.floating && Number.isFinite(box.minY)) {
    shift(ents, -box.minY);
    box.maxY -= box.minY;
    box.minY = 0;
  }
  if (![box.minX, box.minY, box.maxX, box.maxY].every(Number.isFinite)) {
    refuse('That SVG produced coordinates that are not numbers. Something in its path data '
      + 'or transforms is malformed, and a DXF written from it would not open.');
  }

  return new Blob([write(ents, box)], {type: 'image/vnd.dxf'});
}

/* ── reading the markup ───────────────────────────────────────────────── */

/* Scanned rather than handed to DOMParser.
 *
 * Not because DOMParser is the worse parser — it is the better one — but
 * because all this needs from the markup is element names and attribute
 * strings, and a scanner that yields those owes nothing to a document object.
 * The module therefore runs in a worker, and under a plain Node test, exactly
 * as it runs on the page. */

const ATTR = /([A-Za-z_:][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const XML_ENT: Record<string, string> = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'"};

function unescapeXml(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#[Xx]?[0-9A-Fa-f]+|[A-Za-z]+);/g, (whole: string, body: string) => {
    if (body[0] !== '#') return XML_ENT[body] ?? whole;
    const hex = body[1] === 'x' || body[1] === 'X';
    const n = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
    /* Lone surrogates are the one numeric reference String.fromCodePoint
       throws on, and a throw here would lose the whole file over one escape. */
    if (!Number.isFinite(n) || n < 1 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return whole;
    return String.fromCodePoint(n);
  });
}

/* The '>' that ends a tag, ignoring the ones inside attribute values. */
function tagEnd(src: string, from: number): number {
  let quote = '';
  for (let i = from; i < src.length; i++) {
    const c = src[i]!;
    if (quote) { if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === '>') return i;
  }
  return -1;
}

function parseXml(src: string): {root: El; ids: Map<string, El>} {
  const root: El = {name: '#doc', attrs: new Map(), kids: []};
  const stack: El[] = [root];
  const ids = new Map<string, El>();
  let i = 0;

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    i = lt + 1;

    if (src.startsWith('!--', i)) { const e = src.indexOf('-->', i); if (e < 0) break; i = e + 3; continue; }
    if (src.startsWith('![CDATA[', i)) { const e = src.indexOf(']]>', i); if (e < 0) break; i = e + 3; continue; }
    if (src[i] === '?') { const e = src.indexOf('?>', i); if (e < 0) break; i = e + 2; continue; }
    if (src[i] === '!') {
      /* A DOCTYPE can carry an internal subset in square brackets, and that
         subset contains '>' characters of its own — stopping at the first one
         leaves the rest of the declaration to be read as markup. */
      const end = tagEnd(src, i);
      const bracket = src.indexOf('[', i);
      if (bracket >= 0 && end >= 0 && bracket < end) {
        const close = src.indexOf(']', bracket);
        const after = close < 0 ? -1 : tagEnd(src, close);
        i = after < 0 ? src.length : after + 1;
      } else i = end < 0 ? src.length : end + 1;
      continue;
    }

    const closing = src[i] === '/';
    if (closing) i++;
    const end = tagEnd(src, i);
    if (end < 0) refuse('That SVG could not be read — a tag in it is never closed off. The '
      + 'file is probably truncated.');
    const body = src.slice(i, end);
    i = end + 1;

    const head = /^([A-Za-z_][\w.-]*)(?::([A-Za-z_][\w.-]*))?/.exec(body);
    if (!head) continue;
    const name = head[2] ?? head[1]!;

    if (closing) {
      /* Nesting is the one thing a scanner has to get exactly right. A stray
         </g> that is allowed to pop the stack takes a transform off every shape
         that follows, and the drawing comes out scattered rather than plainly
         broken — which is the failure nobody notices until it is cut. */
      const open = stack[stack.length - 1]!;
      if (stack.length < 2 || open.name !== name) {
        refuse(`That SVG is not valid XML — a </${name}> in it closes nothing. Open it in the `
          + 'program that drew it and export it again.');
      }
      stack.pop();
      continue;
    }

    const el: El = {name, attrs: new Map(), kids: []};
    ATTR.lastIndex = 0;
    for (const a of body.slice(head[0].length).matchAll(ATTR)) {
      el.attrs.set(a[1]!, unescapeXml(a[2] ?? a[3] ?? ''));
    }
    stack[stack.length - 1]!.kids.push(el);
    const id = el.attrs.get('id');
    /* First definition wins, which is what a renderer does with a duplicate id. */
    if (id && !ids.has(id)) ids.set(id, el);
    if (!/\/\s*$/.test(body)) stack.push(el);
  }

  if (stack.length > 1) {
    refuse(`That SVG is not valid XML — <${stack[stack.length - 1]!.name}> is never closed. `
      + 'Export it again from the program that drew it.');
  }
  return {root, ids};
}

/* ── the document's own coordinate system ─────────────────────────────── */

/* CSS absolute units, in user units. 96 to the inch is what every browser has
   meant by a pixel since the unit was pinned down, and it is what an SVG's
   author was looking at. */
const PER_UU: Record<string, number> = {
  '': 1, px: 1, mm: 96 / 25.4, cm: 960 / 25.4, in: 96, pt: 96 / 72, pc: 16,
};
const LEN = /^([+-]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][+-]?\d+)?)\s*([a-z%]*)$/i;

/* A geometry attribute in user units. `basis` is what a percentage is a
   percentage of — the viewport's width for x and width, its height for y and
   height, which is what the spec says and what a renderer does. */
function length(raw: string | undefined, basis: number): number | null {
  if (raw === undefined) return null;
  const m = LEN.exec(raw.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? '').toLowerCase();
  if (unit === '%') return (n / 100) * basis;
  const per = PER_UU[unit]
    ?? refuse(`That SVG sizes a shape in ${unit}, a unit measured against the font a browser `
      + 'would have picked. There is no browser and no font here, so the size cannot be '
      + 'worked out. Re-export the drawing with plain coordinates.');
  return n * per;
}

/* The root width or height as a real length, in millimetres, or null when it
   is a percentage of a window nobody here has. */
function physicalMm(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const m = LEN.exec(raw.trim());
  if (!m) return null;
  const per = PER_UU[(m[2] ?? '').toLowerCase()];
  if (per === undefined) return null;
  const uu = Number(m[1]) * per;
  return uu > 0 ? uu * PX_MM : null;
}

interface Frame {x: number; y: number; w: number; h: number; sx: number; sy: number; floating: boolean}

/* How large a user unit actually is, and where the page's corner sits.
 *
 * With a viewBox and a physical size, the ratio between them is the answer and
 * the drawing comes out at the size it prints at. With only a viewBox, or with
 * neither, a user unit is a CSS pixel and 96 of them make an inch. This is the
 * difference between an A4 drawing arriving as 210 mm and arriving as 794. */
function readFrame(svg: El): Frame {
  const vb = numbers(svg.attrs.get('viewBox') ?? '');
  const hasVb = vb.length === 4 && (vb[2] ?? 0) > 0 && (vb[3] ?? 0) > 0;
  const wMm = physicalMm(svg.attrs.get('width'));
  const hMm = physicalMm(svg.attrs.get('height'));

  if (hasVb) {
    const [x, y, w, h] = [vb[0]!, vb[1]!, vb[2]!, vb[3]!];
    let sx = PX_MM, sy = PX_MM;
    if (wMm !== null && hMm !== null) {
      const a = wMm / w, b = hMm / h;
      /* The default preserveAspectRatio fits the viewBox inside the viewport
         and scales both axes by the same amount; only "none" stretches. The
         letterbox offset that goes with it is dropped deliberately — it says
         where the drawing sat in a window, which a CAD file has no use for. */
      const par = (svg.attrs.get('preserveAspectRatio') ?? '').trim().toLowerCase();
      if (par.startsWith('none')) { sx = a; sy = b; }
      else sx = sy = par.includes('slice') ? Math.max(a, b) : Math.min(a, b);
    } else if (wMm !== null) sx = sy = wMm / w;
    else if (hMm !== null) sx = sy = hMm / h;
    return {x, y, w, h, sx, sy, floating: false};
  }

  /* No viewBox: user units are the viewport's own, so a pixel is a pixel. */
  const w = wMm !== null ? wMm / PX_MM : 0;
  const h = hMm !== null ? hMm / PX_MM : 0;
  return {x: 0, y: 0, w, h, sx: PX_MM, sy: PX_MM, floating: h === 0};
}

/* ── transforms ───────────────────────────────────────────────────────── */

const NUM = /[+-]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][+-]?\d+)?/g;
const numbers = (s: string): number[] => (s.match(NUM) ?? []).map(Number);

const mul = (m: M, n: M): M => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

const pt = (m: M, x: number, y: number): Pt =>
  [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/* True when the matrix takes circles to circles — any rotation, reflection or
   even scale. It is what decides whether a <circle> can stay a CIRCLE entity
   or has to be flattened, and the test is that the two column vectors are the
   same length and at right angles. */
function conformal(m: M): boolean {
  const a = m[0] * m[0] + m[1] * m[1];
  const b = m[2] * m[2] + m[3] * m[3];
  const dot = m[0] * m[2] + m[1] * m[3];
  const scale = Math.max(a, b);
  return scale > 0 && Math.abs(a - b) <= 1e-9 * scale && Math.abs(dot) <= 1e-9 * scale;
}

function transformOf(el: El): M | null {
  const style = el.attrs.get('style');
  if (style && /(^|;)\s*transform\s*:/i.test(style)) {
    refuse('That SVG moves a shape with a CSS transform in its style attribute, which this '
      + 'converter does not read. Guessing where the shape ended up would put it in the '
      + 'wrong place, so the file is refused instead. Re-export it with the transform '
      + 'applied to the geometry.');
  }
  const t = el.attrs.get('transform');
  if (!t || !t.trim()) return null;

  let out: M = [1, 0, 0, 1, 0, 0];
  let found = 0;
  for (const call of t.matchAll(/([A-Za-z]+)\s*\(([^)]*)\)/g)) {
    found++;
    const fn = call[1]!.toLowerCase();
    const n = numbers(call[2] ?? '');
    let step: M;
    switch (fn) {
      case 'translate': step = [1, 0, 0, 1, n[0] ?? 0, n[1] ?? 0]; break;
      case 'scale': step = [n[0] ?? 1, 0, 0, n[1] ?? n[0] ?? 1, 0, 0]; break;
      case 'skewx': step = [1, 0, Math.tan((n[0] ?? 0) * PI / 180), 1, 0, 0]; break;
      case 'skewy': step = [1, Math.tan((n[0] ?? 0) * PI / 180), 0, 1, 0, 0]; break;
      case 'rotate': {
        const a = (n[0] ?? 0) * PI / 180, cs = Math.cos(a), sn = Math.sin(a);
        step = [cs, sn, -sn, cs, 0, 0];
        /* rotate(a cx cy) turns about a point, which is three transforms in a
           coat — and the shorthand is what Illustrator writes, so it is not an
           exotic case to skip. */
        if (n.length >= 3) {
          const cx = n[1]!, cy = n[2]!;
          step = mul(mul([1, 0, 0, 1, cx, cy], step), [1, 0, 0, 1, -cx, -cy]);
        }
        break;
      }
      case 'matrix': {
        if (n.length < 6) {
          refuse('That SVG has a transform="matrix(…)" with fewer than six numbers in it. '
            + 'The markup is malformed and there is no safe way to read what was meant.');
        }
        step = [n[0]!, n[1]!, n[2]!, n[3]!, n[4]!, n[5]!];
        break;
      }
      default:
        return refuse(`That SVG places a shape with transform="${fn}(…)", which this converter `
          + 'does not understand. Rather than guess and put the geometry in the wrong place, '
          + 'the file is refused. Re-export it with the transform applied to the shapes.');
    }
    out = mul(out, step);
  }
  if (!found) {
    refuse(`That SVG has a transform="${t.trim().slice(0, 40)}" that is not a transform list. `
      + 'The markup is malformed.');
  }
  return out;
}

/* ── walking the drawing ──────────────────────────────────────────────── */

interface Ctx {
  ents: Ent[];
  ids: Map<string, El>;
  vw: number;
  vh: number;
  sawText: boolean;
  sawImage: boolean;
}

/* Elements that hold markup which is never itself drawn. <defs> and friends are
   templates; a <clipPath>'s outline shapes something else rather than appearing
   itself; <style>, <title> and <metadata> are not geometry at all. Emitting any
   of them would put lines in the CAD file that are nowhere in the picture. */
const NOT_DRAWN = new Set(['defs', 'symbol', 'clippath', 'mask', 'marker', 'pattern',
  'lineargradient', 'radialgradient', 'filter', 'style', 'title', 'desc', 'metadata',
  'script', 'foreignobject']);

function hidden(el: El): boolean {
  if (el.attrs.get('display')?.trim() === 'none') return true;
  const vis = el.attrs.get('visibility')?.trim();
  if (vis === 'hidden' || vis === 'collapse') return true;
  const style = el.attrs.get('style');
  return !!style && /(^|;)\s*(display\s*:\s*none|visibility\s*:\s*(hidden|collapse))/i.test(style);
}

function walk(el: El, m: M, ctx: Ctx, depth: number): void {
  const name = el.name.toLowerCase();
  if (NOT_DRAWN.has(name) || hidden(el)) return;
  /* Neither of these becomes geometry, so neither is worth reading a transform
     for — and a drawing should not be refused over a CSS transform sitting on a
     label that was going to be left out regardless. */
  if (name === 'text') { ctx.sawText = true; return; }
  if (name === 'image') { ctx.sawImage = true; return; }

  const own = transformOf(el);
  const ctm = own ? mul(m, own) : m;

  switch (name) {
    case 'g': case 'a':
      for (const k of el.kids) walk(k, ctm, ctx, depth);
      return;

    /* <switch> draws the first child whose conditions are met and nothing else.
       Drawing all of them would stack a drawing's language variants on top of
       each other, so only the first is taken. */
    case 'switch': {
      const first = el.kids[0];
      if (first) walk(first, ctm, ctx, depth);
      return;
    }

    case 'svg': {
      if (el.attrs.get('viewBox')) {
        refuse('That SVG has a second drawing nested inside it with a viewBox of its own, '
          + 'which rescales everything under it. Working that out is not something this '
          + 'converter does, and the shapes would land at the wrong size. Flatten the file '
          + 'in the program that drew it.');
      }
      const x = length(el.attrs.get('x'), ctx.vw) ?? 0;
      const y = length(el.attrs.get('y'), ctx.vh) ?? 0;
      const inner = x || y ? mul(ctm, [1, 0, 0, 1, x, y]) : ctm;
      for (const k of el.kids) walk(k, inner, ctx, depth);
      return;
    }

    case 'use': {
      useShape(el, ctm, ctx, depth);
      return;
    }

    case 'line': {
      const a = pt(ctm, length(el.attrs.get('x1'), ctx.vw) ?? 0, length(el.attrs.get('y1'), ctx.vh) ?? 0);
      const b = pt(ctm, length(el.attrs.get('x2'), ctx.vw) ?? 0, length(el.attrs.get('y2'), ctx.vh) ?? 0);
      if (!same(a, b)) ctx.ents.push({kind: 'line', a, b});
      return;
    }

    case 'polyline': case 'polygon': {
      const n = numbers(el.attrs.get('points') ?? '');
      const pts: Pt[] = [];
      for (let k = 0; k + 1 < n.length; k += 2) pts.push(pt(ctm, n[k]!, n[k + 1]!));
      emit(ctx.ents, pts, name === 'polygon');
      return;
    }

    case 'rect': { rectShape(el, ctm, ctx); return; }
    case 'circle': case 'ellipse': { roundShape(el, ctm, ctx, name === 'circle'); return; }

    case 'path': {
      const d = el.attrs.get('d');
      if (d) pathShape(d, ctm, ctx.ents);
      return;
    }

    default:
      for (const k of el.kids) walk(k, ctm, ctx, depth);
  }
}

/* A <use> is the one place an SVG's geometry lives somewhere other than where
   it is drawn. Skipping it would drop shapes without saying so, which is the
   one thing this converter must not do — so the reference is followed, and the
   two cases it cannot follow honestly are named and refused. */
function useShape(el: El, ctm: M, ctx: Ctx, depth: number): void {
  const href = (el.attrs.get('href') ?? el.attrs.get('xlink:href') ?? '').trim();
  if (!href.startsWith('#')) {
    refuse('That SVG reuses a shape from another file, and only the one file you gave it is '
      + 'here to read. Export the drawing with its shapes in place.');
  }
  if (depth >= 8) {
    refuse('That SVG reuses shapes inside themselves and the references never bottom out.');
  }
  const target = ctx.ids.get(href.slice(1))
    ?? refuse(`That SVG reuses a shape called "${href}" that is not anywhere in the file, so `
      + 'there is nothing to draw in its place.');

  const kind = target.name.toLowerCase();
  if ((kind === 'symbol' || kind === 'svg') && target.attrs.get('viewBox')) {
    refuse('That SVG reuses a <symbol> with a viewBox of its own, which scales each copy by '
      + 'a factor this converter does not work out. Flatten the file in the program that '
      + 'drew it and export again.');
  }

  const x = length(el.attrs.get('x'), ctx.vw) ?? 0;
  const y = length(el.attrs.get('y'), ctx.vh) ?? 0;
  const inner = x || y ? mul(ctm, [1, 0, 0, 1, x, y]) : ctm;

  /* A <symbol> is never drawn where it is written; through a <use> it is, and
     what gets drawn is its children — walking the symbol itself would land on
     the not-drawn list and quietly produce nothing. */
  if (kind === 'symbol') for (const k of target.kids) walk(k, inner, ctx, depth + 1);
  else walk(target, inner, ctx, depth + 1);
}

/* ── shapes ───────────────────────────────────────────────────────────── */

function rectShape(el: El, m: M, ctx: Ctx): void {
  const x = length(el.attrs.get('x'), ctx.vw) ?? 0;
  const y = length(el.attrs.get('y'), ctx.vh) ?? 0;
  const w = length(el.attrs.get('width'), ctx.vw) ?? 0;
  const h = length(el.attrs.get('height'), ctx.vh) ?? 0;
  /* A rectangle with no width is not drawn at all, rather than drawn as a line
     — the spec is explicit, and so is every renderer. */
  if (!(w > 0) || !(h > 0)) return;

  /* rx alone means both corners are round by that much; the pair is only
     independent when both are written. Either is clamped at half the side,
     which is where a "rounded" rectangle becomes a stadium. */
  const rxRaw = length(el.attrs.get('rx'), ctx.vw);
  const ryRaw = length(el.attrs.get('ry'), ctx.vh);
  const rx = Math.min(Math.max(rxRaw ?? ryRaw ?? 0, 0), w / 2);
  const ry = Math.min(Math.max(ryRaw ?? rxRaw ?? 0, 0), h / 2);

  if (!(rx > 0) || !(ry > 0)) {
    emit(ctx.ents, [pt(m, x, y), pt(m, x + w, y), pt(m, x + w, y + h), pt(m, x, y + h)], true);
    return;
  }

  /* The corners are quarter ellipses, and an affine map leaves an ellipse an
     ellipse — so the two radius vectors are mapped once and every corner is
     sampled from the same pair. */
  const u: Pt = [m[0] * rx, m[1] * rx];
  const v: Pt = [m[2] * ry, m[3] * ry];
  const pts: Pt[] = [pt(m, x + rx, y), pt(m, x + w - rx, y)];
  const corner = (cx: number, cy: number, a0: number, a1: number) => {
    for (const p of arcPoints(pt(m, cx, cy), u, v, a0, a1, false)) pts.push(p);
  };
  corner(x + w - rx, y + ry, -PI / 2, 0);
  pts.push(pt(m, x + w, y + h - ry));
  corner(x + w - rx, y + h - ry, 0, PI / 2);
  pts.push(pt(m, x + rx, y + h));
  corner(x + rx, y + h - ry, PI / 2, PI);
  pts.push(pt(m, x, y + ry));
  corner(x + rx, y + ry, PI, PI * 1.5);
  emit(ctx.ents, pts, true);
}

function roundShape(el: El, m: M, ctx: Ctx, isCircle: boolean): void {
  const cx = length(el.attrs.get('cx'), ctx.vw) ?? 0;
  const cy = length(el.attrs.get('cy'), ctx.vh) ?? 0;
  const rx = isCircle
    ? length(el.attrs.get('r'), Math.hypot(ctx.vw, ctx.vh) / Math.SQRT2) ?? 0
    : length(el.attrs.get('rx'), ctx.vw) ?? 0;
  const ry = isCircle ? rx : length(el.attrs.get('ry'), ctx.vh) ?? 0;
  if (!(rx > 0) || !(ry > 0)) return;

  /* A real CIRCLE entity where the transform genuinely leaves a circle: a CAD
     user can snap to its centre and dimension its diameter, and a polyline of
     a hundred chords gives them neither. Anything squashed becomes an ellipse,
     which R12 has no entity for, so it is flattened. */
  if (rx === ry && conformal(m)) {
    ctx.ents.push({kind: 'circle', c: pt(m, cx, cy), r: rx * Math.hypot(m[0], m[1])});
    return;
  }
  const u: Pt = [m[0] * rx, m[1] * rx];
  const v: Pt = [m[2] * ry, m[3] * ry];
  emit(ctx.ents, arcPoints(pt(m, cx, cy), u, v, 0, 2 * PI, true), true);
}

/* ── path data ────────────────────────────────────────────────────────── */

/* Every command in the grammar, including the arcs — an <path> that quietly
 * dropped its A segments would produce a shape that looks finished and is not.
 *
 * Control points are mapped into DXF space before anything is flattened. A
 * bezier is affine-invariant, so this is the same curve either way, and it puts
 * the chord tolerance in millimetres instead of in user units, where it would
 * mean a different thing in every file. */
function pathShape(d: string, m: M, ents: Ent[]): void {
  let i = 0;
  const digit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';
  const skip = () => {
    while (i < d.length && (d[i] === ',' || d[i] === ' ' || d[i] === '\t'
      || d[i] === '\n' || d[i] === '\r' || d[i] === '\f')) i++;
  };
  const num = (): number | null => {
    skip();
    const start = i;
    if (d[i] === '+' || d[i] === '-') i++;
    let seen = 0;
    while (digit(d[i])) { i++; seen++; }
    if (d[i] === '.') { i++; while (digit(d[i])) { i++; seen++; } }
    if (!seen) { i = start; return null; }
    if (d[i] === 'e' || d[i] === 'E') {
      const save = i;
      i++;
      if (d[i] === '+' || d[i] === '-') i++;
      if (digit(d[i])) { while (digit(d[i])) i++; } else i = save;
    }
    const v = Number(d.slice(start, i));
    return Number.isFinite(v) ? v : null;
  };
  /* The arc flags are single characters, not numbers, and they are allowed to
     run together with what follows: "a5 5 0 1150 20" is large=1, sweep=1, then
     50 and 20. Reading them with the number scanner turns that into 1150 and
     puts the rest of the path somewhere else entirely. */
  const flag = (): number | null => {
    skip();
    if (d[i] === '0') { i++; return 0; }
    if (d[i] === '1') { i++; return 1; }
    return null;
  };

  let cur: Pt = [0, 0], sub: Pt = [0, 0];
  let cCtl: Pt | null = null, qCtl: Pt | null = null;
  let pts: Pt[] = [];
  let closed = false;

  const flush = () => { emit(ents, pts, closed); pts = []; closed = false; };
  const open = () => { if (!pts.length) pts.push(pt(m, cur[0], cur[1])); };
  const lineTo = (x: number, y: number) => { open(); pts.push(pt(m, x, y)); cur = [x, y]; };
  const cubicTo = (x1: number, y1: number, x2: number, y2: number, x: number, y: number) => {
    open();
    flattenCubic(pt(m, cur[0], cur[1]), pt(m, x1, y1), pt(m, x2, y2), pt(m, x, y), pts);
    cur = [x, y]; cCtl = [x2, y2]; qCtl = null;
  };
  const quadTo = (x1: number, y1: number, x: number, y: number) => {
    open();
    flattenQuad(pt(m, cur[0], cur[1]), pt(m, x1, y1), pt(m, x, y), pts);
    cur = [x, y]; qCtl = [x1, y1]; cCtl = null;
  };

  let cmd = '';
  let stop = false;
  while (!stop) {
    skip();
    if (i >= d.length) break;
    const c = d[i]!;
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')) { cmd = c; i++; }
    else if (!cmd) break;

    const rel = cmd >= 'a';
    const ox = rel ? cur[0] : 0, oy = rel ? cur[1] : 0;
    switch (cmd.toUpperCase()) {
      case 'M': {
        const x = num(), y = num();
        if (x === null || y === null) { stop = true; break; }
        flush();
        cur = [ox + x, oy + y];
        sub = [cur[0], cur[1]];
        pts = [pt(m, cur[0], cur[1])];
        cCtl = qCtl = null;
        /* A moveto followed by more numbers is a moveto and then linetos —
           which is how nearly every exporter writes a polygon. */
        cmd = rel ? 'l' : 'L';
        break;
      }
      case 'L': {
        const x = num(), y = num();
        if (x === null || y === null) { stop = true; break; }
        lineTo(ox + x, oy + y); cCtl = qCtl = null;
        break;
      }
      case 'H': {
        const x = num();
        if (x === null) { stop = true; break; }
        lineTo(ox + x, cur[1]); cCtl = qCtl = null;
        break;
      }
      case 'V': {
        const y = num();
        if (y === null) { stop = true; break; }
        lineTo(cur[0], oy + y); cCtl = qCtl = null;
        break;
      }
      case 'C': {
        const x1 = num(), y1 = num(), x2 = num(), y2 = num(), x = num(), y = num();
        if (x1 === null || y1 === null || x2 === null || y2 === null || x === null || y === null) { stop = true; break; }
        cubicTo(ox + x1, oy + y1, ox + x2, oy + y2, ox + x, oy + y);
        break;
      }
      case 'S': {
        const x2 = num(), y2 = num(), x = num(), y = num();
        if (x2 === null || y2 === null || x === null || y === null) { stop = true; break; }
        const rx = cCtl ? 2 * cur[0] - cCtl[0] : cur[0];
        const ry = cCtl ? 2 * cur[1] - cCtl[1] : cur[1];
        cubicTo(rx, ry, ox + x2, oy + y2, ox + x, oy + y);
        break;
      }
      case 'Q': {
        const x1 = num(), y1 = num(), x = num(), y = num();
        if (x1 === null || y1 === null || x === null || y === null) { stop = true; break; }
        quadTo(ox + x1, oy + y1, ox + x, oy + y);
        break;
      }
      case 'T': {
        const x = num(), y = num();
        if (x === null || y === null) { stop = true; break; }
        const rx = qCtl ? 2 * cur[0] - qCtl[0] : cur[0];
        const ry = qCtl ? 2 * cur[1] - qCtl[1] : cur[1];
        quadTo(rx, ry, ox + x, oy + y);
        break;
      }
      case 'A': {
        const rx = num(), ry = num(), rot = num();
        const large = flag(), sweep = flag();
        const x = num(), y = num();
        if (rx === null || ry === null || rot === null || large === null
          || sweep === null || x === null || y === null) { stop = true; break; }
        open();
        arcSegment(m, cur, rx, ry, rot, large, sweep, ox + x, oy + y, pts);
        cur = [ox + x, oy + y];
        cCtl = qCtl = null;
        break;
      }
      case 'Z': {
        if (pts.length) { closed = true; flush(); }
        cur = [sub[0], sub[1]];
        cCtl = qCtl = null;
        break;
      }
      default:
        stop = true;
    }
  }
  flush();
}

/* An SVG arc says where it ends and how round it is; a sampler needs to know
   where its centre is. This is the endpoint-to-centre conversion out of the
   spec's implementation notes, done in user units, after which the ellipse's
   two radius vectors are mapped into DXF space and sampled like any other. */
function arcSegment(
  m: M, from: Pt, rx0: number, ry0: number, rotDeg: number,
  large: number, sweep: number, x: number, y: number, out: Pt[],
): void {
  const [x0, y0] = from;
  /* An arc that ends where it began draws nothing, and an arc with a zero
     radius is a straight line — both are in the spec, and both would otherwise
     divide by zero below. */
  if (x0 === x && y0 === y) return;
  let rx = Math.abs(rx0), ry = Math.abs(ry0);
  if (rx === 0 || ry === 0) { out.push(pt(m, x, y)); return; }

  const phi = rotDeg * PI / 180, cs = Math.cos(phi), sn = Math.sin(phi);
  const dx = (x0 - x) / 2, dy = (y0 - y) / 2;
  const x1 = cs * dx + sn * dy, y1 = -sn * dx + cs * dy;
  /* Radii too small to reach across the gap are scaled up until they just do,
     which is what the spec asks for rather than an error. */
  const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s; }

  const top = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const bot = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  const co = (large !== sweep ? 1 : -1) * Math.sqrt(Math.max(0, top / bot));
  const cxp = co * rx * y1 / ry, cyp = -co * ry * x1 / rx;
  const cx = cs * cxp - sn * cyp + (x0 + x) / 2;
  const cy = sn * cxp + cs * cyp + (y0 + y) / 2;

  const ux = (x1 - cxp) / rx, uy = (y1 - cyp) / ry;
  const vx = (-x1 - cxp) / rx, vy = (-y1 - cyp) / ry;
  const a0 = Math.atan2(uy, ux);
  let da = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  if (!sweep && da > 0) da -= 2 * PI;
  if (sweep && da < 0) da += 2 * PI;

  const u: Pt = [m[0] * rx * cs + m[2] * rx * sn, m[1] * rx * cs + m[3] * rx * sn];
  const v: Pt = [m[0] * -ry * sn + m[2] * ry * cs, m[1] * -ry * sn + m[3] * ry * cs];
  for (const p of arcPoints(pt(m, cx, cy), u, v, a0, a0 + da, false)) out.push(p);
  /* The sampled endpoint is a rounding error away from the one the path
     declared; the declared one is what the next segment starts from, so it is
     what goes in the file. */
  if (out.length) out[out.length - 1] = pt(m, x, y);
}

/* ── flattening ───────────────────────────────────────────────────────── */

/* How many chords a curve needs. The deviation of a bezier from n straight
   segments is at most max|B''| / 8n², so the count falls straight out of the
   tolerance — no subdivision, no recursion, and no guessing a fixed number
   that is wasteful on a short curve and visibly faceted on a long one. */
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

function flattenQuad(p0: Pt, p1: Pt, p2: Pt, out: Pt[]): void {
  const n = steps(2 * Math.hypot(p0[0] - 2 * p1[0] + p2[0], p0[1] - 2 * p1[1] + p2[1]));
  for (let k = 1; k <= n; k++) {
    const t = k / n, u = 1 - t;
    out.push([
      u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
      u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
    ]);
  }
}

/* Points along an ellipse already mapped into DXF space: `c` is its centre and
   `u`, `v` are the images of its two radius vectors, which is all an affine
   transform leaves of one. The step comes from the sagitta of a chord —
   r(1 − cos(θ/2)) — so a small arc gets a few points and a large one gets many,
   both to the same accuracy. */
function arcPoints(c: Pt, u: Pt, v: Pt, a0: number, a1: number, first: boolean): Pt[] {
  const r = Math.max(Math.hypot(u[0], u[1]), Math.hypot(v[0], v[1]));
  const step = r > TOL ? 2 * Math.acos(Math.max(-1, 1 - TOL / r)) : PI / 2;
  const n = Math.min(2048, Math.max(2, Math.ceil(Math.abs(a1 - a0) / step)));
  const out: Pt[] = [];
  for (let k = first ? 0 : 1; k <= n; k++) {
    const t = a0 + (a1 - a0) * (k / n);
    const cs = Math.cos(t), sn = Math.sin(t);
    out.push([c[0] + u[0] * cs + v[0] * sn, c[1] + u[1] * cs + v[1] * sn]);
  }
  return out;
}

/* ── entities ─────────────────────────────────────────────────────────── */

const same = (a: Pt, b: Pt) => Math.abs(a[0] - b[0]) < 1e-7 && Math.abs(a[1] - b[1]) < 1e-7;

/* Two points and nothing between them is a LINE, not a polyline of two
   vertices: it is what the drawing meant, it is a third of the group codes, and
   CAD trims and extends behave better on one. Closed makes no difference at two
   points — a closed two-gon is the same line drawn there and back. */
function emit(ents: Ent[], raw: Pt[], closed: boolean): void {
  const pts: Pt[] = [];
  for (const p of raw) {
    const last = pts[pts.length - 1];
    if (!last || !same(last, p)) pts.push(p);
  }
  /* A closed polyline joins its last vertex to its first on its own, so a
     repeated start point would draw a zero-length segment there. */
  if (closed && pts.length > 1 && same(pts[0]!, pts[pts.length - 1]!)) pts.pop();
  if (pts.length < 2) return;
  if (pts.length === 2) ents.push({kind: 'line', a: pts[0]!, b: pts[1]!});
  else ents.push({kind: 'poly', pts, closed});
}

interface Box {minX: number; minY: number; maxX: number; maxY: number}

function extents(ents: Ent[]): Box {
  const box: Box = {minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity};
  const see = (x: number, y: number) => {
    box.minX = Math.min(box.minX, x); box.maxX = Math.max(box.maxX, x);
    box.minY = Math.min(box.minY, y); box.maxY = Math.max(box.maxY, y);
  };
  for (const e of ents) {
    if (e.kind === 'line') { see(e.a[0], e.a[1]); see(e.b[0], e.b[1]); }
    else if (e.kind === 'circle') {
      see(e.c[0] - e.r, e.c[1] - e.r); see(e.c[0] + e.r, e.c[1] + e.r);
    } else for (const p of e.pts) see(p[0], p[1]);
  }
  return box;
}

function shift(ents: Ent[], dy: number): void {
  for (const e of ents) {
    if (e.kind === 'line') { e.a[1] += dy; e.b[1] += dy; }
    else if (e.kind === 'circle') e.c[1] += dy;
    else for (const p of e.pts) p[1] += dy;
  }
}

/* ── writing DXF ──────────────────────────────────────────────────────── */

/* Six decimals is a nanometre at these sizes — past any machine's resolution
   and past the point where more digits are anything but file size. The minus
   sign in front of a rounded zero is stripped because some readers show it. */
const f = (n: number): string => {
  const s = n.toFixed(6);
  return s === '-0.000000' ? '0.000000' : s;
};

function write(ents: Ent[], box: Box): string {
  const out: string[] = [];
  const g = (code: number, value: string | number) => { out.push(String(code), String(value)); };

  g(0, 'SECTION'); g(2, 'HEADER');
  g(9, '$ACADVER'); g(1, 'AC1009');
  /* Millimetres, said out loud. It postdates R12 and older readers step over
     it, but every current one uses it to place the drawing at its true size
     instead of assuming whatever the template was set to. */
  g(9, '$INSUNITS'); g(70, 4);
  g(9, '$EXTMIN'); g(10, f(box.minX)); g(20, f(box.minY)); g(30, '0.0');
  g(9, '$EXTMAX'); g(10, f(box.maxX)); g(20, f(box.maxY)); g(30, '0.0');
  g(0, 'ENDSEC');

  /* The layer has to exist before anything can be on it, and the linetype it
     names has to exist before the layer — readers that check will otherwise
     reject a file whose entities are perfectly good. */
  g(0, 'SECTION'); g(2, 'TABLES');
  g(0, 'TABLE'); g(2, 'LTYPE'); g(70, 1);
  g(0, 'LTYPE'); g(2, 'CONTINUOUS'); g(70, 0); g(3, 'Solid line');
  g(72, 65); g(73, 0); g(40, '0.0');
  g(0, 'ENDTAB');
  g(0, 'TABLE'); g(2, 'LAYER'); g(70, 1);
  g(0, 'LAYER'); g(2, '0'); g(70, 0); g(62, 7); g(6, 'CONTINUOUS');
  g(0, 'ENDTAB');
  g(0, 'ENDSEC');

  g(0, 'SECTION'); g(2, 'ENTITIES');
  for (const e of ents) {
    if (e.kind === 'line') {
      g(0, 'LINE'); g(8, '0');
      g(10, f(e.a[0])); g(20, f(e.a[1])); g(30, '0.0');
      g(11, f(e.b[0])); g(21, f(e.b[1])); g(31, '0.0');
    } else if (e.kind === 'circle') {
      g(0, 'CIRCLE'); g(8, '0');
      g(10, f(e.c[0])); g(20, f(e.c[1])); g(30, '0.0');
      g(40, f(e.r));
    } else {
      /* An R12 POLYLINE is a header, its vertices as separate entities, and a
         SEQEND to say that was all of them. The 66 flag is what tells a reader
         the vertices follow, and the 10/20/30 on the header is an unused
         elevation point that has to be there regardless. */
      g(0, 'POLYLINE'); g(8, '0'); g(66, 1); g(70, e.closed ? 1 : 0);
      g(10, '0.0'); g(20, '0.0'); g(30, '0.0');
      for (const p of e.pts) {
        g(0, 'VERTEX'); g(8, '0');
        g(10, f(p[0])); g(20, f(p[1])); g(30, '0.0');
      }
      g(0, 'SEQEND'); g(8, '0');
    }
  }
  g(0, 'ENDSEC');
  g(0, 'EOF');

  /* CRLF throughout. The format is old enough that a handful of readers still
     split on it rather than on a bare newline, and nothing minds the extra
     byte. */
  return out.join('\r\n') + '\r\n';
}
