import type {QuireDoc} from '../core/document';
import {renderPage, pageBox} from '../core/render';

/* The page rail.
 *
 * Thumbnails were rendered at a fixed 150px and at device-pixel-ratio 1, then
 * stretched to whatever width the rail happened to be — on a retina screen that
 * is a 150px bitmap doing the work of 344 device pixels, which is exactly as
 * soft as it sounds. They are now rendered at the width they are actually shown
 * at, times the display's pixel ratio, so a thumbnail is sharp for the same
 * reason the page is. */
const FALLBACK_WIDTH = 172;

export class Thumbs {
  private current = 1;
  private onPick: (n: number) => void = () => {};
  /* Set while the reader is scrolling the rail themselves. Following the
     document at the same time would drag the rail out from under their finger,
     which is the single most irritating thing a page rail can do. */
  private held = 0;

  constructor(private root: HTMLElement, private count: HTMLElement) {
    this.root.addEventListener('click', e => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('.thumb');
      if (!el) return;
      const n = Number(el.dataset['page']);
      this.select(n);
      this.onPick(n);
    });

    const hold = () => { this.held = performance.now(); };
    this.root.addEventListener('wheel', hold, {passive: true});
    this.root.addEventListener('pointerdown', hold);
  }

  /* Follows the document scroll, rather than jumping when the page number
     changes.
     Snapping the active thumbnail into view on every page change is what made
     this feel broken: nothing happens for a whole page of scrolling and then
     the rail lurches. Mapping one scroll position onto the other means the
     rail glides in step with the document — you can watch the page you are
     heading towards come up the rail before you reach it. The fraction is a
     proportion of scrollable distance, not a page index, so it stays smooth
     between pages instead of stepping. */
  follow(fraction: number): void {
    if (performance.now() - this.held < 900) return;
    const room = this.root.scrollHeight - this.root.clientHeight;
    if (room <= 0) return;
    this.root.scrollTop = Math.round(Math.min(1, Math.max(0, fraction)) * room);
  }

  onSelect(fn: (n: number) => void): void {
    this.onPick = fn;
  }

  async setDocument(doc: QuireDoc): Promise<void> {
    this.root.replaceChildren();
    this.count.textContent = String(doc.pageCount);

    /* Measured once, from the rail itself, so the thumbnail matches whatever
       width the layout gives it rather than a number guessed at build time. */
    const styles = getComputedStyle(this.root);
    const inner = this.root.clientWidth
      - parseFloat(styles.paddingLeft || '0') - parseFloat(styles.paddingRight || '0');
    const width = Math.max(96, Math.round(inner || FALLBACK_WIDTH));
    /* At least 2, capped at 3. A thumbnail is small enough that the extra
       pixels cost almost nothing, and rendering one at 1× on a 1× display is
       where the softness in the rail came from — the sheet has a shadow and a
       rounded corner, and a 1× bitmap under those looks like a photograph of a
       page rather than a page. */
    const dpr = Math.min(3, Math.max(2, window.devicePixelRatio || 1));

    for (let n = 1; n <= doc.pageCount; n++) {
      const page = await doc.page(n);
      const scale = width / pageBox(page, 1).width;
      const {height} = pageBox(page, scale);

      const item = document.createElement('div');
      item.className = 'thumb';
      item.dataset['page'] = String(n);
      item.setAttribute('aria-current', String(n === this.current));

      const sheet = document.createElement('div');
      sheet.className = 'sheet';
      sheet.style.height = `${height}px`;

      const canvas = document.createElement('canvas');
      sheet.append(canvas);

      const label = document.createElement('div');
      label.className = 'n';
      label.textContent = String(n);

      item.append(sheet, label);
      this.root.append(item);

      /* Capped at 3: past that the extra pixels are invisible and the memory
         is not. */
      renderPage(page, canvas, {scale, dpr});
    }
  }

  /* Marks the current page. Deliberately does not scroll: while you are
     reading, follow() keeps the rail in step, and a second mechanism fighting
     it for the same scrollTop is what produced the stutter. Jumping to a page
     you asked for by name is reveal()'s job. */
  select(n: number): void {
    this.current = n;
    for (const el of this.root.querySelectorAll<HTMLElement>('.thumb')) {
      el.setAttribute('aria-current', String(Number(el.dataset['page']) === n));
    }
  }

  /* Brings a page into view because it was asked for — a page-number jump, a
     new document, an undo that removed the page you were on. Centred when it is
     off screen, left alone when it is already comfortably in view, so a jump to
     the next page does not shuffle the whole rail. */
  reveal(n: number): void {
    const el = this.root.querySelector<HTMLElement>(`.thumb[data-page="${n}"]`);
    if (!el) return;
    const rail = this.root;
    const top = el.offsetTop - rail.offsetTop;
    const pad = 16;
    if (top >= rail.scrollTop + pad
        && top + el.offsetHeight <= rail.scrollTop + rail.clientHeight - pad) return;
    const room = rail.scrollHeight - rail.clientHeight;
    const target = top - (rail.clientHeight - el.offsetHeight) / 2;
    rail.scrollTo({top: Math.min(room, Math.max(0, target)), behavior: 'smooth'});
    this.held = performance.now();
  }
}
