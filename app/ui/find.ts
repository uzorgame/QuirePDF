import type {QuireDoc} from '../core/document';

/* Finding words in the open document.
 *
 * The toolbar has advertised Ctrl+F since the day it was drawn and the button
 * answered with "Search is designed but not wired up yet" — a control that
 * names a feature and then apologises for it. This is the feature.
 *
 * Hits are not annotations. Everything in the annotation store is written into
 * the exported PDF and snapshotted into every undo entry, so a search that put
 * its highlights there would export them and fill the history with them. They
 * live in their own layer, and vanish when the bar closes. */

export interface Hit {
  page: number;
  /** Top-left page points, the frame the rest of the editor works in. */
  x: number; y: number; w: number; h: number;
}

/* One run of text with the geometry needed to draw a box round it. */
interface Run {
  page: number;
  text: string;
  lower: string;
  x: number; y: number; w: number; h: number;
}

export class Finder {
  private runs: Run[] | null = null;
  private doc: QuireDoc | null = null;

  /* Built once per document and kept. Scanning a twenty-page form takes about
     a fifth of a second, and doing it on every keystroke would make the bar
     feel broken on exactly the documents where search matters most. */
  async index(doc: QuireDoc): Promise<void> {
    if (this.doc === doc && this.runs) return;
    this.doc = doc;
    this.runs = [];
    for (let n = 1; n <= doc.pageCount; n++) {
      for (const r of await doc.runsOn(n)) this.runs.push({...r, page: n, lower: r.text.toLowerCase()});
    }
  }

  reset(): void { this.runs = null; this.doc = null; }

  /* Matches inside a single run. A phrase split across two runs is missed, and
     that is the honest trade: pdf.js splits runs wherever the file changed
     font, size or position, so stitching them back into lines to search across
     the join reintroduces exactly the column-order guesswork that makes
     converted text nonsense. Words and short phrases — what people actually
     search for — sit inside one run. */
  search(query: string): Hit[] {
    const q = query.trim().toLowerCase();
    if (!q || !this.runs) return [];

    const hits: Hit[] = [];
    for (const run of this.runs) {
      let from = 0;
      for (;;) {
        const at = run.lower.indexOf(q, from);
        if (at < 0) break;
        /* The box is interpolated across the run by character count. Exact
           per-glyph positions would need the font metrics pdf.js does not hand
           out; on a run of one face and one size — which every run is, by
           definition — proportion is close enough to land on the word. */
        const unit = run.w / Math.max(1, run.text.length);
        hits.push({
          page: run.page,
          x: run.x + unit * at,
          y: run.y,
          w: Math.max(unit * q.length, 2),
          h: run.h,
        });
        from = at + q.length;
      }
    }
    return hits;
  }
}

/* The per-page layer that draws them. Same shape as the overlay and the field
   layer, so the viewer creates it through the same seam and it survives a
   zoom — anything injected into a page slot directly is wiped by the rebuild. */
export class FindLayer {
  readonly root: HTMLElement;
  private hits: Hit[] = [];

  constructor(
    private pageNo: number,
    private pageW: number,
    private pageH: number,
    private ctx: {hits(): Hit[]; currentIndex(): number; all(): Hit[]},
  ) {
    this.root = document.createElement('div');
    this.root.className = 'fd';
  }

  render(): void {
    const all = this.ctx.all();
    const active = all[this.ctx.currentIndex()];
    this.hits = this.ctx.hits().filter(h => h.page === this.pageNo);
    this.root.replaceChildren();
    for (const h of this.hits) {
      const box = document.createElement('span');
      box.className = 'fd-hit';
      if (active && h === active) box.classList.add('fd-hit--on');
      box.style.left = `${(h.x / this.pageW) * 100}%`;
      box.style.top = `${(h.y / this.pageH) * 100}%`;
      box.style.width = `${(h.w / this.pageW) * 100}%`;
      box.style.height = `${(h.h / this.pageH) * 100}%`;
      this.root.append(box);
    }
  }
}
