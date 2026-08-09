# Quire

A free PDF editor, converter and form library that runs entirely in the browser.
No backend, no accounts, no upload.

## Build

```bash
npm install
npm run build
```

`npm run build` is two halves: `node tools/build.mjs` produces the static site,
then `vite build` compiles the editor into `assets/editor.js`.

| command | does |
|---|---|
| `npm run build` | everything |
| `npm run site` | pages only — no bundling |
| `npm run dev` | rebuilds the editor bundle on change |
| `npm run check` | CSS collision check plus `tsc --noEmit` |

The site half regenerates every generated page, syncs the shared chrome into the
two hand-written ones, rebuilds `sitemap.xml` and `robots.txt` from what is
actually on disk, copies the pdf.js worker out of `node_modules`, and runs the
CSS check. Only `build.mjs` leaves the tree consistent — the individual builders
exist for quick iteration.

## Layout

```
index.html          hand-written body, generated header and footer
editor.html         hand-written body, generated header and footer
forms.html          generated
privacy.html        generated
terms.html          generated
convert/*.html      generated — 10 pages
forms/*.html        generated — one per form
app/                the editor, TypeScript, bundled by Vite
  core/             document model, rendering, templates, hand-off
  ui/               viewer, thumbnails, start dialog
assets/             stylesheets, plain-JS page behaviour, the built bundle
tools/              the site generators
```

## The editor

`app/core/document.ts` holds the rule the whole thing rests on: **the bytes are
the single source of truth.** pdf-lib owns structure and writes bytes; pdf.js
reads bytes and renders. Every structural change produces a new file and pdf.js
is reopened on it. That is slower than patching a live render tree, and it is
deliberate — what you see is literally the file you would download, so there is
no second model to drift out of sync with the first.

The start dialog's template previews are built and rendered on the spot rather
than shipped as pictures, so the tile and the document that opens cannot
disagree, and the whole library costs nothing until someone opens it.

Generated files carry a `GENERATED FILE — do not edit by hand` banner in their
first lines. Edit the generator, not the output.

## CSS conventions

There is no framework and no build step for the CSS, so the conventions are the
only thing keeping it from turning into a pile. `tools/check.mjs` enforces the
first two; it runs as part of the build and fails it.

**1. One name, one owner.** A class may be defined in exactly one stylesheet
that can reach a given page. Shared sheets (`tokens.css`, `site.css`,
`footer.css`) are on every page, so nothing else may redefine their classes.
Page-local sheets (`convert.css`, `forms.css`, `legal.css`) are never loaded
together and may reuse names between themselves — though in practice they do
not, because of rule 2.

**2. No bare element selectors outside the reset.** `tokens.css` is the reset
layer and styles `button`, `a` and friends on purpose. Everywhere else, style a
class. A `section {}` in a shared sheet reaches into pages nobody has written
yet, which is how the converter pages and the home page ended up with two
different definitions of the same section spacing.

**3. Prefix by owner.**

| prefix | owner |
|---|---|
| `q-` | shared layout primitives in `site.css` — `q-section`, `q-head`, `q-steps`, `q-step`, `q-ticks` |
| `sf-` | site footer |
| `drop-` | the header dropdowns |
| `conv-` | converter pages and the converter directory |
| `up-` | the upload card |
| `f-` | forms library and form pages |
| `legal` | privacy and terms |
| *(none)* | editor-internal only, and only inside `editor.html` |

The editor's own classes (`.bar`, `.tool`, `.page`, `.rail`, `.panel`, `.stage`)
are deliberately unprefixed because they live in one file and never leave it.
Do not lift any of them into a shared stylesheet without renaming.

**4. Overrides are scoped, not redeclared.** The editor needs tighter buttons
than the reading pages; it writes `.app .btn`, not `.btn`. An unscoped
redefinition wins on every page that ever links the file, which is a bug waiting
for a future page to exist.

## The annotation layer

Three files, and the split between them is the point.

`core/annots.ts` is the model: plain data in PDF points with a **top-left**
origin. PDF counts from the bottom-left, so keeping the model in the browser's
frame means exactly one flip — in `core/burn.ts`, at the moment of writing the
file — instead of a conversion at every pointer event.

`ui/overlay.ts` is the view: one layer per page, geometry as SVG with a viewBox
in page points so it scales with the zoom for free, text as real HTML because a
text box has to be editable.

`core/burn.ts` is the only thing that turns marks into a file. The overlay never
touches the bytes, which is why what you see and what downloads cannot disagree.

**Redaction is real.** Drawing a black box over words leaves the words in the
file, where anyone can select, copy or search them — the most common way
redaction is got wrong. Pages carrying a redaction are re-rendered and replaced
by an image of themselves, so the text underneath is gone. The cost is that
those pages stop being selectable text, and the export dialog says so before you
commit.

## What works, and what does not

Working, for real: opening a PDF from disk or by drop, sixteen built-in starting
documents, continuous rendering with lazy paint, thumbnails, zoom, page
navigation, and export.

Tools: **Add text · Edit text · Draw · Eraser · Highlight · Shapes · Image ·
Link · Sign · Stamp · Redact · Fields · Crop · Rotate · Delete**, plus insert
and reorder pages. Marks can be selected, moved, resized and deleted, and all of
them are written into the exported PDF — text as text, links as real link
annotations, fields as real AcroForm widgets.

Not yet built:

* undo and redo. The document model already returns a new document per edit
  rather than mutating, so this is a stack of previous instances, not a replay
  of inverse operations;
* text search;
* the converters. `PDF → Word` is the hard one and will never be perfect in a
  browser; the other nine are tractable.

Known limits, stated plainly rather than hidden:

* **Edit text** covers the old words and types new ones over them. Rewriting a
  compressed content stream in the browser is a different project; the visible
  result is the same and the export flattens the page, so nothing survives
  underneath.
* Standard PDF fonts only, which means Latin text. Cyrillic needs an embedded
  font and that is the next thing to add.
