import type {PDFPageProxy} from '../core/pdfjs';

/* The words on the page, selectable.
 *
 * A rendered PDF page is a picture — there is nothing in a canvas to select, so
 * until now dragging across the document did nothing at all. pdf.js gives every
 * run of text with a transform matrix, and this puts a transparent span at each
 * of those positions. The glyphs you see are still the canvas underneath; the
 * spans are invisible and exist only to give the browser something to select,
 * which is exactly how every PDF viewer on the web does it.
 *
 * The one thing that has to be right is the width. A span whose text is wider
 * or narrower than the painted run puts the selection highlight beside the
 * words rather than on them, so each one is scaled horizontally to the width
 * pdf.js reports. That is the whole trick.
 *
 * Pointer events are off unless the Select tool is active. Every other tool
 * needs the drag for itself, and a highlighter that kept selecting text instead
 * of drawing would be unusable. */

export class TextLayer {
  readonly root: HTMLElement;
  private items: Array<{
    str: string; left: number; top: number; width: number; size: number;
    /** Clockwise degrees on screen. Zero for the overwhelming majority. */
    angle: number;
  }> = [];

  constructor(
    private pageNo: number,
    private pageW: number,
    private pageH: number,
    private ctx: {interactive(): boolean; scale(): number},
  ) {
    this.root = document.createElement('div');
    this.root.className = 'tl';
    this.root.dataset['page'] = String(pageNo);

    /* A press on bare paper must not start a text selection.
     *
     * The runs are absolutely positioned, so between them there is nothing but
     * the container. When a press lands there the browser has to guess which
     * character was meant, and with no laid-out flow to guess from it picks the
     * first one — so a short drag in a margin selects every word above it. That
     * is not a near miss, it is the whole page, and it happens on the most
     * ordinary gesture there is: clicking a blank spot to dismiss what was
     * selected before.
     *
     * Refusing the gesture is both simpler and closer to what a reader expects.
     * Words select; paper does not. The marks layer below has already had the
     * press by now — deselecting still works — so this only stops the guess. */
    this.root.addEventListener('pointerdown', e => {
      if (e.target !== this.root) return;
      e.preventDefault();
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) sel.removeAllRanges();
    });
  }

  async load(proxy: PDFPageProxy): Promise<void> {
    let content;
    try {
      content = await proxy.getTextContent();
    } catch {
      /* A page whose text cannot be read is still a page you can draw on. */
      return;
    }

    const height = proxy.getViewport({scale: 1}).height;
    this.items = [];
    for (const item of content.items) {
      if (!('str' in item) || !item.str) continue;
      const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = item.transform as number[];
      /* Sideways text is rare but real — the left margin of a US tax form is
         usually printed up the page. A rotated run read as if it were
         horizontal collapses to a span of no height sitting in the wrong
         place, which is worse than not being selectable at all: an invisible
         zero-height element still swallows the press that lands on it and
         anchors the selection somewhere the reader never pointed. */
      const angle = Math.atan2(b, a);
      const size = Math.hypot(c, d) || 10;
      const width = item.width || Math.hypot(a, b) * item.str.length * 0.5;

      if (Math.abs(angle) < 0.01) {
        this.items.push({
          str: item.str,
          left: e,
          /* The model is top-left; pdf.js counts up from the bottom. */
          top: height - f - size,
          width, size, angle: 0,
        });
        continue;
      }

      /* Rotated runs are pinned at their baseline origin and turned there, so
         the position is exact whatever the angle; the em box is lifted off the
         baseline in CSS rather than arithmetic. Screen y runs the other way
         from the page's, hence the negated angle. */
      this.items.push({
        str: item.str, left: e, top: height - f, width, size,
        angle: -angle * 180 / Math.PI,
      });
    }
    this.render();
  }

  render(): void {
    this.root.replaceChildren();
    this.root.classList.toggle('tl--on', this.ctx.interactive());
    if (!this.items.length) return;

    const scale = this.ctx.scale();
    for (const it of this.items) {
      const span = document.createElement('span');
      span.textContent = it.str;
      span.style.left = `${(it.left / this.pageW) * 100}%`;
      span.style.top = `${(it.top / this.pageH) * 100}%`;
      span.style.fontSize = `${it.size * scale}px`;
      /* Measured after it is in the document, below — the ratio needs a laid
         out width, and one reflow for the whole page is far cheaper than one
         per span. */
      span.dataset['w'] = String(it.width * scale);
      if (it.angle) span.dataset['a'] = String(it.angle);
      /* The run's own box, in page points, carried on the element so that
         anything measuring a selection can use the PDF's metrics rather than
         the browser's. These two stay after the render; the others are
         scratch. */
      span.dataset['y'] = String(it.top);
      span.dataset['h'] = String(it.size);
      this.root.append(span);
    }

    /* One read, then one write. Interleaving them would force a layout per
       span, which on a dense page is thousands of them. */
    const spans = [...this.root.children] as HTMLElement[];
    const natural = spans.map(s => s.getBoundingClientRect().width);
    spans.forEach((s, i) => {
      const want = Number(s.dataset['w']);
      const have = natural[i] ?? 0;
      /* Rotation first, then the lift off the baseline, then the width match:
         the order is the order they are applied on screen, right to left. */
      const turn = s.dataset['a'] ? `rotate(${s.dataset['a']}deg) translateY(-0.86em) ` : '';
      const fit = want > 0 && have > 0 ? `scaleX(${want / have})` : '';
      if (turn || fit) s.style.transform = turn + fit;
      delete s.dataset['w'];
      delete s.dataset['a'];
    });
  }

  /** The rectangles a DOM selection covers on this page, in page points. */
  rectsFor(range: Range): Array<{x: number; y: number; w: number; h: number}> {
    return rectsIn(this.root, this.pageW, this.pageH, range);
  }

  get page(): number { return this.pageNo; }
}

/* Draws the selection ourselves.
 *
 * The browser paints ::selection glyph by glyph, and every glyph here is a
 * transparent copy scaled horizontally to match the picture underneath. The
 * scaling is close but never exact, so the painted band lands a fraction off
 * the printed word — which reads as the text shifting as you drag across it.
 * Nothing is actually moving; the highlight is simply drawn from a different
 * set of boxes than the words were.
 *
 * So the native highlight is turned off inside the layer and one rectangle per
 * line is drawn instead, from the same merged geometry a mark would use. The
 * band is then identical to what marking the selection will produce, which is
 * the honest preview — what you see selected is exactly what gets highlighted. */
export function paintSelection(
  root: HTMLElement,
  rects: Array<{x: number; y: number; w: number; h: number}>,
  pageW: number,
  pageH: number,
): void {
  let box = root.querySelector<HTMLElement>('.tl-sel');
  if (!rects.length) { box?.remove(); return; }
  if (!box) {
    box = document.createElement('div');
    box.className = 'tl-sel';
    root.append(box);
  }
  box.replaceChildren(...rects.map(r => {
    const i = document.createElement('i');
    i.style.left = `${(r.x / pageW) * 100}%`;
    i.style.top = `${(r.y / pageH) * 100}%`;
    i.style.width = `${(r.w / pageW) * 100}%`;
    i.style.height = `${(r.h / pageH) * 100}%`;
    return i;
  }));
}

/* Where a selection lands on this page, in page points.
 *
 * Horizontally the DOM is the authority: the runs are scaled to the width the
 * page reports, so a selection that stops half way through a word stops in the
 * right place, and only the browser knows where that is.
 *
 * Vertically the DOM is wrong, and measurably so. `getClientRects` returns line
 * boxes, and a line box is as tall as the *substitute* font's ascent plus
 * descent — nothing to do with the type actually printed on the page. On a
 * ten-point run it comes back as eleven, so every band was a tenth too deep and
 * sat low on the line. The run's own height and top come from the PDF's text
 * matrix, and those are written onto each span when it is laid out, so the band
 * is exactly as tall as the letters it covers.
 *
 * Free-standing so a caller holding nothing but the layer's element can use it:
 * the viewer rebuilds its layers on every zoom, and anything that kept
 * instances of its own would be holding stale ones by the second zoom. */
export function rectsIn(
  root: HTMLElement, pageW: number, pageH: number, range: Range,
): Array<{x: number; y: number; w: number; h: number}> {
  const box = root.getBoundingClientRect();
  if (!box.width || !box.height) return [];

  /* A dense page carries a couple of thousand runs and this is called on every
     frame of a drag, so the vertical span of the selection is worked out once
     and used to skip everything that is nowhere near it. */
  const span = range.getBoundingClientRect();
  const from = ((span.top - box.top) / box.height) * pageH - 2;
  const to = ((span.bottom - box.top) / box.height) * pageH + 2;

  const out: Array<{x: number; y: number; w: number; h: number}> = [];
  for (const node of root.children) {
    if (node.tagName !== 'SPAN' || !(node instanceof HTMLElement)) continue;

    const y = Number(node.dataset['y']);
    const h = Number(node.dataset['h']);
    if (!Number.isFinite(y) || !Number.isFinite(h)) continue;
    if (y + h < from || y > to) continue;
    if (!range.intersectsNode(node)) continue;

    /* The range clipped to this one run, so a selection that begins or ends
       inside it measures from the character rather than from the run. */
    const part = document.createRange();
    part.selectNodeContents(node);
    if (range.compareBoundaryPoints(Range.START_TO_START, part) > 0) {
      part.setStart(range.startContainer, range.startOffset);
    }
    if (range.compareBoundaryPoints(Range.END_TO_END, part) < 0) {
      part.setEnd(range.endContainer, range.endOffset);
    }

    const r = part.getBoundingClientRect();
    if (r.width < 0.5) continue;

    const x = ((r.left - box.left) / box.width) * pageW;
    const w = (r.width / box.width) * pageW;
    /* Runs from a neighbouring page fall outside this one and are dropped here,
       which is what keeps a two-page selection from painting a stripe down the
       margin. */
    if (x + w < 1 || x > pageW - 1 || y + h < 1 || y > pageH - 1) continue;
    out.push({x, y, w, h});
  }
  return merge(out);
}

/* Client rects come one per text node, so a selected line arrives as a dozen
   slivers with hairline gaps between them. Merged into one rectangle per line,
   a highlight looks like a highlighter rather than like a barcode. */
function merge(
  rects: Array<{x: number; y: number; w: number; h: number}>,
): Array<{x: number; y: number; w: number; h: number}> {
  type Line = {x: number; right: number; parts: Array<{h: number; bottom: number}>};
  const lines: Line[] = [];

  for (const r of [...rects].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const line = lines.find(l => {
      /* Same line if the vertical overlap is most of both heights. Compared
         against the line's own typical run rather than its tallest, so one
         outsized character cannot widen the band enough to swallow the line
         below it. */
      const {h, bottom} = shape(l.parts);
      return Math.min(bottom, r.y + r.h) - Math.max(bottom - h, r.y) > Math.min(h, r.h) * 0.5;
    });
    if (!line) {
      lines.push({x: r.x, right: r.x + r.w, parts: [{h: r.h, bottom: r.y + r.h}]});
      continue;
    }
    line.x = Math.min(line.x, r.x);
    line.right = Math.max(line.right, r.x + r.w);
    line.parts.push({h: r.h, bottom: r.y + r.h});
  }

  return lines.map(l => {
    const {h, bottom} = shape(l.parts);
    return {x: l.x, y: bottom - h, w: l.right - l.x, h};
  });
}

/* One height and one baseline for a whole line, taken from the middle of its
 * runs rather than from their extremes.
 *
 * A line of text is rarely one uniform run: a footnote marker, a bold lead-in,
 * a taller glyph in a different face. Unioning the boxes means the band takes
 * its height from the tallest thing on the line and its baseline from the
 * lowest, so a highlight over ordinary prose comes out visibly deeper than the
 * words it covers and sits low. The median of each ignores the odd one out, and
 * the result hugs the line the way a highlighter does. */
function shape(parts: Array<{h: number; bottom: number}>): {h: number; bottom: number} {
  const mid = (ns: number[]): number => {
    const s = [...ns].sort((a, b) => a - b);
    return s[Math.floor((s.length - 1) / 2)] ?? 0;
  };
  return {h: mid(parts.map(p => p.h)), bottom: mid(parts.map(p => p.bottom))};
}
