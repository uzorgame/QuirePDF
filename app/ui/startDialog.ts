import {PDFDocument} from 'pdf-lib';
import {TEMPLATES, TEMPLATE_GROUPS, type Template} from '../core/templates';
import {pdfjs} from '../core/pdfjs';
import {renderPage, pageBox} from '../core/render';

/* The start dialog: pick a document to begin from.
 *
 * Every preview is the template itself, built with pdf-lib and rendered with
 * pdf.js on the spot. Nothing here is a picture of a document — what you see in
 * the tile is byte for byte what opens, which removes the usual gap between a
 * template gallery and the file you actually get. It also means the library
 * costs no download at all until somebody opens it. */
const PREVIEW_WIDTH = 190;

export class StartDialog {
  private built = false;
  private onPick: (t: Template) => void = () => {};

  constructor(private overlay: HTMLElement, private grid: HTMLElement) {
    overlay.addEventListener('mousedown', e => {
      if (e.target === overlay) this.close();
    });
    overlay.querySelectorAll('[data-close]').forEach(b =>
      b.addEventListener('click', () => this.close()));

    grid.addEventListener('click', e => {
      const card = (e.target as HTMLElement).closest<HTMLElement>('.tpl');
      if (!card) return;
      const t = TEMPLATES.find(x => x.id === card.dataset['id']);
      if (t) { this.close(); this.onPick(t); }
    });
  }

  onSelect(fn: (t: Template) => void): void {
    this.onPick = fn;
  }

  get isOpen(): boolean {
    return this.overlay.classList.contains('on');
  }

  async open(): Promise<void> {
    this.overlay.classList.add('on');
    if (this.built) return;
    this.built = true;
    this.render();
    await this.paintPreviews();
  }

  close(): void {
    this.overlay.classList.remove('on');
  }

  private render(): void {
    this.grid.replaceChildren();

    for (const group of TEMPLATE_GROUPS) {
      const items = TEMPLATES.filter(t => t.group === group);
      if (!items.length) continue;

      const head = document.createElement('h4');
      head.className = 'tpl-group';
      head.textContent = group;
      this.grid.append(head);

      const row = document.createElement('div');
      row.className = 'tpl-row';
      for (const t of items) {
        const card = document.createElement('button');
        card.className = 'tpl';
        card.dataset['id'] = t.id;
        card.innerHTML =
          `<span class="tpl-art"><canvas data-preview="${t.id}"></canvas></span><b></b><em></em>`;
        card.querySelector('b')!.textContent = t.name;
        card.querySelector('em')!.textContent = t.blurb;
        row.append(card);
      }
      this.grid.append(row);
    }
  }

  /* Built one at a time rather than all at once. Sixteen pdf-lib documents plus
     sixteen pdf.js instances in parallel will stall the main thread on a modest
     machine, and sequentially the tiles fill fast enough that nobody waits. */
  /* All sixteen at once, not one after another.
   *
   * Built in sequence they arrived over a second and a half, tile by tile, each
   * one replacing a shimmering placeholder — which does not read as a grid
   * loading, it reads as a grid failing. Every preview is an independent little
   * document, so nothing was gaining from the queue; started together they land
   * together and the dialog is simply ready. */
  private async paintPreviews(): Promise<void> {
    await Promise.all(TEMPLATES.map(async t => {
      const canvas = this.grid.querySelector<HTMLCanvasElement>(`canvas[data-preview="${t.id}"]`);
      if (!canvas) return;
      try {
        const doc = await PDFDocument.create();
        await t.build(doc);
        const task = pdfjs.getDocument({data: await doc.save()});
        const page = await (await task.promise).getPage(1);
        const scale = PREVIEW_WIDTH / pageBox(page, 1).width;
        await renderPage(page, canvas, {scale, dpr: 1}).done;
        canvas.parentElement?.classList.add('tpl-art--done');
        await task.destroy();
      } catch {
        /* A template that fails to build costs its own tile, not the dialog. */
        canvas.remove();
      }
    }));
  }
}
