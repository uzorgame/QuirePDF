/* PowerPoint in, pages out — the words, not the design.
 *
 * A .pptx is a zip of XML with one part per slide, so the text of a deck is
 * recoverable exactly. Its appearance is not: the shapes, theme colours,
 * gradients, charts and SmartArt are drawn by PowerPoint's own renderer, and
 * nothing in a browser reproduces them. So this does not pretend to be
 * PowerPoint's own export. It takes what is genuinely in the file — each
 * slide's text, in the deck's order, with the title set apart — and puts it on
 * a page the shape of the slide, so the result still reads as a deck. A file
 * whose slides are entirely pictures is refused rather than handed back as a
 * stack of blank pages.
 *
 * Speaker notes live in ppt/notesSlides/ and are never read: they are not part
 * of the deck, and a converter that quietly published them would be the worst
 * kind of surprise.
 */
import {PDFDocument, StandardFonts, rgb} from 'pdf-lib';
import type {PDFFont} from 'pdf-lib';
import {Refused, looksLike} from '../heavy.ts';
import {needsUnicode, unicodeFont} from '../../core/unicodeFont.ts';

const refuse = (m: string): never => { throw new Refused(m); };

/* ── the XML ──────────────────────────────────────────────────────────── */

/* Read with a small hand-written scan rather than DOMParser. DOMParser is a
 * window-only API, so a module that uses it cannot run in a worker or be
 * checked against real files outside a browser; what a slide part needs from a
 * parser is only elements, attributes, text and the order they arrived in.
 *
 * It is a scan and not a pattern over tags, which is the part that matters: a
 * `>` inside an attribute value is legal XML, and a regular expression that
 * stops at the first one loses the rest of the shape without saying so. */
interface XEl {name: string; attrs: Record<string, string>; kids: Array<XEl | string>}

const ENTITY: Record<string, string> = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'"};

function decode(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (all: string, body: string) => {
    if (body[0] === '#') {
      const n = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : Number(body.slice(1));
      /* An out-of-range escape is dropped rather than thrown on: one bad
         numeric reference in a footer should not cost the whole deck. */
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
    /* Prefixes are kept on attribute names. Stripping them looks tidier until
       <p:sldId id="256" r:id="rId2"/>, where both would become "id" and the
       relationship the slide order depends on would be overwritten. */
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
           unbalanced tag costs the shape it is in and not everything after. */
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

/* Everything in a pptx is namespaced — p:, a:, r: — and the prefixes are only
   conventional, so elements are matched on the part after the colon. */
const local = (name: string) => name.slice(name.indexOf(':') + 1);
const els = (el: XEl): XEl[] => el.kids.filter((k): k is XEl => typeof k !== 'string');
const child = (el: XEl, name: string) => els(el).find(k => local(k.name) === name);
const childrenNamed = (el: XEl, name: string) => els(el).filter(k => local(k.name) === name);

function path(from: XEl, ...names: string[]): XEl | undefined {
  let cur: XEl | undefined = from;
  for (const n of names) {
    if (!cur) return undefined;
    cur = child(cur, n);
  }
  return cur;
}

function descendant(el: XEl, name: string): XEl | undefined {
  for (const k of els(el)) {
    if (local(k.name) === name) return k;
    const hit = descendant(k, name);
    if (hit) return hit;
  }
  return undefined;
}

/* A namespaced attribute — r:id, r:dm — found by its local name, because the
   prefix a file binds to the relationships namespace is its own business. Only
   prefixed attributes are considered, so this can never answer with the plain
   id of an element that also carries an r:id. */
function nsAttr(el: XEl, name: string): string | undefined {
  for (const [k, v] of Object.entries(el.attrs)) {
    if (k.includes(':') && local(k) === name) return v;
  }
  return undefined;
}

/* ── a slide's text ───────────────────────────────────────────────────── */

interface Piece {title: boolean; lines: string[]}

/* A placeholder that repeats the same thing on every slide. Its text is not
   content — a page numbered "7" in the middle of a paragraph is worse than no
   number at all, and this PDF's pages are not the deck's slides anyway. */
const FURNITURE = new Set(['sldNum', 'ftr', 'dt']);

/* The paragraphs of one text body. <a:p> is a paragraph and <a:br> a line break
   inside one; both become lines here. <a:fld> is skipped because what it holds
   is the value PowerPoint last computed for a field, not something anybody
   typed. Runs are reached by walking rather than by looking for <a:r>, so text
   inside a hyperlink or a maths block is picked up too. */
function bodyLines(txBody: XEl): string[] {
  const out: string[] = [];
  for (const para of childrenNamed(txBody, 'p')) {
    let line = '';
    const walk = (el: XEl) => {
      for (const k of els(el)) {
        const n = local(k.name);
        if (n === 'fld') continue;
        if (n === 't') line += k.kids.filter(x => typeof x === 'string').join('');
        else if (n === 'br') line += '\n';
        else walk(k);
      }
    };
    walk(para);
    for (const piece of line.split('\n')) out.push(piece.trimEnd());
  }
  /* Trailing empties are the empty paragraphs a half-filled text box leaves
     behind; they would otherwise push the next shape down the page. */
  while (out.length && !out[out.length - 1]!.trim()) out.pop();
  return out;
}

function shapePieces(tree: XEl, out: Piece[], diagrams: Map<string, string[]>): void {
  for (const el of els(tree)) {
    const n = local(el.name);

    if (n === 'grpSp') { shapePieces(el, out, diagrams); continue; }

    if (n === 'sp') {
      const ph = path(el, 'nvSpPr', 'nvPr', 'ph');
      /* <p:ph> with no type attribute means a body placeholder, which is why
         the absent case is not treated as "unknown". */
      const type = ph ? ph.attrs['type'] ?? 'body' : '';
      if (FURNITURE.has(type)) continue;
      const txBody = child(el, 'txBody');
      if (!txBody) continue;
      const lines = bodyLines(txBody);
      if (lines.some(l => l.trim())) {
        out.push({title: type === 'title' || type === 'ctrTitle', lines});
      }
      continue;
    }

    if (n === 'graphicFrame') {
      /* SmartArt puts nothing on the slide but a pointer: the words are in
         ppt/diagrams/dataN.xml, which is why a converter that reads only the
         slide part loses a whole diagram without noticing. The drawing is
         PowerPoint's to make and is not attempted; the text of the nodes is
         real content and is kept, in the order the model lists them. */
      const relIds = descendant(el, 'relIds');
      const dm = relIds && nsAttr(relIds, 'dm');
      const smart = dm ? diagrams.get(dm) : undefined;
      if (smart) { out.push({title: false, lines: smart}); continue; }

      /* A table is the one piece of layout worth carrying across: read cell by
         cell it becomes a vertical list of fragments, which is unreadable. The
         cells of a row are joined onto one line instead. Their widths are not
         reproduced — that would need a table renderer, and this is not one —
         so the row reads as a row rather than lining up as a grid. */
      const tbl = descendant(el, 'tbl');
      if (!tbl) continue;
      const rows: string[] = [];
      for (const tr of childrenNamed(tbl, 'tr')) {
        const cells: string[] = [];
        for (const tc of childrenNamed(tr, 'tc')) {
          const txBody = child(tc, 'txBody');
          if (txBody) cells.push(bodyLines(txBody).join(' ').trim());
        }
        if (cells.some(c => c)) rows.push(cells.join('   '));
      }
      if (rows.length) out.push({title: false, lines: rows});
    }
  }
}

/* One slide part, read into the pieces that will be drawn.
 *
 * The title goes first whatever its place in the tree: the order of shapes in
 * <p:spTree> is stacking order, and a deck where the title was added last would
 * otherwise come out with its heading in the middle of the page. */
function readSlide(xml: string, diagrams: Map<string, string[]>): Piece[] {
  const tree = path(parseXml(xml), 'sld', 'cSld', 'spTree');
  if (!tree) return [];
  const pieces: Piece[] = [];
  shapePieces(tree, pieces, diagrams);
  return [...pieces.filter(p => p.title), ...pieces.filter(p => !p.title)];
}

/* The text of the SmartArt on one slide, keyed by the relationship the frame on
   the slide points at. */
async function readDiagrams(
  part: string, read: (name: string) => Promise<string | undefined>,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const dir = part.slice(0, part.lastIndexOf('/') + 1);
  const rels = await read(`${dir}_rels/${part.slice(dir.length)}.rels`);
  if (!rels) return out;

  for (const rel of relationships(rels, dir)) {
    if (!rel.type.endsWith('/diagramData')) continue;
    const xml = await read(rel.target);
    const ptLst = xml && path(parseXml(xml), 'dataModel', 'ptLst');
    if (!ptLst) continue;
    const lines: string[] = [];
    for (const pt of childrenNamed(ptLst, 'pt')) {
      /* A point with no type is a node somebody typed into. The others are the
         model's own scaffolding — "pres" points hold the layout's copy of the
         same words, and taking them too would print every line twice. */
      if ((pt.attrs['type'] ?? 'node') !== 'node') continue;
      const text = child(pt, 't');
      if (text) lines.push(...bodyLines(text));
    }
    if (lines.some(l => l.trim())) out.set(rel.id, lines);
  }
  return out;
}

/* ── slide order ──────────────────────────────────────────────────────── */

const SLIDE_PART = /^ppt\/slides\/slide(\d+)\.xml$/;

/* Numbered order, not the zip's — a zip has no order worth trusting, and
   slide10 sorts before slide2 as a string. This is the fallback: it is right
   for a deck nobody has rearranged, and it is all there is when the package
   does not say. */
function numberedOrder(names: string[]): string[] {
  return names
    .filter(n => SLIDE_PART.test(n))
    .sort((a, b) => Number(SLIDE_PART.exec(a)![1]) - Number(SLIDE_PART.exec(b)![1]));
}

interface Rel {id: string; type: string; target: string}

function relationships(xml: string, base: string): Rel[] {
  const root = path(parseXml(xml), 'Relationships');
  if (!root) return [];
  const out: Rel[] = [];
  for (const rel of childrenNamed(root, 'Relationship')) {
    const id = rel.attrs['Id'], to = rel.attrs['Target'];
    if (id && to) out.push({id, type: rel.attrs['Type'] ?? '', target: resolve(base, to)});
  }
  return out;
}

/* Relationship targets are written against the folder of the part that owns
   them, and may also be absolute from the root of the package. */
function resolve(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/').filter(Boolean);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

/* The order the deck is actually in.
 *
 * Moving a slide in PowerPoint does not rename its part — slide5.xml stays
 * slide5.xml and only <p:sldIdLst> is rewritten. So the numbers in the file
 * names are the order the slides were created in, which for any deck that has
 * ever been rearranged is not the order it is shown in. The list is the truth;
 * the numbers are the fallback for when it cannot be read. */
function slideOrder(presentation: string | undefined, rels: string | undefined,
                    names: Set<string>): string[] {
  if (!presentation || !rels) return numberedOrder([...names]);

  const target = new Map<string, string>();
  for (const rel of relationships(rels, 'ppt/')) target.set(rel.id, rel.target);

  const list = path(parseXml(presentation), 'presentation', 'sldIdLst');
  const ordered = list
    ? childrenNamed(list, 'sldId')
      .map(s => target.get(nsAttr(s, 'id') ?? ''))
      .filter((p): p is string => !!p && names.has(p))
    : [];

  /* A deck whose list is short — a damaged package, or one an unusual tool
     wrote — still gets every slide: the ones the list missed are appended in
     their numbered order rather than dropped. */
  const missing = numberedOrder([...names]).filter(n => !ordered.includes(n));
  return [...ordered, ...missing];
}

/* ── drawing ──────────────────────────────────────────────────────────── */

/* Slide size in points, from the package rather than assumed. PowerPoint
   measures in EMUs, 914400 to the inch, and 72 points to the inch makes 12700
   EMUs a point. Widescreen is the default because it has been PowerPoint's own
   since 2013; a deck that says otherwise is believed, within reason. */
function slideSize(presentation: string | undefined): {w: number; h: number} {
  const fallback = {w: 960, h: 540};
  if (!presentation) return fallback;
  const sz = path(parseXml(presentation), 'presentation', 'sldSz');
  const w = Number(sz?.attrs['cx']) / 12700, h = Number(sz?.attrs['cy']) / 12700;
  const sane = (n: number) => Number.isFinite(n) && n >= 72 && n <= 5000;
  return sane(w) && sane(h) ? {w: Math.round(w), h: Math.round(h)} : fallback;
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  let line = '';
  const push = () => {
    /* A single token wider than the column — a long URL, a file path — is cut
       rather than drawn off the edge of the page, which is the one failure a
       reader cannot see has happened. */
    let rest = line.replace(/\s+$/, '');
    while (font.widthOfTextAtSize(rest, size) > width && rest.length > 1) {
      let cut = rest.length;
      while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > width) cut--;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    out.push(rest);
  };
  for (const word of text.split(/(\s+)/)) {
    const next = line + word;
    if (font.widthOfTextAtSize(next, size) > width && line.trim()) {
      push();
      line = word.replace(/^\s+/, '');
    } else {
      line = next;
    }
  }
  push();
  return out;
}

/* Control bytes only. XML cannot legally carry them, but a file written by
   something other than Office can, and pdf-lib does not fail quietly: WinAnsi
   has no glyph for 0x81 and the save throws. The C1 range goes with them
   because needsUnicode counts 0x80–0x9F as Latin-1 and would leave that text on
   Helvetica, where those codepoints are exactly the undefined ones. */
function clean(text: string): string {
  let out = '';
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    out += c < 0x20 || (c >= 0x7f && c <= 0x9f) ? ' ' : ch;
  }
  return out;
}

/* ── the conversion ───────────────────────────────────────────────────── */

export async function pptxToPdf(bytes: Uint8Array): Promise<Blob> {
  const JSZip = (await import('jszip')).default;
  const zip = await (async () => {
    try { return await JSZip.loadAsync(bytes); }
    catch {
      /* D0 CF 11 E0 is the old OLE compound file, and both things it can be
         here need the same answer from the user. An encrypted .pptx is written
         into that same container, which is why the password case cannot be
         told apart from the 97-2003 one by looking. */
      const ole = bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
      const what = looksLike(bytes);
      return refuse(ole
        ? 'That file is not a .pptx package. It is either a PowerPoint 97-2003 .ppt or a '
          + 'password-protected presentation — Office writes both into the same old container. '
          + 'Open it in PowerPoint and save it again as an unprotected .pptx.'
        : what
        ? `That file is ${what}, not a PowerPoint deck — renaming it does not change what is `
          + 'inside.'
        : 'That file could not be opened. A .pptx is a zip archive, and this one does not '
          + 'unpack — it may be damaged.');
    }
  })();

  const read = async (name: string): Promise<string | undefined> => {
    const entry = zip.file(name);
    return entry && !Array.isArray(entry) ? entry.async('string') : undefined;
  };

  const names = new Set(Object.keys(zip.files).filter(n => SLIDE_PART.test(n)));
  if (!names.size) {
    return refuse(zip.file('content.xml')
      ? 'That is an OpenDocument presentation, not a PowerPoint one — the two are both zips '
        + 'of XML but nothing inside them is the same. Save it as .pptx first.'
      : 'That zip has no ppt/slides in it, so it is not a PowerPoint presentation.');
  }

  const presentation = await read('ppt/presentation.xml');
  const order = slideOrder(presentation, await read('ppt/_rels/presentation.xml.rels'), names);

  const deck: Piece[][] = [];
  for (const part of order) {
    const xml = await read(part);
    deck.push(xml ? readSlide(xml, await readDiagrams(part, read)) : []);
  }
  if (!deck.some(slide => slide.length)) {
    refuse('There is no text on any slide in that deck. What is on them — pictures, charts, '
      + 'SmartArt, drawn shapes — is rendered by PowerPoint itself, and a browser cannot '
      + 'redraw it. Export the deck to PDF from PowerPoint to keep the artwork.');
  }

  const {w, h} = slideSize(presentation);
  const doc = await PDFDocument.create();
  const all = deck.flat().flatMap(p => p.lines).join('\n');
  const uni = needsUnicode(all);
  const font = uni ? await unicodeFont(doc, 'sans') : await doc.embedFont(StandardFonts.Helvetica);
  const bold = uni ? await unicodeFont(doc, 'bold') : await doc.embedFont(StandardFonts.HelveticaBold);

  /* Type scaled to the slide, taking the usual 540-point-tall deck as the size
     everything was chosen against — otherwise a poster-sized deck comes out as
     11-point text marooned in the middle of a very large page. */
  const scale = Math.max(0.6, Math.min(3, h / 540));
  const M = Math.round(Math.min(w, h) * 0.09);
  const TITLE = 21 * scale, BODY = 13 * scale;
  const ink = rgb(0.09, 0.11, 0.15);
  const width = w - M * 2;

  let page = doc.addPage([w, h]);
  let y = h - M;
  const feed = () => { page = doc.addPage([w, h]); y = h - M; };

  deck.forEach((slide, index) => {
    /* One page per slide, always — including for a slide with nothing on it.
       A blank page is what a blank slide is, and dropping it would shift every
       page after it away from the slide someone is looking for. */
    if (index) feed();
    slide.forEach((piece, n) => {
      const size = piece.title ? TITLE : BODY;
      const face = piece.title ? bold : font;
      const lead = size * 1.45;
      if (n) y -= lead * 0.5;
      for (const source of piece.lines) {
        for (const line of wrap(clean(source), face, size, width)) {
          /* Text that outruns its slide continues on another page rather than
             being cut off. It breaks one page to one slide, which is the lesser
             harm: the alternative is losing words with nothing to show for it. */
          if (y - size < M) feed();
          if (line.trim()) {
            page.drawText(line, {x: M, y: y - size, size, font: face, color: ink});
          }
          y -= lead;
        }
      }
    });
  });

  return new Blob([(await doc.save()).slice() as BlobPart], {type: 'application/pdf'});
}
