import {docFace} from '../core/docFonts';
import {
  AnnotStore, arrowHead, boundsOf, moveBy, nextId, rectOf, dragEdge, setBounds, minSize, stampWidth,
  STAMP_HEIGHT, STAMP_SIZE, HIGHLIGHT_ALPHA,
  CSS_FONT, isBold, isItalic,
  type Annot, type Edge, type FontId, type Pt, type Rect, type TextAnnot, type ToolId,
} from '../core/annots';

/* For asking a face where its baseline sits — the same question blockLayer.ts
   asked when the run was measured, so the screen and the file can agree. */
const RULER = document.createElement('canvas').getContext('2d')!;

const SVGNS = 'http://www.w3.org/2000/svg';
const el = <K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>) => {
  const node = document.createElementNS(SVGNS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
};

export interface ToolSettings {
  color: string;
  width: number;
  fontSize: number;
  font: FontId;
  shape: 'rect' | 'ellipse' | 'line' | 'arrow';
  filled: boolean;
  highlightColor: string;
  stampLabel: string;
  fieldType: 'text' | 'check';
}

/* The interactive layer that sits on top of one rendered page.
 *
 * Geometry is drawn as SVG and text as real HTML, because a text box has to be
 * editable and SVG's answer to that (foreignObject) behaves differently in
 * every engine. Both live in the same absolutely-positioned box so they share
 * one coordinate space.
 *
 * The layer works in page points and scales by CSS transform rather than by
 * re-computing every coordinate: one number changes on zoom instead of every
 * annotation, and the strokes stay geometrically exact at any magnification. */
export class Overlay {
  readonly root: HTMLElement;
  private svg: SVGSVGElement;
  private html: HTMLElement;
  private marks: HTMLElement;

  private drafting: Annot | null = null;
  private ghost: HTMLImageElement | null = null;
  private nib: HTMLElement | null = null;
  /* A move needs only where the pointer was last; a resize needs where the
     drag started and which side it took hold of. */
  private dragging:
    | {an: Annot; from: Pt; mode: 'move'}
    | {an: Annot; from: Pt; mode: 'resize'; edge: Edge; start: Rect}
    | null = null;

  constructor(
    private page: number,
    private store: AnnotStore,
    private pageW: number,
    private pageH: number,
    private ctx: {
      tool(): ToolId;
      settings(): ToolSettings;
      scale(): number;
      selected(): string | null;
      select(id: string | null): void;
      beforeEdit(label: string): void;
      afterEdit(): void;
      requestImage(): Promise<string | null>;
      requestSignature(): Promise<string | null>;
      signatureNow(): string | null;
      signatureWidth(): number;
      keepPlacing(): boolean;
      placed(id: string): void;
      requestLink(): Promise<string | null>;
      cropReady(page: number): void;
    },
  ) {
    this.root = document.createElement('div');
    this.root.className = 'ov';

    this.svg = document.createElementNS(SVGNS, 'svg');
    this.svg.setAttribute('viewBox', `0 0 ${pageW} ${pageH}`);
    this.svg.setAttribute('preserveAspectRatio', 'none');

    this.html = document.createElement('div');
    this.html.className = 'ov-html';

    this.marks = document.createElement('div');
    this.marks.className = 'ov-marks';

    this.root.append(this.svg, this.html, this.marks);
    this.bind();
    this.render();
  }

  /* Pointer capture is how a drag keeps receiving events after the pointer
     leaves the page, and it is only ever an optimisation. It also throws — on a
     stale pointer id, on a synthetic event, on a pointer already released — and
     an exception here used to abort the whole gesture before the tool ran. A
     failed capture should cost you a drag that stops at the page edge, not a
     tool that silently does nothing. */
  private capture(e: PointerEvent): void {
    try { this.root.setPointerCapture(e.pointerId); } catch { /* not fatal */ }
  }

  private release(e: PointerEvent): void {
    try {
      if (this.root.hasPointerCapture(e.pointerId)) this.root.releasePointerCapture(e.pointerId);
    } catch { /* not fatal */ }
  }

  /** Page-point coordinates from a pointer event. */
  private at(e: PointerEvent): Pt {
    const r = this.root.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * this.pageW,
      y: ((e.clientY - r.top) / r.height) * this.pageH,
    };
  }

  /* Called by the viewer with the page slot, once the overlay is in it.
   *
   * The press has to be caught on the slot rather than on the overlay's own
   * element, because the selectable text layer sits on top: a click on a word
   * would otherwise never reach the overlay, and every mark on the page would
   * become unselectable the moment text selection was switched on. Catching it
   * on the way down means the overlay gets first refusal, and anything it does
   * not want carries on to the text underneath — which is exactly the rule you
   * want. A mark takes the click; bare words start a selection. */
  attach(host: HTMLElement): void {
    host.addEventListener('pointerdown', e => {
      const t = e.target as HTMLElement;
      /* The form's own widgets and a text box being typed into are not ours. */
      if (t.closest?.('.fl') || t.isContentEditable) return;
      this.down(e);
    }, {capture: true});

    /* Double-click has to be caught the same way as the press, because the
       selectable text layer sits over the annotations — a dblclick over a text
       box lands on a transparent word, and the listener on our own root never
       hears it. On the way down, everything does. */
    host.addEventListener('dblclick', e => {
      const t = e.target as HTMLElement;
      if (t.closest?.('.fl') || t.isContentEditable) return;
      const p = this.at(e as PointerEvent);
      const an = this.store.hit(this.page, p);
      if (!an || an.kind !== 'text') return;
      if (!this.html.querySelector(`[data-text="${an.id}"]`)) return;
      e.preventDefault();
      this.focusText(an.id);
    }, {capture: true});
  }

  private bind(): void {
    this.root.addEventListener('pointermove', e => this.move(e));
    this.root.addEventListener('pointerup', e => this.up(e));
    this.root.addEventListener('dblclick', e => {
      const p = this.at(e as unknown as PointerEvent);
      const an = this.store.hit(this.page, p);
      if (!an || an.kind !== 'text') return;
      if (!this.html.querySelector(`[data-text="${an.id}"]`)) return;
      this.focusText(an.id);
    });
    this.root.addEventListener('pointerleave', () => { this.trackGhost(null); this.trackNib(null); });
    this.root.addEventListener('pointercancel', () => { this.drafting = null; this.dragging = null; });
  }

  private down(e: PointerEvent): void {
    if (e.button !== 0) return;
    const tool = this.ctx.tool();
    const s = this.ctx.settings();
    const p = this.at(e);

    /* A handle drag beats everything else — it is only reachable when something
       is already selected, and it must not be mistaken for a new mark. It also
       beats the tool: a text box you have just typed into is still resizable
       without first switching back to Select. */
    const grip = (e.target as HTMLElement).closest?.<HTMLElement>('.ov-h');
    if (grip) {
      const an = this.store.find(grip.dataset['for'] ?? '');
      if (an) {
        this.ctx.select(an.id);
        this.ctx.beforeEdit(grip.dataset['move'] ? 'moving a mark' : 'resizing a mark');
        this.capture(e);
        this.dragging = grip.dataset['move']
          ? {an, from: p, mode: 'move'}
          : {an, from: p, mode: 'resize', edge: grip.dataset['edge'] as Edge, start: boundsOf(an)};
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }

    if (tool === 'select') {
      const an = this.store.hit(this.page, p);
      this.ctx.select(an?.id ?? null);
      /* A highlight or a strikethrough is a property of the words underneath it,
         not an object lying on the page. Dragging one away from its sentence
         would leave a stripe pointing at nothing, so it stays where the text
         is; select it to delete it, and that is all it offers. */
      if (an && an.kind !== 'mark') {
        this.ctx.beforeEdit('moving a mark');
        this.capture(e);
        this.dragging = {an, from: p, mode: 'move'};
        /* Both, and in this order: preventDefault stops the browser turning
           the press into the start of a text selection, stopPropagation keeps
           the word underneath from hearing about it at all. */
        e.preventDefault();
        e.stopPropagation();
      }
      this.render();
      return;
    }

    if (tool === 'eraser') {
      this.ctx.beforeEdit('erasing');
      this.capture(e);
      this.dragging = null;
      this.erase(p);
      return;
    }

    this.ctx.beforeEdit('adding a mark');
    this.capture(e);
    e.preventDefault();

    switch (tool) {
      case 'draw':
      case 'highlight':
        this.drafting = this.store.add({
          id: nextId(), page: this.page, kind: 'ink',
          variant: tool === 'highlight' ? 'highlight' : 'draw',
          pts: [p], color: tool === 'highlight' ? s.highlightColor : s.color,
          /* A floor of fourteen points swallowed the slider: at six points per
             step, everything below step three came out the same thickness, so
             most of the track did nothing. Four is thin enough to be a floor
             and low enough to leave the slider its range. */
          width: tool === 'highlight' ? Math.max(4, s.width * 5) : s.width,
        });
        break;

      case 'shape':
        this.drafting = this.store.add({
          id: nextId(), page: this.page, kind: 'shape', variant: s.shape,
          a: p, b: p, color: s.color, width: s.width, filled: s.filled,
        });
        break;

      case 'redact':
      case 'link':
      case 'field':
      case 'crop':
        this.drafting = this.store.add({
          id: nextId(), page: this.page, kind: 'region', variant: tool,
          a: p, b: p,
          ...(tool === 'field' ? {fieldType: s.fieldType, fieldName: `field_${nextId()}`} : {}),
        });
        break;

      /* Add text puts down something new: click, and type. */
      case 'text': {
        const an: TextAnnot = {
          id: nextId(), page: this.page, kind: 'text',
          /* Wide enough to write in wherever it is put. Sized from the click,
             a box placed near the right margin came out too narrow to hold a
             word, and one placed past it came out inside out. */
          at: p, w: Math.max(80, Math.min(280, this.pageW - p.x - 20)), text: '',
          size: s.fontSize, color: s.color, font: s.font,
        };
        this.store.add(an);
        this.ctx.select(an.id);
        this.ctx.afterEdit();
        /* Placed, then handed over — the caret stays in it because typingIn
           says so, and everything else about it is now an ordinary mark. */
        this.typingIn = an.id;
        this.ctx.placed(an.id);
        this.render();
        queueMicrotask(() => this.focusText(an.id));
        break;
      }

      case 'stamp':
        this.store.add({
          id: nextId(), page: this.page, kind: 'stamp',
          at: p, label: s.stampLabel, color: s.color,
        });
        this.ctx.afterEdit();
        this.render();
        break;

      /* The signature is made once in its own dialog and placed from then on,
         because nobody wants to redraw their name on page four of a lease. */
      case 'sign': {
        void this.ctx.requestSignature().then(src => {
          if (!src) return;
          const img = new Image();
          img.onload = () => {
            const w = this.ctx.signatureWidth();
            const h = w * (img.height / img.width);
            /* Centred on the pointer, not hanging off it. The ghost that
               follows the cursor is drawn the same way, so what you saw is
               exactly where it lands. */
            const an = this.store.add({
              id: nextId(), page: this.page, kind: 'image', variant: 'sign',
              at: {x: p.x - w / 2, y: p.y - h / 2}, w, h, src,
            });
            this.ctx.afterEdit();
            this.ctx.placed(an.id);
            this.render();
          };
          img.src = src;
        });
        break;
      }

      case 'image': {
        void this.ctx.requestImage().then(src => {
          if (!src) return;
          const img = new Image();
          img.onload = () => {
            /* Centred on the click and kept on the page, the way the signature
               is. Sized from where it was dropped, the picture shrank towards
               nothing as the click approached the right margin — and a click
               past it produced a negative width. */
            const w = Math.max(40, Math.min(240, this.pageW - 40, this.pageH - 40));
            const h = w * (img.height / img.width);
            const at = {
              x: Math.min(Math.max(0, p.x - w / 2), this.pageW - w),
              y: Math.min(Math.max(0, p.y - h / 2), this.pageH - h),
            };
            const an = this.store.add({
              id: nextId(), page: this.page, kind: 'image', variant: 'image',
              at, w, h, src,
            });
            this.ctx.afterEdit();
            /* Placed and selected, so it can be moved and resized straight
               away. Leaving it unselected on the Image tool meant a picture you
               could only push around after working out that you had to switch
               tools first. */
            this.ctx.placed(an.id);
            this.render();
          };
          img.src = src;
        });
        break;
      }
    }

    if (this.drafting) this.render();
  }

  private move(e: PointerEvent): void {
    const p = this.at(e);
    this.trackGhost(p);
    this.trackNib(p);

    if (this.drafting) {
      const an = this.drafting;
      if (an.kind === 'ink') {
        /* A highlighter is dragged along a line of text, not scribbled. Keeping
           only the two ends makes it a clean band instead of a wobbly smear —
           which is what it looks like on paper and what makes it readable. */
        if (an.variant === 'highlight') an.pts = [an.pts[0]!, p];
        else an.pts.push(p);
      } else if (an.kind === 'shape' || an.kind === 'region') an.b = p;
      this.render();
      return;
    }


    if (this.dragging) {
      const d = this.dragging;
      if (d.mode === 'move') {
        moveBy(d.an, p.x - d.from.x, p.y - d.from.y);
        d.from = p;
      } else {
        /* Measured from where the drag began, not from the last frame. Adding
           up per-frame deltas lets the box drift away from the pointer once a
           minimum has been hit and then released. */
        setBounds(d.an, dragEdge(
          d.start, d.edge, p.x - d.from.x, p.y - d.from.y, minSize(d.an),
        ));
      }
      this.render();
      return;
    }

    if (this.ctx.tool() === 'eraser' && e.buttons === 1) this.erase(p);
  }

  /* Six points is two millimetres — narrower than most pen strokes, so the old
     eraser missed more often than it hit. The nib now runs from about 4 mm to
     16 mm on the same slider that sets pen thickness, and it is drawn under the
     pointer so you can see what you are about to take away. */
  private eraserRadius(): number {
    return 6 + this.ctx.settings().width * 4;
  }

  private trackNib(p: Pt | null): void {
    if (this.ctx.tool() !== 'eraser' || !p) {
      this.nib?.remove();
      this.nib = null;
      return;
    }
    if (!this.nib) {
      this.nib = document.createElement('span');
      this.nib.className = 'ov-nib';
      this.marks.append(this.nib);
    }
    const r = this.eraserRadius();
    this.nib.style.left = ((p.x - r) / this.pageW) * 100 + '%';
    this.nib.style.top = ((p.y - r) / this.pageH) * 100 + '%';
    this.nib.style.width = ((r * 2) / this.pageW) * 100 + '%';
    this.nib.style.aspectRatio = '1';
  }

  /* While the Sign tool is active a translucent copy of the signature follows
     the pointer. Without it you are aiming blind: the first click teaches you
     where the anchor is, and by then you have already placed it. */
  private trackGhost(p: Pt | null): void {
    const src = this.ctx.tool() === 'sign' ? this.ctx.signatureNow() : null;
    if (!src || !p) {
      this.ghost?.remove();
      this.ghost = null;
      return;
    }
    if (!this.ghost) {
      this.ghost = document.createElement('img');
      this.ghost.className = 'ov-ghost';
      this.ghost.src = src;
      this.marks.append(this.ghost);
    } else if (this.ghost.src !== src) {
      this.ghost.src = src;
    }
    const w = this.ctx.signatureWidth();
    const ratio = this.ghost.naturalHeight && this.ghost.naturalWidth
      ? this.ghost.naturalHeight / this.ghost.naturalWidth : 0.35;
    const h = w * ratio;
    this.ghost.style.left = ((p.x - w / 2) / this.pageW) * 100 + '%';
    this.ghost.style.top = ((p.y - h / 2) / this.pageH) * 100 + '%';
    this.ghost.style.width = (w / this.pageW) * 100 + '%';
  }

  /* A real eraser takes away what is under it, not the whole stroke it happens
     to touch. A pen line is a list of points, so erasing means dropping the
     points inside the nib and keeping what is left — which can leave the stroke
     in two pieces, so it becomes two strokes. Anything that is not a line
     (a shape, a stamp, an image) has no meaningful "part", so those still go
     whole. */
  private erase(p: Pt): void {
    const radius = this.eraserRadius();
    let changed = false;

    for (const an of this.store.byPage(this.page)) {
      if (an.kind !== 'ink') {
        const b = boundsOf(an);
        if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) {
          this.store.remove(an.id);
          changed = true;
        }
        continue;
      }

      const runs: Pt[][] = [];
      let run: Pt[] = [];
      let touched = false;
      for (const q of an.pts) {
        if (Math.hypot(q.x - p.x, q.y - p.y) <= radius) {
          touched = true;
          if (run.length > 1) runs.push(run);
          run = [];
        } else {
          run.push(q);
        }
      }
      if (run.length > 1) runs.push(run);
      if (!touched) continue;

      this.store.remove(an.id);
      for (const pts of runs) {
        this.store.add({...an, id: nextId(), pts});
      }
      changed = true;
    }

    if (changed) { this.ctx.afterEdit(); this.render(); }
  }

  private up(e: PointerEvent): void {
    this.release(e);

    if (this.drafting) {
      const an = this.drafting;
      this.drafting = null;

      /* A click that was meant to be a drag leaves a mark of zero size. Dropping
         it is kinder than leaving invisible debris in the document. */
      const b = boundsOf(an);
      const trivial = an.kind === 'ink' ? an.pts.length < 2 : (b.w < 4 && b.h < 4);
      if (trivial) this.store.remove(an.id);
      else if (an.kind === 'region' && an.variant === 'crop') {
        /* The box stays until it is confirmed. Cropping the moment the pointer
           came up meant a mis-drag silently resized the page, and before undo
           existed that was unrecoverable. */
        this.ctx.select(an.id);
        this.ctx.cropReady(this.page);
      }
      else if (an.kind === 'region' && an.variant === 'link') {
        void this.ctx.requestLink().then(url => {
          if (url) { an.url = url; this.store.touch(an.id); }
          else this.store.remove(an.id);
          this.ctx.afterEdit();
          this.render();
        });
      }
      this.ctx.afterEdit();
      this.render();
      return;
    }

    if (this.dragging) {
      this.dragging = null;
      this.ctx.afterEdit();
      this.render();
    }
  }

  /* The box the caret is in, if any.
   *
   * Which text box may be typed into used to be decided entirely by which tool
   * was active, and that is what kept a freshly placed box tied to the Add text
   * tool: to move it you had to know to switch to Select first, and every click
   * meant while aiming at it produced another empty box instead. A box being
   * typed into is a fact about the caret, not about the toolbar, so it is
   * tracked here and the tool is handed back to Select the moment the box is
   * placed. Finish typing and what is left behind is an ordinary mark. */
  private typingIn: string | null = null;

  private focusText(id: string): void {
    this.typingIn = id;
    const box = this.html.querySelector<HTMLElement>(`[data-text="${id}"]`);
    if (!box) return;
    box.style.pointerEvents = 'auto';
    box.contentEditable = 'plaintext-only';
    box.focus();
  }

  /* ── painting ─────────────────────────────────────── */

  render(): void {
    if (this.ctx.tool() !== 'sign') { this.ghost?.remove(); this.ghost = null; }
    if (this.ctx.tool() !== 'eraser') { this.nib?.remove(); this.nib = null; }
    this.svg.replaceChildren();
    this.html.replaceChildren();
    this.marks.replaceChildren();

    const selected = this.ctx.selected();

    for (const an of this.store.byPage(this.page)) {
      switch (an.kind) {
        case 'ink': this.paintInk(an); break;
        case 'mark': this.paintMark(an); break;
        case 'shape': this.paintShape(an); break;
        case 'region': this.paintRegion(an); break;
        case 'stamp': this.paintStamp(an); break;
        case 'image': this.paintImage(an); break;
        case 'text': this.paintText(an); break;
      }
      if (an.id === selected) this.paintSelection(an);
    }
  }

  /* The four text markups, drawn on the geometry layer.
   *
   * A highlight goes behind nothing — it is translucent, so the words show
   * through. The three line styles sit at a fraction of the line height rather
   * than at a fixed offset, so they land in the same place on eight-point
   * small print as on a heading. */
  private paintMark(an: Extract<Annot, {kind: 'mark'}>): void {
    for (const r of an.rects) {
      if (an.variant === 'highlight') {
        this.svg.append(el('rect', {
          x: r.x, y: r.y, width: r.w, height: r.h, rx: 1,
          fill: an.color, 'fill-opacity': HIGHLIGHT_ALPHA,
          /* The same blend the writer uses, so the screen is a preview of the
             file rather than an approximation of it. Laid over instead of
             multiplied, a highlight greys the words it is meant to pick out. */
          style: 'mix-blend-mode:multiply',
        }));
        continue;
      }
      const weight = Math.max(0.7, r.h * 0.07);
      /* Through the middle for a strike; just under the baseline for the other
         two, which is where a reader expects to find them. */
      const y = an.variant === 'strike' ? r.y + r.h * 0.58 : r.y + r.h * 0.92;
      if (an.variant === 'squiggle') {
        /* One full wave per 2.4× the amplitude reads as a wave at every size;
           a fixed wavelength turns into a straight line on small type. */
        const amp = Math.max(0.8, r.h * 0.09);
        const step = amp * 2.4;
        let d = `M${r.x} ${y}`;
        for (let x = r.x, up = true; x < r.x + r.w; x += step, up = !up) {
          const peak = up ? y - amp * 2 : y + amp * 2;
          const end = Math.min(x + step, r.x + r.w);
          d += ` Q${(x + step / 2).toFixed(2)} ${peak.toFixed(2)} ${end.toFixed(2)} ${y}`;
        }
        this.svg.append(el('path', {
          d, fill: 'none', stroke: an.color, 'stroke-width': weight,
          'stroke-linecap': 'round',
        }));
        continue;
      }
      this.svg.append(el('rect', {
        x: r.x, y: y - weight / 2, width: r.w, height: weight, fill: an.color,
      }));
    }
  }

  private paintInk(an: Extract<Annot, {kind: 'ink'}>): void {
    const d = an.pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ');
    const marker = an.variant === 'highlight';
    this.svg.append(el('path', {
      d, fill: 'none', stroke: an.color, 'stroke-width': an.width,
      /* Square ends and multiply blending are what make a highlighter look like
         a highlighter: the ink darkens the text instead of washing it out, and
         the stroke stops where you stopped rather than bulging past it. */
      'stroke-linecap': marker ? 'butt' : 'round',
      'stroke-linejoin': 'round',
      opacity: marker ? HIGHLIGHT_ALPHA : 1,
      ...(marker ? {style: 'mix-blend-mode:multiply'} : {}),
    }));
  }

  private paintShape(an: Extract<Annot, {kind: 'shape'}>): void {
    const r = rectOf(an.a, an.b);
    const common = {
      stroke: an.color, 'stroke-width': an.width,
      fill: an.filled ? an.color : 'none',
      'fill-opacity': an.filled ? 0.16 : 0,
    };
    if (an.variant === 'rect') {
      this.svg.append(el('rect', {x: r.x, y: r.y, width: r.w, height: r.h, rx: 2, ...common}));
    } else if (an.variant === 'ellipse') {
      this.svg.append(el('ellipse', {
        cx: r.x + r.w / 2, cy: r.y + r.h / 2, rx: r.w / 2, ry: r.h / 2, ...common,
      }));
    } else {
      /* An arrow's shaft stops inside its head; a plain line runs the whole way. */
      const head = an.variant === 'arrow' ? arrowHead(an.a, an.b, an.width) : null;
      const end = head?.shaftEnd ?? an.b;
      this.svg.append(el('line', {
        x1: an.a.x, y1: an.a.y, x2: end.x, y2: end.y,
        stroke: an.color, 'stroke-width': an.width, 'stroke-linecap': 'round',
      }));
      if (head) {
        this.svg.append(el('path', {
          d: `M${head.left.x} ${head.left.y} L${head.tip.x} ${head.tip.y}`
            + ` L${head.right.x} ${head.right.y} Z`,
          fill: an.color, stroke: an.color, 'stroke-width': an.width * 0.35,
          'stroke-linejoin': 'round',
        }));
      }
    }
  }

  private paintRegion(an: Extract<Annot, {kind: 'region'}>): void {
    const r = rectOf(an.a, an.b);
    if (an.variant === 'redact') {
      this.svg.append(el('rect', {x: r.x, y: r.y, width: r.w, height: r.h, fill: '#000'}));
      return;
    }
    const tint = an.variant === 'link' ? '#2563eb' : an.variant === 'crop' ? '#16a34a' : '#7c3aed';
    this.svg.append(el('rect', {
      x: r.x, y: r.y, width: r.w, height: r.h, rx: 2,
      fill: tint, 'fill-opacity': 0.10, stroke: tint,
      'stroke-width': 1.2, 'stroke-dasharray': '5 4',
    }));
    const tag = document.createElement('span');
    tag.className = 'ov-tag';
    tag.textContent = an.variant === 'link' ? (an.url ?? 'Link')
      : an.variant === 'crop' ? 'Keep this area'
      : an.fieldType === 'check' ? 'Checkbox' : 'Text field';
    tag.style.left = `${(r.x / this.pageW) * 100}%`;
    tag.style.top = `${(r.y / this.pageH) * 100}%`;
    tag.style.setProperty('--tint', tint);
    this.marks.append(tag);
  }

  private paintStamp(an: Extract<Annot, {kind: 'stamp'}>): void {
    const w = stampWidth(an.label);
    this.svg.append(el('rect', {
      x: an.at.x, y: an.at.y, width: w, height: STAMP_HEIGHT, rx: 4,
      fill: 'none', stroke: an.color, 'stroke-width': 1.8,
    }));
    const t = el('text', {
      x: an.at.x + w / 2, y: an.at.y + STAMP_HEIGHT / 2 + STAMP_SIZE * 0.36,
      'text-anchor': 'middle', 'font-size': STAMP_SIZE, 'font-weight': '700',
      'font-family': 'Helvetica, Arial, sans-serif', fill: an.color, 'letter-spacing': '0.8',
    });
    t.textContent = an.label;
    this.svg.append(t);
  }

  private paintImage(an: Extract<Annot, {kind: 'image'}>): void {
    this.svg.append(el('image', {
      x: an.at.x, y: an.at.y, width: an.w, height: an.h, href: an.src,
      preserveAspectRatio: 'none',
    }));
  }

  private paintText(an: TextAnnot): void {
    if (an.cover) {
      const r = rectOf(an.cover.a, an.cover.b);
      this.svg.append(el('rect', {x: r.x, y: r.y, width: r.w, height: r.h,
                                  fill: an.coverColor ?? '#ffffff'}));
    }

    /* One rectangle, not two.
     *
     * The frame and the handles used to be drawn on the marks layer, on top of
     * a box that already had a border of its own — so a selected text box was
     * two nested outlines a pixel or so apart, with the handle hanging off the
     * outer one. The box now carries its own frame and its own handles, which
     * is the only way the two can never disagree about where the edge is. */
    const b = boundsOf(an);
    const wrap = document.createElement('div');
    wrap.className = 'ov-box';
    wrap.dataset['box'] = an.id;
    wrap.style.left = `${(b.x / this.pageW) * 100}%`;
    wrap.style.top = `${(b.y / this.pageH) * 100}%`;
    wrap.style.width = `${(b.w / this.pageW) * 100}%`;
    wrap.style.height = `${(b.h / this.pageH) * 100}%`;

    const box = document.createElement('div');
    box.className = 'ov-text';
    box.dataset['text'] = an.id;
    box.spellcheck = false;
    box.textContent = an.text;
    /* Geometry scales for free through the SVG viewBox, but HTML does not — so
       the one number that has to be multiplied by the zoom is this one. */
    box.style.fontSize = `${an.size * this.ctx.scale()}px`;
    box.style.color = an.color;
    /* The page's own face when the annotation carries one — the browser has it
       registered under pdf.js's key since the page first rendered, so naming it
       costs nothing. The standard family stays in the stack as the fallback. */
    const doc = an.face ? docFace(an.face) : null;
    box.style.fontFamily = doc ? `"${doc.cssKey}", ${CSS_FONT[an.font]}` : CSS_FONT[an.font];
    /* Weight and slope are asked for only of the stand-ins. The document's own
       face is already the bold cut — it is what the writer embeds and draws at
       its natural weight — and asking again gets Chrome's synthetic bold on top
       of a bold, which is wider on screen than the same run is in the file. */
    box.style.fontWeight = !doc && isBold(an.font) ? '700' : '400';
    box.style.fontStyle = !doc && isItalic(an.font) ? 'italic' : 'normal';
    /* A run that already knows where its line ends must not be re-wrapped to
       the width of the frame around it — see TextAnnot.nowrap. */
    if (an.nowrap) box.style.whiteSpace = 'pre';
    /* And it keeps none of the caret room a typed box wants. The padding is a
       constant number of CSS pixels while everything round it is a percentage
       of the page, so a run placed to the point sat two pixels right and one
       below the words it replaced — by a different amount at every zoom, and by
       none at all once the file was written. */
    if (an.nowrap) box.style.padding = '0';
    /* And it keeps the spacing it was calibrated to, so the words it replaced
       and the words replacing them are the same width on the page. */
    if (an.tracking) box.style.letterSpacing = `${an.tracking * this.ctx.scale()}px`;

    /* Pinned to the baseline it was measured on, where there is one.
     *
     * Left to the line box, the first baseline lands wherever half the leading
     * and the face's own ascent put it, which is a third answer — different
     * from the one the paragraph editor showed and from the one the writer
     * puts in the file. The run carries the only number all three can agree
     * on, so the box is simply moved until its baseline is at it. */
    if (an.lead !== undefined) {
      const F = an.size * this.ctx.scale();
      RULER.font = `${box.style.fontStyle} ${box.style.fontWeight} ${F}px ${box.style.fontFamily}`;
      const m = RULER.measureText('H');
      /* The same fallback the paragraph editor uses, so the two cannot disagree
         about where a baseline is on a browser that reports neither. */
      const asc = m.fontBoundingBoxAscent || F * 0.91;
      const desc = m.fontBoundingBoxDescent || F * 0.21;
      box.style.top = `${an.lead * this.ctx.scale() - (1.3 * F - (asc + desc)) / 2 - asc}px`;
    }

    /* The frame follows the words as they are typed.
     *
     * The model works out a height by counting newlines, which is all it can do
     * without a browser to ask — it cannot know where a long line will wrap. So
     * the frame is measured from what was actually laid out and grown to fit,
     * live, because re-rendering the whole layer on every keystroke would take
     * the caret with it. The dragged height stays the floor: a box you made
     * tall stays tall, a box you made short still grows rather than swallowing
     * what you typed. */
    const fit = () => {
      const floor = (boundsOf(an).h / this.pageH) * (this.root.clientHeight || 0);
      wrap.style.height = `${Math.max(box.scrollHeight, floor)}px`;
    };
    box.addEventListener('input', () => { an.text = box.textContent ?? ''; fit(); });
    box.addEventListener('blur', () => {
      an.text = box.textContent ?? '';
      /* The caret has left, so the box goes back to being a mark like any
         other: draggable, resizable, and no longer swallowing the pointer. */
      if (this.typingIn === an.id) this.typingIn = null;
      if (!an.text.trim()) this.store.remove(an.id);
      this.ctx.afterEdit();
      this.render();
    });
    /* With Select active the box lets the pointer through, so dragging it moves
       it like any other mark. While a text tool is active it takes the pointer
       itself, because then you mean to type. Double-click gets you back in. */
    const typing = this.ctx.tool() === 'text' || this.ctx.tool() === 'edit-text'
      || this.typingIn === an.id;
    box.style.pointerEvents = typing ? 'auto' : 'none';
    box.contentEditable = typing ? 'plaintext-only' : 'false';
    box.addEventListener('pointerdown', e => { if (typing) e.stopPropagation(); });

    wrap.append(box);
    /* Handles only while it is the selected mark — a page of eight text boxes
       wearing sixty-four handles is not a page anyone can read. */
    if (this.ctx.selected() === an.id) {
      wrap.classList.add('ov-box--on');
      addHandles(wrap, an.id, {move: true});
    }
    this.html.append(wrap);

    /* Measuring forces a layout, so it is done only for the box wearing the
       handles — on the eleven nobody is looking at, the frame does not matter. */
    if (this.ctx.selected() === an.id) fit();
  }

  private paintSelection(an: Annot): void {
    /* A text box draws its own frame, so drawing a second one here is what put
       two rectangles round it. */
    if (an.kind === 'text') return;

    const b = boundsOf(an);
    const frame = document.createElement('div');
    frame.className = 'ov-sel';
    frame.style.left = `${(b.x / this.pageW) * 100}%`;
    frame.style.top = `${(b.y / this.pageH) * 100}%`;
    frame.style.width = `${(b.w / this.pageW) * 100}%`;
    frame.style.height = `${(b.h / this.pageH) * 100}%`;

    /* Ink and stamps size themselves — a scribble has no meaningful width to
       drag and a stamp is as big as its word. A text mark is measured from the
       text, so resizing it would only take it off the line. */
    if (an.kind !== 'ink' && an.kind !== 'stamp' && an.kind !== 'mark') {
      addHandles(frame, an.id, {move: false});
    }
    this.marks.append(frame);
  }
}

/* The eight grips of a selection.
 *
 * Corners pull both axes, edges pull one — the side you take hold of is the
 * side that moves, and the opposite side stays put. The top-right corner is
 * the odd one out on a text box: the body of that box belongs to the caret, so
 * something has to be the thing you drag it by, and a corner you can always
 * find beats a strip of border you have to hunt for.
 *
 * The dragging itself is handled in down(), which reads these attributes. */
const EDGES: readonly Edge[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

function addHandles(frame: HTMLElement, id: string, {move}: {move: boolean}): void {
  for (const edge of EDGES) {
    const h = document.createElement('span');
    const isMove = move && edge === 'ne';
    h.className = isMove ? 'ov-h ov-h--move' : `ov-h ov-h--${edge}`;
    h.dataset['for'] = id;
    if (isMove) h.dataset['move'] = '1';
    else h.dataset['edge'] = edge;
    h.title = isMove ? 'Drag to move' : 'Drag to resize';
    frame.append(h);
  }
}
