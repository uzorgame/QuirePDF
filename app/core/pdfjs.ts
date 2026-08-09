import * as pdfjs from 'pdfjs-dist';

/* The worker is resolved relative to this module rather than to the page,
   because the site is served from /quirePDF/ and a path written against the
   page would break on one of the two roots.
 *
 * Which module, though, is not fixed. Since the build gained a second entry,
 * the shared code lands in assets/chunks/ instead of assets/ — and this line,
 * written as a sibling lookup, went looking for the worker in chunks/ and got a
 * 404. pdf.js then reports "could not be opened as a PDF", which points at the
 * file rather than at the path, so it is worth being explicit: find the assets
 * root by stepping out of chunks/ when that is where we are. */
const here = new URL('.', import.meta.url);
const assets = here.pathname.endsWith('/chunks/') ? new URL('../', here) : here;
/* @vite-ignore — the worker is copied into assets/ by tools/build.mjs, so it does
   not exist at bundle time and must not be resolved or hashed. */
pdfjs.GlobalWorkerOptions.workerSrc = new URL(/* @vite-ignore */ 'pdf.worker.mjs', assets).href;

export {pdfjs};
export type {PDFDocumentProxy, PDFDocumentLoadingTask, PDFPageProxy} from 'pdfjs-dist';
