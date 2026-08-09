import type {PDFPageProxy} from './pdfjs';

/* pdf.js hands back a render task, not a promise you can drop. Scrolling or
   zooming fires renders faster than they finish, and an abandoned one will
   happily paint over its successor — so every render is cancellable and the
   caller is expected to cancel the previous one. */
export interface Render {
  readonly canvas: HTMLCanvasElement;
  readonly done: Promise<void>;
  cancel(): void;
}

export interface RenderOptions {
  /* CSS pixels per PDF point. 1 is 72dpi. */
  scale: number;
  /* Device pixels per CSS pixel. Passed in rather than read from the global so
     tests and thumbnails can force 1 and stay cheap. */
  dpr?: number;
}

export function renderPage(
  page: PDFPageProxy,
  canvas: HTMLCanvasElement,
  {scale, dpr = window.devicePixelRatio || 1}: RenderOptions,
): Render {
  const viewport = page.getViewport({scale: scale * dpr});

  /* The canvas is sized in device pixels and laid out in CSS pixels. Skipping
     this is what makes a PDF viewer look soft on a retina screen. */
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  /* Divided, not floored a second time.
   *
   * Rounding the bitmap to whole pixels and the CSS box down separately left
   * the two disagreeing by a fraction — 1235 device pixels shown in a box 1234
   * wide — and the browser resampled the entire page to reconcile them. That
   * resample is why the printed text looked soft beside the same words set in
   * the DOM, which is exactly what shows when a paragraph is opened for
   * editing. A fractional CSS length is exact here: one canvas pixel per device
   * pixel, and nothing is stretched. */
  canvas.style.width = `${canvas.width / dpr}px`;
  canvas.style.height = `${canvas.height / dpr}px`;

  const ctx = canvas.getContext('2d', {alpha: false});
  if (!ctx) throw new Error('Canvas 2D is unavailable in this browser.');

  const task = page.render({canvas, canvasContext: ctx, viewport});

  return {
    canvas,
    cancel: () => task.cancel(),
    /* A cancelled render is the normal outcome of scrolling, not a failure, so
       it resolves quietly instead of rejecting into the caller's error path. */
    done: task.promise.catch((err: unknown) => {
      if (err && typeof err === 'object' && (err as {name?: string}).name === 'RenderingCancelledException') return;
      throw err;
    }),
  };
}

/* Page size in CSS pixels at a given scale — needed to lay out the placeholder
   before the render arrives, so the page does not jump when it paints.
 *
 * Exact, not floored. This is also the coordinate system every layer over the
 * page is given: the overlay's viewBox, the text layer's percentages, the
 * paragraph frames, the unit annotations are stored in. A page 611.98 points
 * wide described as 611 is a system a sixth of a per cent too small, and
 * everything drawn in it drifts further from the print the closer it gets to
 * the right-hand edge — about a pixel across a full page, which is exactly the
 * crooked pixel this editor cannot afford. The fractional length is not a
 * problem for the canvas either: the page is snapped onto the device grid
 * after layout, where the real position is finally known. */
export function pageBox(page: PDFPageProxy, scale: number): {width: number; height: number} {
  const v = page.getViewport({scale});
  return {width: v.width, height: v.height};
}
