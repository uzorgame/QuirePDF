import {PDFDocument, degrees} from 'pdf-lib';
import {pdfjs, type PDFDocumentProxy, type PDFDocumentLoadingTask, type PDFPageProxy} from './pdfjs';

/* One document, two libraries, and a clear rule about which owns what.
 *
 *   pdf-lib  edits structure — pages, rotation, and eventually the annotations
 *            we burn in on export. It writes bytes.
 *   pdf.js   renders. It reads bytes and knows nothing about our edits.
 *
 * The bytes are the single source of truth. Every structural change goes
 * through pdf-lib, produces new bytes, and pdf.js is reopened on them. That is
 * slower than patching a live render tree, but it means the thing on screen is
 * always literally the file you would download — there is no second model to
 * drift out of sync with the first, which is where editors of this shape
 * usually go wrong. */
export class QuireDoc {
  private constructor(
    private bytes: Uint8Array,
    private pdf: PDFDocumentProxy,
    /* The loading task, not the document, owns the worker — so it is the thing
       that has to be kept if we ever want to give the worker back. */
    private task: PDFDocumentLoadingTask,
    public name: string,
    /* Whether pdf-lib can rewrite this file, once it is known.
     *
     * The two libraries do not agree on what a valid PDF is. pdf.js is
     * forgiving — it renders almost anything, which is why USCIS and SSA forms
     * look perfect on screen. pdf-lib is stricter, and a good number of those
     * same forms load fine and then throw on the way out.
     *
     * Undefined until someone asks, because answering costs a full parse and
     * re-save and most documents never need a structural edit at all. */
    private writes: boolean | undefined,
  ) {}

  /* pdf.js transfers the buffer it is given to its worker, which detaches it.
     Handing over a copy is what keeps `bytes` usable afterwards — without this
     the second render of any document throws on a detached ArrayBuffer. */
  private static async load(
    bytes: Uint8Array, name: string, writes?: boolean,
  ): Promise<QuireDoc> {
    /* fontExtraProperties keeps the sanitised bytes of every embedded font on
       the font objects pdf.js builds. Without it the bytes are dropped the
       moment rendering has what it needs — and they are exactly what lets the
       editor offer the document's own faces in the font menu and embed them
       back into the export instead of substituting Helvetica. */
    const task = pdfjs.getDocument({data: bytes.slice(), fontExtraProperties: true});
    return new QuireDoc(bytes, await task.promise, task, name, writes);
  }

  static async open(bytes: Uint8Array, name: string): Promise<QuireDoc> {
    return QuireDoc.load(bytes, name);
  }

  /* Can pdf-lib hand these bytes back?
   *
   * Loading is not the test — the forms that matter here load perfectly and
   * fail at save, so the round trip is the only honest question to ask. The
   * answer is kept, because asking twice about the same bytes costs the same
   * again and can never come out differently. */
  async canWrite(): Promise<boolean> {
    if (this.writes !== undefined) return this.writes;
    const {log, warn} = console;
    console.log = console.warn = () => {};   // pdf-lib narrates its repairs
    try {
      const doc = await PDFDocument.load(this.bytes.slice(), {
        ignoreEncryption: true, updateMetadata: false,
      });
      await doc.save();
      this.writes = true;
    } catch {
      this.writes = false;
    } finally {
      console.log = log; console.warn = warn;
    }
    return this.writes;
  }

  static async fromBuilder(
    build: (doc: PDFDocument) => Promise<void> | void,
    name: string,
  ): Promise<QuireDoc> {
    const doc = await PDFDocument.create();
    await build(doc);
    /* pdf-lib wrote it a line ago, so there is nothing to ask. */
    return QuireDoc.load(await doc.save(), name, true);
  }

  get pageCount(): number {
    return this.pdf.numPages;
  }

  get size(): number {
    return this.bytes.byteLength;
  }

  /* 1-based, to match the page numbers the interface shows. */
  page(n: number): Promise<PDFPageProxy> {
    return this.pdf.getPage(n);
  }

  toBlob(bytes: Uint8Array = this.bytes): Blob {
    return new Blob([bytes.slice() as BlobPart], {type: 'application/pdf'});
  }

  /** A copy of the bytes, for the export writer to work on. */
  get raw(): Uint8Array {
    return this.bytes.slice();
  }

  /* Every run of text on a page, with its box in top-left page points.
   *
   * textIn answers "what words are inside this rectangle"; this answers
   "where is every word", which is what a search needs. Both read the same
   transform and apply the same flip, so a hit box and an edit box land in the
   same place. */
  async runsOn(n: number): Promise<Array<{text: string; x: number; y: number; w: number; h: number}>> {
    const page = await this.pdf.getPage(n);
    const height = page.getViewport({scale: 1}).height;
    const content = await page.getTextContent();
    const out: Array<{text: string; x: number; y: number; w: number; h: number}> = [];
    for (const item of content.items) {
      if (!('str' in item) || !item.str.trim()) continue;
      const [, , , d, e, f] = item.transform as number[];
      const size = Math.abs(d ?? 10);
      out.push({
        text: item.str,
        x: e ?? 0,
        y: height - (f ?? 0) - size,
        w: item.width || size * item.str.length * 0.5,
        h: size,
      });
    }
    return out;
  }

  /* The words already printed inside a rectangle, in top-left page points.
   *
   * This is what makes Edit text different from Add text: instead of an empty
   * box you get the sentence that is actually there, at the size it is set in
   * and in the face it is set in, ready to be changed. */
  async textIn(
    n: number, box: {x: number; y: number; w: number; h: number},
  ): Promise<{text: string; size: number; bold: boolean; serif: boolean; mono: boolean} | null> {
    const page = await this.pdf.getPage(n);
    const height = page.getViewport({scale: 1}).height;
    const content = await page.getTextContent();

    /* The real font name, which getTextContent does not give you.
     *
     * Its styles table normalises every family to "sans-serif" or "serif",
     * so there is no "Arial-BoldMT" to match on — which is why the replacement
     * for a bold heading came back in regular. The name does exist, in
     * commonObjs, under the id the runs carry: "…+HelveticaNeueLTStd-Bd".
     * commonObjs is filled by the render pass, so it has to be asked for; the
     * operator list is cached by pdf.js, so on a page already on screen this
     * costs nothing.
     *
     * Measuring the run width instead does not work, and it is worth saying
     * why: on this very form the bold heading measures 1.006 against Helvetica
     * and a regular italic line measures 1.097, because the ratio is dominated
     * by which face the document uses rather than by its weight. */
    try { await page.getOperatorList(); } catch { /* names stay unknown */ }
    const nameOf = (id: string): string => {
      try {
        const info = (page as unknown as {commonObjs: {get(k: string): {name?: string}}})
          .commonObjs.get(id);
        return String(info?.name ?? '').toLowerCase();
      } catch { return ''; }
    };

    const hits: Array<{
      x: number; y: number; str: string; size: number; face: string;
    }> = [];
    for (const item of content.items) {
      if (!('str' in item) || !item.str.trim()) continue;
      const [, , , d, e, f] = item.transform as number[];
      const size = Math.abs(d ?? 10);
      const top = height - (f ?? 0) - size;
      const left = e ?? 0;
      /* A run counts as inside if its baseline box overlaps the drag at all —
         people select roughly, and demanding full containment would return
         nothing most of the time. */
      if (left + item.width < box.x || left > box.x + box.w) continue;
      if (top + size < box.y || top > box.y + box.h) continue;
      const id = (item as {fontName?: string}).fontName ?? '';
      hits.push({x: left, y: top, str: item.str, size, face: nameOf(id)});
    
    }

    if (!hits.length) return null;
    hits.sort((a, b) => (Math.abs(a.y - b.y) > 3 ? a.y - b.y : a.x - b.x));

    /* The first run decides the face for the whole selection. A drag across a
       heading and the line under it is a drag the user should not have made,
       and guessing a blend of two faces would be worse than picking one. */
    const face = hits[0]!.face;
    return {
      text: hits.map(h => h.str).join(' ').replace(/\s+/g, ' ').trim(),
      size: Math.round(hits[0]!.size),
      /* Foundries spell weight a dozen ways and every one of them ends up in
         the PostScript name: Bold, Bd, Black, Blk, Heavy, Demi, Semibold. */
      bold: /bold|[-,]bd|black|blk|heavy|demi|semib|medi/.test(face),
      serif: /times|serif|georgia|garamond|roman|book|minion|cambria|caslon/.test(face)
             && !/sans/.test(face),
      mono: /mono|courier|consol/.test(face),
    };
  }

  /* Rasterising is pdf.js's job and lives here rather than in the export
     writer, which only knows pdf-lib. Redaction needs it: the only way to be
     sure a word is gone is to replace the page with a picture of itself. */
  async raster(n: number, scale: number): Promise<Uint8Array> {
    const page = await this.pdf.getPage(n);
    const viewport = page.getViewport({scale});
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d', {alpha: false});
    if (!ctx) throw new Error('Canvas 2D is unavailable in this browser.');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({canvas, canvasContext: ctx, viewport}).promise;

    const blob = await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/png'));
    if (!blob) throw new Error('This page could not be rasterised.');
    return new Uint8Array(await blob.arrayBuffer());
  }

  /** Same as raster, with opaque boxes painted on before the pixels are read. */
  async rasterWithBoxes(
    n: number, scale: number, boxes: Array<{x: number; y: number; w: number; h: number}>,
  ): Promise<Uint8Array> {
    const page = await this.pdf.getPage(n);
    const viewport = page.getViewport({scale});
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d', {alpha: false});
    if (!ctx) throw new Error('Canvas 2D is unavailable in this browser.');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({canvas, canvasContext: ctx, viewport}).promise;

    /* Painted after the render, so the pixels underneath are replaced rather
       than covered — which is the whole point. */
    ctx.fillStyle = '#000000';
    for (const b of boxes) ctx.fillRect(b.x * scale, b.y * scale, b.w * scale, b.h * scale);

    const blob = await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/png'));
    if (!blob) throw new Error('This page could not be rasterised.');
    return new Uint8Array(await blob.arrayBuffer());
  }

  /* Trim a page to a rectangle given in top-left page points.
   *
   * Both boxes are set, and that is the whole point. CropBox alone only tells a
   * viewer what to display — the content outside it is still in the file, so a
   * different reader, a print pipeline or anything that honours MediaBox shows
   * the parts you thought you had removed. Setting MediaBox as well makes the
   * page genuinely that size everywhere. */
  crop(n: number, box: {x: number; y: number; w: number; h: number}): Promise<QuireDoc> {
    return this.edit(doc => {
      const page = doc.getPage(n - 1);
      const {width, height} = page.getSize();

      /* Clamp to the page. A drag that started outside the paper would
         otherwise produce a MediaBox larger than the content it trims. */
      const x = Math.max(0, Math.min(box.x, width));
      const y = Math.max(0, Math.min(box.y, height));
      const w = Math.max(20, Math.min(box.w, width - x));
      const h = Math.max(20, Math.min(box.h, height - y));
      const bottom = height - y - h;

      page.setMediaBox(x, bottom, w, h);
      page.setCropBox(x, bottom, w, h);
    });
  }

  /* ── structural edits ────────────────────────────────
     Each returns a fresh QuireDoc rather than mutating this one, so undo is a
     matter of keeping the previous instance rather than replaying an inverse. */

  private async edit(
    fn: (doc: PDFDocument) => Promise<void> | void,
  ): Promise<QuireDoc> {
    const doc = await PDFDocument.load(this.bytes.slice());
    await fn(doc);
    /* The result came out of pdf-lib, so it is writable whatever the original
       was — a rotate on a repaired file leaves a file we can keep editing. */
    return QuireDoc.load(await doc.save(), this.name, true);
  }

  deletePage(n: number): Promise<QuireDoc> {
    return this.edit(doc => {
      if (doc.getPageCount() <= 1) throw new Error('A document needs at least one page.');
      doc.removePage(n - 1);
    });
  }

  rotatePage(n: number, by: number): Promise<QuireDoc> {
    return this.edit(doc => {
      const page = doc.getPage(n - 1);
      page.setRotation(degrees((page.getRotation().angle + by + 360) % 360));
    });
  }

  /* The new page copies the size of the one it follows, so inserting into an
     A5 booklet does not silently produce an A4 sheet in the middle. */
  insertBlankAfter(n: number): Promise<QuireDoc> {
    return this.edit(doc => {
      const {width, height} = doc.getPage(n - 1).getSize();
      doc.insertPage(n, [width, height]);
    });
  }

  movePage(from: number, to: number): Promise<QuireDoc> {
    return this.edit(async doc => {
      const [page] = await doc.copyPages(doc, [from - 1]);
      doc.removePage(from - 1);
      doc.insertPage(to - 1, page!);
    });
  }

  /* Every page's size in points, which the flattening export needs to build a
     new document the same shape as the old one. Taken from pdf.js because on an
     unwritable file it is the only library that can answer. */
  async pageSizes(): Promise<Array<{width: number; height: number}>> {
    const out: Array<{width: number; height: number}> = [];
    for (let n = 1; n <= this.pageCount; n++) {
      const vp = (await this.pdf.getPage(n)).getViewport({scale: 1});
      out.push({width: vp.width, height: vp.height});
    }
    return out;
  }

  async destroy(): Promise<void> {
    await this.task.destroy();
  }
}

export const UNWRITABLE =
  'This form uses a structure Quire cannot rewrite, so pages cannot be added, '
  + 'removed, rotated or cropped in it. Filling it in and exporting still works.';

