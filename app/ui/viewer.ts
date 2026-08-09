import type {QuireDoc} from '../core/document';
import {renderPage, pageBox, type Render} from '../core/render';
import type {PDFPageProxy} from '../core/pdfjs';
import type {BlockRestyle} from './blockLayer';

/* The stage: every page stacked in one scrolling column.
 *
 * Pages are laid out at their real size immediately and painted only when they
 * come near the viewport. Laying out first matters — if the placeholder had no
 * height the scrollbar would grow as pages painted, and the document would
 * crawl away under the cursor. */
export class Viewer {
  private doc: QuireDoc | null = null;
  private slots: HTMLElement[] = [];
  private pages = new Map<number, PDFPageProxy>();
  private renders = new Map<number, Render>();
  private io: IntersectionObserver | null = null;
  private current = 1;
  private listeners: Array<(page: number, total: number) => void> = [];
  private scrolls: Array<(fraction: number) => void> = [];

  /** CSS pixels per PDF point. */
  scale = 1;

  /* Supplied by main.ts. The viewer owns page geometry and knows nothing about
     annotations; the factory is how the two meet without either importing the
     other's concerns. */
  overlays: {
    create(page: number, w: number, h: number):
      {root: HTMLElement; render(): void; attach(host: HTMLElement): void};
  } | null = null;
  private ovs = new Map<number, {root: HTMLElement; render(): void; attach(host: HTMLElement): void}>();

  /* The form's own fields. Separate from the annotation layer because they are
     part of the file rather than something we added, and they are only built
     for pages that actually carry widgets. */
  fields: {
    create(page: number, w: number, h: number):
      {root: HTMLElement; render(): void; load(p: PDFPageProxy): Promise<void>};
  } | null = null;
  private fls = new Map<number, {root: HTMLElement; render(): void}>();

  /* The search highlight layer. A third factory of the same shape, so it is
     rebuilt on zoom like the other two rather than being wiped by it. */
  finds: {create(page: number, w: number, h: number): {root: HTMLElement; render(): void}} | null = null;
  private fds = new Map<number, {root: HTMLElement; render(): void}>();

  repaintFinds(): void { for (const [, fd] of this.fds) fd.render(); }

  /* The selectable words. Above the canvas so the browser can select them,
     below everything that takes a pointer for its own purposes. */
  texts: {
    create(page: number, w: number, h: number):
      {root: HTMLElement; render(): void; load(p: PDFPageProxy): Promise<void>};
  } | null = null;
  private tls = new Map<number, {root: HTMLElement; render(): void}>();

  repaintTexts(): void { for (const [, tl] of this.tls) tl.render(); }

  /* The paragraphs of the page, for the text editor. Its own factory because
     it owns state the others do not — a block can be open and half-typed, and
     that has to survive the repaints the other layers take in their stride. */
  blocks: {
    create(page: number, w: number, h: number):
      {root: HTMLElement; render(): void; load(p: PDFPageProxy): Promise<void>;
       close(save: boolean): Promise<void>; undo(): boolean;
       applyStyle(c: BlockRestyle): void; readonly isOpen: boolean};
  } | null = null;
  private bls = new Map<number, {root: HTMLElement; render(): void;
                                 close(save: boolean): Promise<void>; undo(): boolean;
                                 applyStyle(c: BlockRestyle): void;
                                 readonly isOpen: boolean}>();

  repaintBlocks(): void { for (const [, bl] of this.bls) bl.render(); }

  /** Close whatever paragraph is open, anywhere in the document. */
  async closeBlocks(save: boolean): Promise<void> {
    for (const [, bl] of this.bls) if (bl.isOpen) await bl.close(save);
  }

  get blockOpen(): boolean { return [...this.bls.values()].some(b => b.isOpen); }

  /** Restyle the selection inside the open paragraph, if there is one. */
  styleInBlock(c: BlockRestyle): boolean {
    for (const [, bl] of this.bls) if (bl.isOpen) { bl.applyStyle(c); return true; }
    return false;
  }

  /** Step back inside the open paragraph. False when it has nothing to undo. */
  undoInBlock(): boolean {
    for (const [, bl] of this.bls) if (bl.isOpen) return bl.undo();
    return false;
  }

  /* Handed to whatever needs to turn a DOM selection into page coordinates. */
  textLayers(): HTMLElement[] { return [...this.tls.values()].map(t => t.root); }

  constructor(private stage: HTMLElement, private column: HTMLElement) {}

  /** Repaint the layers of the given pages, or all of them. */
  repaintOverlays(pages?: Set<number>): void {
    for (const [n, ov] of this.ovs) if (!pages || pages.has(n)) ov.render();
  }

  repaintFields(): void {
    for (const [, fl] of this.fls) fl.render();
  }

  /** Page size in PDF points, which is the unit annotations are stored in. */
  pointSize(n: number): {w: number; h: number} | null {
    const page = this.pages.get(n);
    if (!page) return null;
    const b = pageBox(page, 1);
    return {w: b.width, h: b.height};
  }

  onPageChange(fn: (page: number, total: number) => void): void {
    this.listeners.push(fn);
  }

  private emit(): void {
    const total = this.doc?.pageCount ?? 0;
    for (const fn of this.listeners) fn(this.current, total);
  }

  async setDocument(doc: QuireDoc, {keepScale = false} = {}): Promise<void> {
    this.teardown();
    this.doc = doc;

    for (let n = 1; n <= doc.pageCount; n++) this.pages.set(n, await doc.page(n));

    if (!keepScale) this.scale = this.fitWidthScale();
    this.build();
    this.emit();
  }

  /* Fit the widest page to the stage, minus its padding, capped at 1.5 so a
     narrow receipt does not open at 400%. */
  private fitWidthScale(): number {
    const first = this.pages.get(1);
    if (!first) return 1;
    const available = this.stage.clientWidth - 68;
    const natural = pageBox(first, 1).width;
    return Math.min(1.5, Math.max(0.25, available / natural));
  }

  private build(): void {
    /* The previous observer is disconnected first, and this is not tidiness.
     *
     * It watched the slots that are about to be thrown away, but its callback
     * looks pages up by number in the *current* array — so once those slots
     * detached it reported them as off-screen and duly cancelled the render and
     * removed the canvas of whatever page now holds that number. One leaked
     * observer per rebuild, and rebuilds happen on every zoom: after a few
     * turns of the wheel the document went white and stayed white. */
    this.io?.disconnect();
    this.io = null;
    this.column.replaceChildren();
    this.slots = [];
    this.ovs.clear();
    this.fls.clear();
    this.fds.clear();
    this.tls.clear();
    this.bls.clear();

    for (let n = 1; n <= (this.doc?.pageCount ?? 0); n++) {
      const page = this.pages.get(n)!;
      const {width, height} = pageBox(page, this.scale);

      const slot = document.createElement('div');
      slot.className = 'pv';
      slot.dataset['page'] = String(n);
      slot.style.width = `${width}px`;
      slot.style.height = `${height}px`;

      const num = document.createElement('span');
      num.className = 'pv-n';
      num.textContent = String(n);
      slot.append(num);

      if (this.overlays) {
        const pt = pageBox(page, 1);
        const ov = this.overlays.create(n, pt.width, pt.height);
        slot.append(ov.root);
        /* The slot, not the overlay's own element: the press has to be caught
           above every layer so a mark stays clickable through the text. */
        ov.attach(slot);
        this.ovs.set(n, ov);
      }

      if (this.texts) {
        const pt = pageBox(page, 1);
        const tl = this.texts.create(n, pt.width, pt.height);
        slot.append(tl.root);
        this.tls.set(n, tl);
        void tl.load(page);
      }

      /* A search highlight is something to see through, not something to
         click, so it sits above the page and below everything interactive. */
      if (this.finds) {
        const pt = pageBox(page, 1);
        const fd = this.finds.create(n, pt.width, pt.height);
        slot.append(fd.root);
        this.fds.set(n, fd);
      }

      /* Above the text and the highlights: a paragraph frame is something you
         aim at, so nothing may sit between it and the pointer except the
         form's own widgets. */
      if (this.blocks) {
        const pt = pageBox(page, 1);
        const bl = this.blocks.create(n, pt.width, pt.height);
        slot.append(bl.root);
        this.bls.set(n, bl);
        void bl.load(page);
      }

      /* Above the overlay, not below it. The overlay covers the whole page so
         it can catch a drag anywhere, which means anything underneath it never
         sees a click — the form's own boxes included. On top, the fields take
         the clicks that land on them and everything else falls through to the
         overlay exactly as before. */
      if (this.fields) {
        const pt = pageBox(page, 1);
        const fl = this.fields.create(n, pt.width, pt.height);
        slot.append(fl.root);
        this.fls.set(n, fl);
        /* Loading is async and must not hold up the layout, so the widgets
           appear a beat after the page rather than delaying it. */
        void fl.load(page);
      }

      this.column.append(slot);
      this.slots.push(slot);
    }

    /* rootMargin pre-renders a screenful ahead in both directions, so ordinary
       scrolling never shows an empty sheet. */
    this.io = new IntersectionObserver(entries => {
      for (const e of entries) {
        const n = Number((e.target as HTMLElement).dataset['page']);
        if (e.isIntersecting) this.paint(n);
        else this.discard(n);
      }
      this.trackCurrent();
    }, {root: this.stage, rootMargin: '150% 0px'});

    for (const s of this.slots) this.io.observe(s);

    /* The observer's first callback is asynchronous and, in a backgrounded or
       hidden tab, can be delayed indefinitely — which would leave a freshly
       opened document showing nothing but empty sheets. So the pages that are
       already on screen are painted synchronously here, and the observer takes
       over from the second one onwards. */
    this.paintVisible();
  }

  private paintVisible(): void {
    const top = this.stage.scrollTop;
    const bottom = top + this.stage.clientHeight;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i]!;
      if (s.offsetTop < bottom && s.offsetTop + s.offsetHeight > top) {
        this.paint(i + 1);
        this.snapToGrid(s);
      }
    }
  }

  /* Put the page on the screen's own pixel grid.
   *
   * The bitmap is exactly one device pixel per canvas pixel — that part was
   * never wrong — but layout knows nothing about the grid, and a page 733.33px
   * wide centred in a column 732px wide starts at x=229.5, which on a 1.5×
   * screen is a quarter of a device pixel. A bitmap whose destination begins a
   * quarter of a pixel off the grid is drawn through a filter, and every
   * vertical stem of every glyph is smeared across two columns of pixels. That
   * is the whole difference between printed type that matches live text and
   * printed type that looks photographed — and it is why the copy of a
   * paragraph looks sharper the moment it is lifted off the page.
   *
   * The whole slot moves, not the canvas alone, so that every layer stacked on
   * the page keeps its exact registration with the print. The correction is a
   * third of a pixel at worst; nothing on screen moves that anyone can see. */
  private snapToGrid(slot: HTMLElement): void {
    const dpr = window.devicePixelRatio || 1;
    const was = {x: Number(slot.dataset['snapx']) || 0, y: Number(slot.dataset['snapy']) || 0};
    const r = slot.getBoundingClientRect();
    /* Measured back to where the page would sit with no correction at all, or
       each pass would correct its own previous answer. */
    const left = (r.left - was.x) * dpr;
    const top = (r.top - was.y) * dpr;
    const dx = (Math.round(left) - left) / dpr;
    const dy = (Math.round(top) - top) / dpr;
    if (Math.abs(dx - was.x) < 0.002 && Math.abs(dy - was.y) < 0.002) return;
    slot.dataset['snapx'] = String(dx);
    slot.dataset['snapy'] = String(dy);
    slot.style.transform = dx || dy ? `translate(${dx}px,${dy}px)` : '';
  }

  private paint(n: number): void {
    const slot = this.slots[n - 1];
    const page = this.pages.get(n);
    if (!slot || !page || slot.querySelector('canvas')) return;

    const canvas = document.createElement('canvas');
    slot.prepend(canvas);
    this.renders.get(n)?.cancel();
    const render = renderPage(page, canvas, {scale: this.scale});
    this.renders.set(n, render);
    /* A render that dies for a real reason — not a cancel, those resolve
       quietly — must not leave its blank canvas squatting in the slot, because
       paint() sees a canvas and declines to try again. Cleared, the next
       scroll or zoom repaints the page instead of inheriting the failure. */
    void render.done.catch(() => {
      canvas.remove();
      if (this.renders.get(n) === render) this.renders.delete(n);
    });
  }

  /* Canvases are the expensive part — a 200-page document rendered at 150%
     would hold hundreds of megabytes of bitmaps. Pages far from the viewport
     give theirs back. */
  private discard(n: number): void {
    const slot = this.slots[n - 1];
    if (!slot) return;
    this.renders.get(n)?.cancel();
    this.renders.delete(n);
    slot.querySelector('canvas')?.remove();
  }

  private trackCurrent(): void {
    const mid = this.stage.scrollTop + this.stage.clientHeight / 2;
    let found = 1;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i]!;
      if (s.offsetTop <= mid) found = i + 1;
    }
    if (found !== this.current) {
      this.current = found;
      this.emit();
    }
  }

  /* One paint check per frame, however many scroll events arrive. */
  private rafPaint = 0;

  private schedulePaint(): void {
    if (this.rafPaint) return;
    this.rafPaint = requestAnimationFrame(() => {
      this.rafPaint = 0;
      this.paintVisible();
    });
  }

  attachScroll(): void {
    this.stage.addEventListener('scroll', () => {
      this.trackCurrent();
      /* Belt to the observer's braces: whatever it misses or mistimes, a
         scrolled-to page is checked again on the next frame, so an empty sheet
         can last one frame at most. */
      this.schedulePaint();
      const room = this.stage.scrollHeight - this.stage.clientHeight;
      for (const fn of this.scrolls) fn(room > 0 ? this.stage.scrollTop / room : 0);
    }, {passive: true});

    /* The stage's width decides where the page is centred, so a resized window
       is a page that has come off the grid. */
    window.addEventListener('resize', () => this.schedulePaint());
    this.watchDpr();

    /* Ctrl and the wheel zoom the document, not the browser.
     *
     * Over a page, that gesture means "look closer at this", and letting the
     * browser take it scales the whole interface instead — the toolbar, the
     * sidebar and the page together, and the page no worse than blurred,
     * because the browser only stretches the picture that was already drawn.
     * Taken here it changes the render scale, so the page is drawn again at the
     * new size and the type genuinely sharpens.
     *
     * Not passive: the default has to be prevented, and a passive listener is
     * not allowed to. */
    let pending: {scale: number; x: number; y: number} | null = null;
    this.stage.addEventListener('wheel', e => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      /* A trackpad pinch arrives as a stream of small deltas and a mouse wheel
         as a few large ones. Scaling by the delta rather than stepping by a
         fixed factor keeps both feeling like the same gesture. */
      const step = Math.exp(-e.deltaY * 0.0022);
      /* Accumulated and applied once a frame. Each zoom rebuilds every page and
         its four layers, and a wheel can deliver a dozen events before the
         browser next paints — doing the work for all of them means the document
         is torn down and rebuilt a dozen times to show one result. */
      const first = !pending;
      pending = {
        scale: (pending?.scale ?? this.scale) * step,
        x: e.clientX,
        y: e.clientY,
      };
      if (!first) return;
      requestAnimationFrame(() => {
        const p = pending;
        pending = null;
        if (p) this.zoomAt(p.scale, p.x, p.y);
      });
    }, {passive: false});
  }

  /* devicePixelRatio is not a constant.
   *
   * Move the window to a second screen, or change Windows' display scaling, and
   * every canvas already painted keeps a bitmap drawn for the old ratio inside
   * a CSS box computed from that same old ratio — so a page rendered for 1× and
   * shown at 1.5× is magnified by half, which is the blurriest the document
   * ever looks. Only pages that scroll away and back would recover. matchMedia
   * is the only notice the browser gives, and the query has to be built again
   * after each change because it can only report leaving the value it was made
   * with. */
  private watchDpr(): void {
    const arm = (): void => {
      const dpr = window.devicePixelRatio || 1;
      matchMedia(`(resolution: ${dpr}dppx)`).addEventListener('change', () => {
        arm();
        for (const [n] of this.renders) this.discard(n);
        this.paintVisible();
      }, {once: true});
    };
    arm();
  }

  /* Zoom about a point on the screen, so whatever is under the pointer stays
     under it. Zooming about the page top instead throws the paragraph you were
     reading off the screen at the second notch. */
  private zoomAt(next: number, clientX: number, clientY: number): void {
    if (!this.doc) return;
    /* An open paragraph is written back before the pages are rebuilt.
     *
     * A zoom throws away every slot and every layer over it, the block layer
     * included — so a paragraph still being edited went with them: the frame,
     * the copy and everything typed into it vanished with no mark written, no
     * history entry and no warning. Every other way out of a block already
     * commits it; the zoom was the one door left open. */
    if (this.blockOpen) {
      void this.closeBlocks(true).then(() => this.zoomAt(next, clientX, clientY));
      return;
    }
    const before = this.scale;
    const scale = Math.min(4, Math.max(0.25, next));
    if (Math.abs(scale - before) < 0.0005) return;

    const box = this.stage.getBoundingClientRect();
    /* Where the pointer is in the scrolled content, before and after. */
    const px = this.stage.scrollLeft + (clientX - box.left);
    const py = this.stage.scrollTop + (clientY - box.top);
    const k = scale / before;

    this.scale = scale;
    for (const [n] of this.renders) this.discard(n);
    this.build();
    this.stage.scrollLeft = px * k - (clientX - box.left);
    this.stage.scrollTop = py * k - (clientY - box.top);
    this.paintVisible();
    this.emit();
  }

  /** How far through the document we are, 0 to 1. Fires on every scroll frame. */
  onScroll(fn: (fraction: number) => void): void {
    this.scrolls.push(fn);
  }

  goTo(n: number): void {
    const slot = this.slots[Math.min(Math.max(1, n), this.slots.length) - 1];
    if (!slot) return;
    this.stage.scrollTo({top: slot.offsetTop - 24, behavior: 'smooth'});
  }

  /* A point part-way down a page, which is what a search hit is. Landing on
     the page top and leaving the reader to find the highlight themselves is
     not much better than not scrolling at all. */
  goToPoint(n: number, yFraction: number): void {
    const slot = this.slots[Math.min(Math.max(1, n), this.slots.length) - 1];
    if (!slot) return;
    const into = slot.offsetHeight * Math.min(1, Math.max(0, yFraction));
    const top = slot.offsetTop + into - this.stage.clientHeight * 0.4;
    this.stage.scrollTo({top: Math.max(0, top), behavior: 'smooth'});
  }

  /* Zoom keeps the page you were looking at under the cursor rather than
     jumping back to the top, which is the difference between a viewer that
     feels like a tool and one that feels like a web page. */
  setScale(next: number): void {
    if (!this.doc) return;
    /* The same door as zoomAt's: the buttons and Fit width rebuild too. */
    if (this.blockOpen) {
      void this.closeBlocks(true).then(() => this.setScale(next));
      return;
    }
    const anchor = this.current;
    this.scale = Math.min(4, Math.max(0.25, next));
    for (const [n] of this.renders) this.discard(n);
    this.build();
    const slot = this.slots[anchor - 1];
    if (slot) this.stage.scrollTop = slot.offsetTop - 24;
    /* build() painted what was on screen before the jump; the observer will not
       catch up until its callback runs, which can be a frame or two away. */
    this.paintVisible();
    this.emit();
  }

  zoomBy(factor: number): void {
    this.setScale(this.scale * factor);
  }

  fitWidth(): void {
    this.setScale(this.fitWidthScale());
  }

  get zoomPercent(): number {
    return Math.round(this.scale * 100);
  }

  get currentPage(): number {
    return this.current;
  }

  private teardown(): void {
    this.io?.disconnect();
    for (const [, r] of this.renders) r.cancel();
    this.renders.clear();
    this.pages.clear();
    this.slots = [];
    this.current = 1;
  }
}
