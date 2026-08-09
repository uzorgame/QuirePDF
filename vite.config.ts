import {defineConfig} from 'vite';
import {fileURLToPath} from 'node:url';

/* The site is 54 static HTML pages and exactly one of them is an application,
 * so Vite is not asked to own the site. It compiles the editor into a single ES
 * module that editor.html loads like any other script; tools/build.mjs still
 * produces the pages. The two halves meet in assets/.
 *
 * `root` points at app/ deliberately. Left at the project root, Vite discovers
 * the HTML files and switches to a multi-page build — which then quietly drops
 * the 49 pages that live in subdirectories, because its scan does not recurse.
 * Pointing it at a directory with no HTML in it keeps the build to the one job
 * we actually want from it.
 *
 * emptyOutDir must stay false: assets/ is also where the hand-written CSS
 * lives, and a clean build would delete it. */
export default defineConfig({
  root: fileURLToPath(new URL('./app', import.meta.url)),
  /* Relative, because nothing here knows where it will be served from.
   *
   * The default base of `/` is baked into the preload helper Vite writes around
   * every dynamic import, and that helper resolves against the *page*, not the
   * module. A page served at /editor therefore asked for /convert-engine.js and
   * /chunks/…, all three of which are one directory up from where they are —
   * three 404s on every load of the editor, silent because the real import that
   * follows is module-relative and succeeds. Under uz-or.com/quirePDF/ the
   * same absolute base would have missed by a directory as well. */
  base: './',
  /* The local server never caches. The built bundle keeps one name, and a
     browser holding yesterday's editor.js while testing today's fixes reports
     yesterday's bugs — which happened, at length. Production hosting has its
     own rules; this only governs vite preview. */
  preview: {headers: {'Cache-Control': 'no-store'}},
  build: {
    outDir: fileURLToPath(new URL('./assets', import.meta.url)),
    emptyOutDir: false,
    target: 'es2022',
    sourcemap: true,
    /* Two entries rather than one library.
     *
     * The editor needs pdf.js and pdf-lib on load; a converter page must not.
     * Somebody turning a PNG into a JPG should download the few kilobytes that
     * does, not the megabyte the PDF engine weighs — so the heavy conversions
     * live in their own module that assets/convert.js reaches for only when the
     * conversion in front of it actually needs one.
     *
     * `inlineDynamicImports` is off for the same reason: libheif is a megabyte
     * and a half of WebAssembly glue, and it should arrive on the HEIC page and
     * nowhere else. */
    rollupOptions: {
      /* Without this the converter engine builds to two hundred bytes.
         Vite treats an entry as something a page runs for its side effects, so
         Rollup drops every export nothing else imports — and here nothing else
         does, because the only consumer reaches for it with a dynamic import at
         runtime. Keeping the signature keeps the exports. */
      preserveEntrySignatures: 'allow-extension',
      input: {
        editor: fileURLToPath(new URL('./app/main.ts', import.meta.url)),
        'convert-engine': fileURLToPath(new URL('./app/convert/heavy.ts', import.meta.url)),
      },
      output: {
        format: 'es',
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
      },
    },
  },
});
