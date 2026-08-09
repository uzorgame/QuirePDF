import {
  PDFDocument, PDFString, StandardFonts, LineCapStyle, BlendMode, rgb, degrees,
  setCharacterSpacing,
  type PDFFont, type PDFPage,
} from 'pdf-lib';
import type {FieldStore} from './fieldValues';
import {needsUnicode, unicodeFont, faceFor, ensureFontkit} from './unicodeFont';
import {docFace} from './docFonts';
import {arrowHead, rectOf, stampWidth, HIGHLIGHT_ALPHA, STAMP_HEIGHT, STAMP_SIZE,
        type Annot, type AnnotStore, type FontId, type TextAnnot} from './annots';

/* Writing the overlay into the file.
 *
 * This is the one place where the coordinate flip happens. The model keeps a
 * top-left origin because that is the browser's frame; PDF counts from the
 * bottom-left. `up()` converts, and nothing else in the codebase needs to know
 * that the two disagree. */

const hex = (h: string) => {
  const n = parseInt(h.replace('#', ''), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};

/* Near-black rather than pure black: it matches what the forms themselves
   print and stops filled answers looking pasted on. */
const INK = rgb(0.06, 0.09, 0.16);

export interface BurnDeps {
  /** Renders a page to PNG bytes with the given boxes painted opaque over it.
   *  Supplied by the caller because rasterising is pdf.js's job and this module
   *  only knows pdf-lib. Boxes are in top-left page points. */
  raster(
    page: number,
    scale: number,
    boxes: Array<{x: number; y: number; w: number; h: number}>,
  ): Promise<Uint8Array>;
}

type Fonts = Record<FontId, PDFFont>;

/* One entry per face the interface offers, so the file gets exactly what the
   screen showed rather than a rough family match. */
const STANDARD: Record<FontId, StandardFonts> = {
  'helvetica': StandardFonts.Helvetica,
  'helvetica-bold': StandardFonts.HelveticaBold,
  'helvetica-oblique': StandardFonts.HelveticaOblique,
  'helvetica-boldoblique': StandardFonts.HelveticaBoldOblique,
  'times': StandardFonts.TimesRoman,
  'times-bold': StandardFonts.TimesRomanBold,
  'times-italic': StandardFonts.TimesRomanItalic,
  'times-bolditalic': StandardFonts.TimesRomanBoldItalic,
  'courier': StandardFonts.Courier,
  'courier-bold': StandardFonts.CourierBold,
  'courier-oblique': StandardFonts.CourierOblique,
  'courier-boldoblique': StandardFonts.CourierBoldOblique,
  'symbol': StandardFonts.Symbol,
  'zapf': StandardFonts.ZapfDingbats,
};

/* The faces a document needs, standard where Latin-1 is enough and a real
   Unicode face where it is not.
 *
 * Only what is used gets embedded — a document with one Helvetica line has no
 * business carrying eleven font descriptors, and one with no Cyrillic in it has
 * no business carrying a 739 kB face. The Unicode one is fetched on demand and
 * subsetted, so a page of Ukrainian costs about eight kilobytes. */
async function faces(
  doc: PDFDocument, store: AnnotStore, values?: FieldStore,
): Promise<{fonts: Fonts; valueFont: PDFFont; faceFonts: Map<string, PDFFont>}> {
  const texts = store.all.filter(a => a.kind === 'text') as TextAnnot[];
  const used = new Set<FontId>(texts.map(a => a.font));
  used.add('helvetica');
  used.add('helvetica-bold');

  const fonts = {} as Fonts;
  for (const id of used) fonts[id] = await doc.embedFont(STANDARD[id]);

  /* Replaced per face rather than wholesale: a document with one Cyrillic
     caption and ten Latin ones keeps the standard face for the ten, which
     both looks right and keeps the file small. */
  for (const id of used) {
    if (!texts.some(a => a.font === id && needsUnicode(a.text))) continue;
    fonts[id] = await unicodeFont(doc, faceFor(id));
  }

  /* The document's own faces, embedded back where the text asks for them.
   *
   * This is what stops an edited heading changing typeface on export. pdf.js
   * hands over a sanitised OpenType copy of every embedded font; fontkit can
   * subset it, so the paragraph goes back into the file set in the same face it
   * was printed in — at the cost of the glyphs actually used, not the whole
   * font. Faces whose bytes pdf.js does not expose (Type3, some CFF) simply
   * stay out of the map, and the drawing falls back to the standard family the
   * annotation also carries. */
  const faceFonts = new Map<string, PDFFont>();
  ensureFontkit(doc);
  for (const name of new Set(texts.map(a => a.face).filter((n): n is string => !!n))) {
    const info = docFace(name);
    if (!info?.bytes) continue;
    try {
      faceFonts.set(name, await doc.embedFont(info.bytes.slice(), {subset: true}));
    } catch (err) {
      /* An unembeddable face costs itself, not the export — but silently is
         how a working feature and a broken one look identical, so say why. */
      console.warn(`Could not embed ${name}:`, err);
    }
  }

  /* Form answers are drawn in one face regardless of the marks, so they get
     their own decision — a Cyrillic name typed into an English form should
     appear, and it will not if the appearance font cannot draw it. */
  const typed = (values?.entries ?? []).map(([, v]) => v.value).join('');
  const valueFont = needsUnicode(typed)
    ? await unicodeFont(doc, 'sans')
    : fonts['helvetica']!;

  return {fonts, valueFont, faceFonts};
}

export async function burn(
  bytes: Uint8Array,
  store: AnnotStore,
  deps: BurnDeps,
  values?: FieldStore,
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes.slice());
  const {fonts, valueFont, faceFonts} = await faces(doc, store, values);

  /* What the user typed into the form's own fields goes in first, before any
     page is flattened — a redaction turns its page into an image, and a value
     written after that would have nothing left to be written into. */
  if (values?.size) await fill(doc, values, valueFont);

  /* Pages carrying a redaction are rebuilt from a picture of themselves.
     Drawing a black box over words leaves the words in the file, where anyone
     can select, copy or search them — the single most common way redaction is
     got wrong. Replacing the page with an image removes them for real. The
     cost is that the page stops being selectable text, and that trade is the
     honest one to make when someone has asked for something to be gone. */
  const redacted = new Set(
    store.all.filter(a => a.kind === 'region' && a.variant === 'redact').map(a => a.page),
  );

  for (const pageNo of redacted) await flattenPage(doc, pageNo, store, deps);

  for (let n = 1; n <= doc.getPageCount(); n++) {
    const page = doc.getPage(n - 1);
    for (const an of store.byPage(n)) {
      /* Redactions were baked into the raster; drawing them again would be
         harmless but pointless. */
      if (an.kind === 'region' && an.variant === 'redact') continue;
      draw(doc, page, an, fonts, faceFonts);
    }
  }

  return doc.save();
}


/* ── the flattening export ────────────────────────────────────────────────
 * Some government forms — most of USCIS's and SSA's — use object structures
 * pdf-lib refuses to parse, so the ordinary path cannot even open them, let
 * alone write into them. pdf.js renders them perfectly well, though, which
 * leaves one honest way out: photograph each page, build a fresh document from
 * those pictures, and draw the answers and marks on top.
 *
 * The result is a filled, printable, correct-looking form. What it is not is a
 * form that stays fillable — so the export dialog says so before you commit,
 * rather than letting you discover it in a reader afterwards. */
export async function burnFlat(
  pageCount: number,
  sizes: Array<{width: number; height: number}>,
  store: AnnotStore,
  deps: BurnDeps,
  values?: FieldStore,
  /* Called as each page is finished. A twenty-four page application takes the
     better part of a minute to redraw, and a spinner that says nothing for that
     long is indistinguishable from one that has hung. */
  onPage?: (done: number, total: number) => void,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const {fonts, valueFont, faceFonts} = await faces(doc, store, values);

  for (let n = 1; n <= pageCount; n++) {
    const size = sizes[n - 1] ?? {width: 595.28, height: 841.89};
    const boxes = store.byPage(n)
      .filter(a => a.kind === 'region' && a.variant === 'redact')
      .map(a => rectOf((a as Extract<Annot, {kind: 'region'}>).a, (a as Extract<Annot, {kind: 'region'}>).b));

    const png = await deps.raster(n, 2, boxes);
    const image = await doc.embedPng(png);
    const page = doc.addPage([size.width, size.height]);
    page.drawImage(image, {x: 0, y: 0, width: size.width, height: size.height});

    /* Field answers first, then the marks, so a stamp placed over a box still
       lands on top of the text in it. */
    if (values?.size) drawValues(page, n, values, valueFont);
    for (const an of store.byPage(n)) {
      if (an.kind === 'region' && an.variant === 'redact') continue;
      draw(doc, page, an, fonts, faceFonts);
    }

    onPage?.(n, pageCount);
    /* Back to the event loop between pages. Without it the whole run is one
       unbroken task and the label never repaints, which is the opposite of
       what reporting progress was for. */
    await new Promise(r => setTimeout(r, 0));
  }

  return doc.save();
}

function drawValues(page: PDFPage, pageNo: number, values: FieldStore, font: PDFFont): void {
  const H = page.getHeight();
  for (const [, v] of values.entries) {
    for (const b of v.boxes ?? []) {
      if (b.page !== pageNo) continue;
      const y = H - b.top - b.height;

      if (v.kind === 'check' || v.kind === 'radio') {
        if (!v.on) continue;
        /* Two strokes rather than a ✓ glyph: the tick then scales to whatever
           box the form gave it instead of overflowing a small one, and needs no
           extra font embedded to draw it. */
        const s = Math.min(b.width, b.height) * 0.6;
        const cx = b.left + b.width / 2, cy = y + b.height / 2;
        const pen = {thickness: Math.max(0.9, s * 0.16), color: INK, lineCap: LineCapStyle.Round};
        page.drawLine({
          start: {x: cx - s * 0.42, y: cy + s * 0.04},
          end: {x: cx - s * 0.1, y: cy - s * 0.3}, ...pen,
        });
        page.drawLine({
          start: {x: cx - s * 0.1, y: cy - s * 0.3},
          end: {x: cx + s * 0.44, y: cy + s * 0.36}, ...pen,
        });
        continue;
      }

      if (!v.value) continue;
      /* Shrunk to fit rather than wrapped. A wrapped answer would run out of
         the bottom of a one-line box and across whatever the form prints
         underneath it, which looks far worse than small type. */
      const room = Math.max(8, b.width - 4);
      let size = Math.min(b.height * 0.66, 11);
      const at = (n: number) => font.widthOfTextAtSize(v.value, n);
      if (at(size) > room) size = Math.max(4, (size * room) / at(size));
      page.drawText(v.value, {
        x: b.left + 2,
        /* Sat on the baseline the box implies rather than on its bottom edge,
           so the answer sits where a typed one would. */
        y: y + (b.height - size) / 2 + size * 0.2,
        size, font, color: INK,
      });
    }
  }
}

/* ── the form's own fields ────────────────────────────────────────────── */

async function fill(doc: PDFDocument, values: FieldStore, font: PDFFont): Promise<void> {
  let form;
  try { form = doc.getForm(); } catch { return; }

  for (const [name, v] of values.entries) {
    try {
      if (v.kind === 'text') {
        form.getTextField(name).setText(v.value);
      } else if (v.kind === 'choice') {
        const f = form.getDropdown(name);
        if (v.value) f.select(v.value); else f.clear();
      } else if (v.kind === 'radio') {
        const f = form.getRadioGroup(name);
        if (v.on) f.select(v.value); else f.clear();
      } else {
        const f = form.getCheckBox(name);
        if (v.on) f.check(); else f.uncheck();
      }
    } catch {
      /* A field that has gone missing, or is a kind pdf-lib types differently
         from pdf.js, costs its own value and not the export. */
    }
  }

  /* Without this the values live in the file but nothing draws them, so the
     form opens looking blank in every viewer that does not generate
     appearances itself — which includes most browsers. */
  try { form.updateFieldAppearances(font); } catch { /* best effort */ }
}

/* ── redaction ────────────────────────────────────────────────────────── */

async function flattenPage(
  doc: PDFDocument, pageNo: number, store: AnnotStore, deps: BurnDeps,
): Promise<void> {
  const source = doc.getPage(pageNo - 1);
  const {width, height} = source.getSize();
  const rotation = source.getRotation().angle;

  const boxes = store.byPage(pageNo)
    .filter(a => a.kind === 'region' && a.variant === 'redact')
    .map(a => rectOf((a as Extract<Annot, {kind: 'region'}>).a, (a as Extract<Annot, {kind: 'region'}>).b));

  /* 2× gives roughly 144 dpi — enough that the flattened page still prints
     acceptably without turning a 20-page document into 80 MB. */
  const png = await deps.raster(pageNo, 2, boxes);
  const image = await doc.embedPng(png);

  doc.removePage(pageNo - 1);
  const page = doc.insertPage(pageNo - 1, [width, height]);
  page.drawImage(image, {x: 0, y: 0, width, height});
  if (rotation) page.setRotation(degrees(rotation));
}

/* ── everything else ──────────────────────────────────────────────────── */

function draw(doc: PDFDocument, page: PDFPage, an: Annot, fonts: Fonts,
              faceFonts: Map<string, PDFFont>): void {
  const H = page.getHeight();
  /** top-left y → PDF y */
  const up = (y: number, h = 0) => H - y - h;

  switch (an.kind) {
    /* Text markup: highlight, strike, underline, squiggle.
     *
     * Drawn rather than written as PDF markup annotations. A real /Highlight
     * annotation would stay editable in Acrobat, but it also stays *removable*
     * in any reader — and someone who strikes a clause out of a contract before
     * sending it means the strike to be part of the document, not a sticky note
     * over it. Drawn marks are in the page content and survive the trip. */
    case 'mark': {
      const colour = hex(an.color);
      for (const r of an.rects) {
        if (an.variant === 'highlight') {
          /* Multiply, so the words underneath show through instead of being
             painted over. Without it a highlight is a coloured box with the
             text hidden behind it, which is the classic broken result. */
          page.drawRectangle({
            x: r.x, y: up(r.y, r.h), width: r.w, height: r.h,
            color: colour, opacity: HIGHLIGHT_ALPHA,
            blendMode: BlendMode.Multiply,
          });
          continue;
        }

        const weight = Math.max(0.7, r.h * 0.07);
        /* The same fractions the overlay uses, so the file matches the screen. */
        const yTop = an.variant === 'strike' ? r.y + r.h * 0.58 : r.y + r.h * 0.92;
        const y = up(yTop, 0);

        if (an.variant === 'squiggle') {
          const amp = Math.max(0.8, r.h * 0.09);
          const step = amp * 2.4;
          /* Straight segments between the peaks. pdf-lib has no quadratic
             helper, and at this amplitude the difference between a curve and a
             fine zigzag is invisible — it reads as a squiggle either way. */
          let x = r.x;
          let upward = true;
          while (x < r.x + r.w) {
            const end = Math.min(x + step, r.x + r.w);
            page.drawLine({
              start: {x, y},
              end: {x: (x + end) / 2, y: upward ? y + amp * 1.6 : y - amp * 1.6},
              thickness: weight, color: colour, lineCap: LineCapStyle.Round,
            });
            page.drawLine({
              start: {x: (x + end) / 2, y: upward ? y + amp * 1.6 : y - amp * 1.6},
              end: {x: end, y},
              thickness: weight, color: colour, lineCap: LineCapStyle.Round,
            });
            x = end;
            upward = !upward;
          }
          continue;
        }

        page.drawLine({
          start: {x: r.x, y}, end: {x: r.x + r.w, y},
          thickness: weight, color: colour,
        });
      }
      break;
    }

    case 'ink': {
      const d = an.pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ');
      /* drawSvgPath places the path with the SVG y-axis pointing down from the
         given origin, so anchoring at the top edge maps our coordinates
         straight through with no per-point arithmetic. */
      page.drawSvgPath(d, {
        x: 0, y: H,
        borderColor: hex(an.color),
        borderWidth: an.width,
        borderLineCap: an.variant === 'highlight' ? 0 : 1,
        opacity: 0,
        borderOpacity: an.variant === 'highlight' ? HIGHLIGHT_ALPHA : 1,
      });
      break;
    }

    case 'shape': {
      const r = rectOf(an.a, an.b);
      const stroke = hex(an.color);
      if (an.variant === 'rect') {
        page.drawRectangle({
          x: r.x, y: up(r.y, r.h), width: r.w, height: r.h,
          borderColor: stroke, borderWidth: an.width,
          ...(an.filled ? {color: stroke, opacity: 0.16} : {}),
        });
      } else if (an.variant === 'ellipse') {
        page.drawEllipse({
          x: r.x + r.w / 2, y: up(r.y + r.h / 2), xScale: r.w / 2, yScale: r.h / 2,
          borderColor: stroke, borderWidth: an.width,
          ...(an.filled ? {color: stroke, opacity: 0.16} : {}),
        });
      } else {
        /* Both worked out in top-left points, the frame the model keeps, and
           converted once at the moment of drawing. drawSvgPath is given the top
           of the page as its origin, so the path itself needs no flipping — the
           old version flipped some of its own numbers and not others. */
        const head = an.variant === 'arrow' ? arrowHead(an.a, an.b, an.width) : null;
        const end = head?.shaftEnd ?? an.b;
        page.drawLine({
          start: {x: an.a.x, y: up(an.a.y)}, end: {x: end.x, y: up(end.y)},
          thickness: an.width, color: stroke,
        });
        if (head) {
          page.drawSvgPath(
            `M${head.left.x} ${head.left.y} L${head.tip.x} ${head.tip.y}`
            + ` L${head.right.x} ${head.right.y} Z`,
            /* The outline rounds the two barbs the same way the screen does —
               a filled triangle alone comes to a mathematically sharp corner
               that prints as a ragged pixel. */
            {x: 0, y: H, color: stroke, borderColor: stroke, borderWidth: an.width * 0.35},
          );
        }
      }
      break;
    }

    case 'text': {
      if (an.cover) {
        const c = rectOf(an.cover.a, an.cover.b);
        page.drawRectangle({x: c.x, y: up(c.y, c.h), width: c.w, height: c.h,
                            color: an.coverColor ? hex(an.coverColor) : rgb(1, 1, 1)});
      }
      /* Word by word, choosing a font per word.
       *
       * The document face is a subset: it carries exactly the glyphs the
       * original file used, which almost never includes the space — PDFs
       * encode word gaps as positioning, not characters — and rarely includes
       * anything the user typed afterwards in another alphabet. Handing a
       * whole line to drawText therefore printed a .notdef box between every
       * pair of words and lost the line entirely when a Cyrillic word made the
       * measurement throw.
       *
       * So no font is ever asked to draw a space — the gap is an x advance,
       * taken from the standard font, whose space is within a percent of any
       * text face's. And each word is checked against the face's own character
       * map first: the words it can set, it sets; the ones it cannot fall back
       * to the standard family, which faces() has already swapped for DejaVu
       * wherever the text needs Unicode. A rewritten paragraph keeps its face
       * for every word the face can carry, instead of losing it wholesale to
       * the first ґ. */
      const standard = fonts[an.font] ?? fonts['helvetica']!;
      const face = an.face ? faceFonts.get(an.face) : undefined;
      const cmap = face
        ? (face as unknown as {embedder?: {font?: {hasGlyphForCodePoint?(cp: number): boolean}}})
            .embedder?.font
        : undefined;
      const faceCan = (word: string): boolean =>
        !!face && !!cmap?.hasGlyphForCodePoint
        && [...word].every(ch => cmap.hasGlyphForCodePoint!(ch.codePointAt(0)!));

      /* The spacing the words were calibrated to on screen, so that what
         replaces a paragraph is as wide as what it replaced. PDF applies it
         after every character, the same as CSS letter-spacing, so the two
         agree and the arithmetic here can simply count characters. */
      const wordOwn = (word: string): number => {
        try { return (faceCan(word) ? face! : standard).widthOfTextAtSize(word, an.size); }
        catch { return standard.widthOfTextAtSize('m', an.size) * word.length * 0.6; }
      };
      const spaceOf = (t: number): number => standard.widthOfTextAtSize(' ', an.size) + t;
      const wordOf = (word: string, t: number): number => wordOwn(word) + t * word.length;
      const lineOf = (line: string, t: number): number =>
        line.split(' ').reduce((n, w, i) => n + (i ? spaceOf(t) : 0) + (w ? wordOf(w, t) : 0), 0);

      /* The spacing is solved here rather than predicted in the browser.
       *
       * A run out of Edit text arrives with the advance it was measured at on
       * screen. The words are then taken apart again and put down one at a
       * time, each in whichever font can set it, with the gaps taken from the
       * standard face — a sum that is not the string the browser measured, and
       * every difference between the two is a second opinion formed after the
       * question had already been answered. Fitting the character spacing to
       * the measured advance, using the very functions that will lay the words
       * down, lands the run on its width exactly. */
      const bare = an.ink ? lineOf(an.text.split('\n')[0] ?? '', 0) : 0;
      /* Bounded the same way the browser bounds its own. A measurement that
         disagrees with the metrics by more than this is not a spacing problem —
         it is a face the writer could not get hold of — and letting it through
         would pile the letters on top of one another rather than admit it. */
      const room = an.size * 0.4;
      const track = an.ink && an.text.length
        ? Math.max(-room, Math.min(room, (an.ink - bare) / an.text.length))
        : (an.tracking ?? 0);
      const spaceW = spaceOf(track);
      const wordW = (word: string): number => wordOf(word, track);
      const lineW = (line: string): number => lineOf(line, track);

      /* The same greedy wrap as wrap(), against the glyph-safe ruler — unless
         the run already knows where its lines end. A rewritten paragraph does:
         the browser broke it, in the page's own face, and each line arrived as
         its own run. Measuring it again here is a second opinion formed in a
         different typeface, and a wider face turns one line into two. */
      const lines: string[] = [];
      for (const para of an.text.split('\n')) {
        if (an.nowrap) { lines.push(para); continue; }
        let line = '';
        for (const word of para.split(' ')) {
          const next = line ? `${line} ${word}` : word;
          if (line && lineW(next) > an.w) { lines.push(line); line = word; }
          else line = next;
        }
        lines.push(line);
      }

      /* Character spacing is graphics state, not a draw option: pdf-lib has no
         parameter for it, so it is set on the stream around the run and put
         back afterwards. Left set, it would track every later mark on the page
         as well. */
      if (track) page.pushOperators(setCharacterSpacing(track));
      lines.forEach((line, i) => {
        /* The first baseline is where the browser put it, when the browser was
           there to be asked. The old arithmetic worked it out as 1.02 of the
           type size below the top of the box, which is the ascent of no face
           that exists — Arial's is 0.91, Times New Roman's 0.89 — so every
           rewritten paragraph was written a tenth of a size below the words it
           was replacing. A box typed in the Text tool has no measurement to
           carry and keeps the old constant exactly. */
        const y = up(an.at.y + (an.lead ?? an.size * 1.02) + i * an.size * 1.3);
        let x = an.at.x;
        for (const word of line.split(' ')) {
          if (word) {
            const f = faceCan(word) ? face! : standard;
            try {
              page.drawText(word, {x, y, size: an.size, font: f, color: hex(an.color)});
            } catch {
              try {
                page.drawText(word, {x, y, size: an.size, font: standard, color: hex(an.color)});
              } catch { /* a word neither font can set costs itself, not the page */ }
            }
            x += wordW(word);
          }
          x += spaceW;
        }
      });
      if (track) page.pushOperators(setCharacterSpacing(0));
      break;
    }

    case 'image': {
      /* Data URLs only, and only the two formats a browser will hand us from a
         file picker or a canvas. */
      const [, meta = '', b64 = ''] = /^data:([^;]+);base64,(.*)$/.exec(an.src) ?? [];
      if (!b64) break;
      const raw = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const embed = meta.includes('jpeg') || meta.includes('jpg')
        ? doc.embedJpg(raw) : doc.embedPng(raw);
      void embed.then(img => {
        page.drawImage(img, {x: an.at.x, y: up(an.at.y, an.h), width: an.w, height: an.h});
      });
      break;
    }

    case 'stamp': {
      const w = stampWidth(an.label);
      page.drawRectangle({
        x: an.at.x, y: up(an.at.y, STAMP_HEIGHT), width: w, height: STAMP_HEIGHT,
        borderColor: hex(an.color), borderWidth: 1.8,
      });
      const textW = fonts['helvetica-bold']!.widthOfTextAtSize(an.label, STAMP_SIZE);
      page.drawText(an.label, {
        x: an.at.x + (w - textW) / 2,
        y: up(an.at.y + STAMP_HEIGHT / 2) - STAMP_SIZE * 0.36,
        size: STAMP_SIZE, font: fonts['helvetica-bold']!, color: hex(an.color),
      });
      break;
    }

    case 'region': {
      const r = rectOf(an.a, an.b);
      if (an.variant === 'link' && an.url) {
        /* A real link annotation, not a blue rectangle. Border [0,0,0] keeps
           the viewer from drawing its own frame around it. */
        const annot = doc.context.obj({
          Type: 'Annot', Subtype: 'Link',
          Rect: [r.x, up(r.y, r.h), r.x + r.w, up(r.y)],
          Border: [0, 0, 0],
          A: doc.context.obj({Type: 'Action', S: 'URI', URI: PDFString.of(an.url)}),
        });
        page.node.addAnnot(doc.context.register(annot));
      } else if (an.variant === 'field') {
        const form = doc.getForm();
        const name = an.fieldName ?? `field_${Math.round(r.x)}_${Math.round(r.y)}`;
        const opts = {
          x: r.x, y: up(r.y, r.h), width: r.w, height: r.h,
          borderWidth: 1, borderColor: rgb(0.6, 0.6, 0.62),
        };
        try {
          if (an.fieldType === 'check') form.createCheckBox(name).addToPage(page, opts);
          else form.createTextField(name).addToPage(page, opts);
        } catch {
          /* Duplicate field names are the only realistic failure here, and one
             unusable field should not cost the whole export. */
        }
      }
      break;
    }
  }
}


