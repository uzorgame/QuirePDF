import {PDFDocument} from 'pdf-lib';
import {QuireDoc, UNWRITABLE} from './core/document';
import {templateById, type Template} from './core/templates';
import {buildForm} from './core/formDocs';
import {specFor} from './core/formSpecs';
import {takeHandoff} from './core/handoff';
import {Viewer} from './ui/viewer';
import {Thumbs} from './ui/thumbs';
import {Overlay, type ToolSettings} from './ui/overlay';
import {Inspector} from './ui/inspector';
import {FieldLayer} from './ui/fields';
import {FieldStore} from './core/fieldValues';
import {AnnotStore, nextId, rectOf, type Annot, type ToolId} from './core/annots';
import {SignatureDialog} from './ui/signature';
import {burn, burnFlat} from './core/burn';
import {History, cloneAnnots, type Snapshot} from './core/history';
import {StartDialog} from './ui/startDialog';
import {Finder, FindLayer, type Hit} from './ui/find';
import {wireModals, anyModalOpen} from './ui/modals';
import {TextLayer, rectsIn, paintSelection} from './ui/textLayer';
import {BlockLayer, resetBlockEdits} from './ui/blockLayer';
import {resetDocFonts, docFace} from './core/docFonts';
import {getBlocks} from './core/blocks';
import {isBold as fontBold, isItalic as fontItalic} from './core/annots';
import {restyledFace, type StyleChange} from './ui/inspector';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
};

const stage = $('stage');
const column = $('pages');
const viewer = new Viewer(stage, column);
const thumbs = new Thumbs($('thumbs'), $('thumbCount'));
const start = new StartDialog($('ovlStart'), $('tplGrid'));

let doc: QuireDoc | null = null;
let dirty = false;

/* ── status ─────────────────────────────────────────── */

function toast(message: string): void {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('on');
  window.clearTimeout(Number(el.dataset['t'] ?? 0));
  el.dataset['t'] = String(window.setTimeout(() => el.classList.remove('on'), 2600));
}

function busy(on: boolean, label = 'Working…'): void {
  const el = $('busy');
  el.querySelector('span')!.textContent = label;
  el.classList.toggle('on', on);
}

const kb = (bytes: number): string =>
  bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function refreshMeta(): Promise<void> {
  if (!doc) return;
  $('fileName').textContent = doc.name;
  $('fileMeta').textContent = `${doc.pageCount} page${doc.pageCount === 1 ? '' : 's'} · ${kb(doc.size)}`;
  $('metaPages').textContent = String(doc.pageCount);
  $('metaSize').textContent = kb(doc.size);

  /* The first page's faces feed the font menu without waiting for Edit text
     to be switched on. Fire-and-forget: the menu refreshes when it lands. */
  void doc.page(1)
    .then(p1 => getBlocks(p1, 1))
    .then(() => inspector.refreshFonts())
    .catch(() => { /* a page whose text cannot be read still has a menu */ });

  const page = await doc.page(viewer.currentPage);
  /* `view` is the crop box as [x0, y0, x1, y1] — corners, not a size. Reading
     the last two as width and height happens to be right only while the origin
     is at zero, which it stops being the moment anything is cropped. */
  const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = page.view as number[];
  const mm = (pt: number) => Math.round(pt * 0.352778);
  $('metaPageSize').textContent = `${mm(x1 - x0)}×${mm(y1 - y0)} mm`;
  $('metaRotation').textContent = `${page.rotate}°`;
}

/* ── loading ──────────────────────────────────────────
   Opening anything is a clean slate. The marks belong to the document that was
   open, not to the editor, and carrying them across meant a freshly opened file
   arrived wearing the previous one's stamps — with page numbers that no longer
   pointed anywhere sensible. The history goes with them: undoing into a
   document that is no longer loaded is not a useful offer. */
function resetSession(): void {
  docStamp++;
  revisions.clear();
  resetBlockEdits();
  resetDocFonts();
  finder.reset();
  hits = [];
  hitAt = -1;
  annots.clear();
  fields.clear();
  history.clear();
  selected = null;
  inspector.show(tool, false);
}


async function show(next: QuireDoc, {keepScale = false} = {}): Promise<void> {
  const previous = doc;
  doc = next;
  await viewer.setDocument(next, {keepScale});
  await thumbs.setDocument(next);
  thumbs.select(viewer.currentPage);
  thumbs.reveal(viewer.currentPage);
  await refreshMeta();
  await previous?.destroy();
}

function openFile(file: File): Promise<unknown> {
  return serial(() => openFileNow(file));
}

async function openFileNow(file: File): Promise<void> {
  if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
    toast('That is not a PDF file.');
    return;
  }
  busy(true, `Opening ${file.name}…`);
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    resetSession();
    await show(await QuireDoc.open(bytes, file.name));
    dirty = false;
    $('docBadge').textContent = 'Opened locally';
  } catch (err) {
    toast(err instanceof Error && /password/i.test(err.message)
      ? 'That PDF is password protected.'
      : 'That file could not be opened as a PDF.');
  } finally {
    busy(false);
  }
}

function openTemplate(t: Template): Promise<unknown> {
  return serial(() => openTemplateNow(t));
}

async function openTemplateNow(t: Template): Promise<void> {
  busy(true, `Creating ${t.name.toLowerCase()}…`);
  try {
    resetSession();
    await show(await QuireDoc.fromBuilder(d => t.build(d as PDFDocument), `${t.id}.pdf`));
    dirty = false;
    $('docBadge').textContent = 'New document';
  } finally {
    busy(false);
  }
}

/* ── one thing at a time ────────────────────────────────
   Every structural edit rebuilds the document from bytes, which takes long
   enough that a person mashing Ctrl+Z starts the second undo before the first
   has finished. Both then snapshot the same state and the history diverges from
   the document. Serialising through one chain makes that impossible: operations
   queue instead of racing, and the order you asked for is the order you get. */
let chain: Promise<unknown> = Promise.resolve();
let queued = 0;

function serial<T>(fn: () => Promise<T>): Promise<T | undefined> {
  /* A short queue is normal impatience; a long one means the user is holding a
     key down and would only be surprised by what came out the far end. */
  if (queued > 8) return Promise.resolve(undefined);
  queued++;
  const next = chain.then(fn, fn).finally(() => { queued--; });
  chain = next.catch(() => {});
  return next;
}

/* A form from the library. Same shape as a template — a builder that produces
   real bytes — except the fields it lays down are AcroForm widgets, so the file
   stays fillable in any reader after you download it. */
function openForm(slug: string): Promise<unknown> {
  return serial(async () => {
    const spec = specFor(slug);

    /* Two kinds of form reach here. A template is generated from a description
       on the spot. An official one is a real government PDF sitting next to the
       site, fetched same-origin — no CORS to negotiate and no server to ask. */
    if (!spec) {
      busy(true, 'Opening the form…');
      try {
        /* Ordinary caching, not `force-cache`. These are government forms that
           get revised, and force-cache means a browser that once saw this URL
           never asks again — including the browser that saw it on the day the
           file happened to be broken. Normal revalidation is a request cheap
           enough to be worth always being right. */
        const res = await fetch(`./forms/files/${slug}.pdf`);
        if (!res.ok) { toast('That form is not in the library.'); return; }
        resetSession();
        const bytes = new Uint8Array(await res.arrayBuffer());
        await show(await QuireDoc.open(bytes, `${slug}.pdf`));
        dirty = false;
        $('docBadge').textContent = 'Official form';
        toast('Fill it in, sign it, then export. Nothing is uploaded.');
      } catch {
        toast('That form could not be opened.');
      } finally {
        busy(false);
      }
      return;
    }
    busy(true, `Building the ${spec.title.toLowerCase()}…`);
    try {
      resetSession();
      await show(await QuireDoc.fromBuilder(d => buildForm(d as PDFDocument, spec), `${slug}.pdf`));
      dirty = false;
      $('docBadge').textContent = 'Fillable form';
      toast('Click a field and type. Use Sign for the signature lines.');
    } finally {
      busy(false);
    }
  });
}

/* ── structural edits ───────────────────────────────── */

function apply(
  label: string,
  fn: (d: QuireDoc) => Promise<QuireDoc>,
  remap?: (page: number) => number | null,
  skipHistory = false,
): Promise<unknown> {
  return serial(() => applyNow(label, fn, remap, skipHistory));
}

async function applyNow(
  label: string,
  fn: (d: QuireDoc) => Promise<QuireDoc>,
  remap?: (page: number) => number | null,
  skipHistory = false,
): Promise<void> {
  if (!doc) return;
  /* Checked before anything is recorded rather than caught after. Every one of
     these goes through pdf-lib, so on a form it cannot parse they all fail —
     and a history entry for an edit that never happened turns the next Ctrl+Z
     into a keystroke that visibly does nothing. */
  busy(true, label);
  if (!await doc.canWrite()) { busy(false); toast(UNWRITABLE); return; }
  try {
    if (!skipHistory) record(label.replace(/…$/, '').toLowerCase());
    const next = await fn(doc);
    if (remap) annots.remap(remap);
    /* A new revision of the file, so snapshots taken from here on are not
       interchangeable with the ones before it. */
    docStamp++;
    await show(next, {keepScale: true});
    dirty = true;
  } catch (err) {
    toast(err instanceof Error ? err.message : 'That did not work.');
  } finally {
    busy(false);
  }
}

/* ── wiring ─────────────────────────────────────────── */

viewer.attachScroll();
viewer.onPageChange((page, total) => {
  $('pageNum').textContent = String(page);
  $('pageTotal').textContent = String(total);
  $('zoomLevel').textContent = `${viewer.zoomPercent}%`;
  thumbs.select(page);
  void refreshMeta();
});

/* The rail tracks the document continuously rather than being nudged once per
   page. Clicking a thumbnail is the one case that goes the other way, and
   reveal() is skipped there because the thumbnail you clicked is by definition
   already under your finger. */
viewer.onScroll(f => thumbs.follow(f));

thumbs.onSelect(n => viewer.goTo(n));

start.onSelect(t => void openTemplate(t));

$('pagePrev').onclick = () => { viewer.goTo(viewer.currentPage - 1); thumbs.reveal(viewer.currentPage - 1); };
$('pageNext').onclick = () => { viewer.goTo(viewer.currentPage + 1); thumbs.reveal(viewer.currentPage + 1); };
$('zoomOut').onclick = () => viewer.zoomBy(1 / 1.25);
$('zoomIn').onclick = () => viewer.zoomBy(1.25);
$('zoomLevel').onclick = () => viewer.fitWidth();

$('openBtn').onclick = () => $('fileInput').click();
$('openFromStart').onclick = () => { start.close(); $('fileInput').click(); };

/* The page controls in the right panel are the same three operations as the
   toolbar, put where the page metadata already is. */
$('actRotate').onclick = () => WIRED['Rotate']!();
$('actInsert').onclick = () => WIRED['Pages']!();
$('actDelete').onclick = () => WIRED['Delete']!();
$('actMoveUp').onclick = () => {
  const n = viewer.currentPage;
  if (n <= 1) { toast('Already the first page.'); return; }
  void apply('Moving page…', d => d.movePage(n, n - 1));
};
($('fileInput') as HTMLInputElement).onchange = e => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) void openFile(f);
};

/* Dropping onto the stage is how people actually open the second document. */
for (const ev of ['dragenter', 'dragover'] as const) {
  stage.addEventListener(ev, e => { e.preventDefault(); stage.classList.add('over'); });
}
for (const ev of ['dragleave', 'drop'] as const) {
  stage.addEventListener(ev, e => { e.preventDefault(); stage.classList.remove('over'); });
}
stage.addEventListener('drop', e => {
  const f = e.dataTransfer?.files[0];
  if (f) void openFile(f);
});

/* The toolbar shows names; the model uses ids. One map, declared once. */
const TOOL_OF: Record<string, ToolId> = {
  'Select': 'select', 'Add text': 'text', 'Edit text': 'edit-text', 'Draw': 'draw',
  'Eraser': 'eraser', 'Highlight': 'highlight', 'Shapes': 'shape', 'Image': 'image',
  'Link': 'link', 'Sign': 'sign', 'Stamp': 'stamp', 'Redact': 'redact',
  'Fields': 'field', 'Crop': 'crop',
};

/* ── annotations ────────────────────────────────────────
   The store is the model, the overlays are its view, and the writer in burn.ts
   is the only thing that turns it into a file. Page numbers are remapped
   whenever pages move, because an annotation pinned to a number that now means
   a different page is worse than one that was deleted. */
const annots = new AnnotStore();
const settings: ToolSettings = {
  color: '#111111', width: 2, fontSize: 14, font: 'helvetica',
  shape: 'rect', filled: false, highlightColor: '#fde047',
  stampLabel: 'APPROVED', fieldType: 'text',
};

let tool: ToolId = 'select';
let selected: string | null = null;

/* How wide a placed signature is, in page points. Kept here rather than in the
   settings blob because the ghost, the placement and the slider all read it. */
let sigWidth = 170;

/* Where a change from the panel lands. The panel already updated the defaults;
   with a mark selected the same gesture restyles the mark — the only reading
   under which "pick red with a mark selected" does what it looks like it does. */
const STD_VARIANT: Record<string, Record<string, ToolId | string>> = {
  helvetica: {'': 'helvetica', b: 'helvetica-bold', i: 'helvetica-oblique', bi: 'helvetica-boldoblique'},
  times: {'': 'times', b: 'times-bold', i: 'times-italic', bi: 'times-bolditalic'},
  courier: {'': 'courier', b: 'courier-bold', i: 'courier-oblique', bi: 'courier-boldoblique'},
};

function stdVariant(font: string, bold: boolean, italic: boolean): string {
  const family = font.startsWith('times') ? 'times' : font.startsWith('courier') ? 'courier' : 'helvetica';
  return String(STD_VARIANT[family]![(bold ? 'b' : '') + (italic ? 'i' : '')] ?? font);
}

function restyleSelected(change: StyleChange): void {
  if (!selected) return;
  const an = annots.find(selected);
  if (!an) return;

  record('restyling a mark');
  if (change.color && 'color' in an) an.color = change.color;
  if ((an.kind === 'ink' || an.kind === 'shape') && change.width) an.width = change.width;

  if (an.kind === 'text') {
    if (change.size) an.size = change.size;
    if (change.font) { an.font = change.font; }
    if (change.face !== undefined) an.face = change.face ?? undefined;
    if (change.bold !== undefined || change.italic !== undefined) {
      const bold = change.bold ?? (an.face ? /bold|semib|black|heavy/i.test(an.face) : fontBold(an.font));
      const italic = change.italic ?? (an.face ? /italic|oblique/i.test(an.face) : fontItalic(an.font));
      if (an.face) {
        /* The honest bold of a document face is its bold sibling, when the
           document carries one. When it does not, the standard family's bold
           is the only real option — synthesising weight in a PDF is not one. */
        const sibling = restyledFace(an.face, bold, italic);
        if (sibling) an.face = sibling;
        else { an.face = undefined; an.font = stdVariant(an.font, bold, italic) as typeof an.font; }
      } else {
        an.font = stdVariant(an.font, bold, italic) as typeof an.font;
      }
    }
  }

  dirty = true;
  annots.touch(an.id);

  /* Focus goes back where the typing was. Clicking a dropdown steals it, and
     without this the next keystroke after a font change fell on the floor. */
  const box = document.querySelector<HTMLElement>(`[data-text="${an.id}"]`);
  if (box?.isContentEditable) box.focus({preventScroll: true});
}

function reflectSelection(): void {
  const an = selected ? annots.find(selected) : null;
  inspector.reflect({
    mixedFont: false,
    color: (an && 'color' in an ? an.color : undefined) ?? settings.color,
    size: (an?.kind === 'text' ? an.size : undefined) ?? settings.fontSize,
    font: (an?.kind === 'text' ? an.font : undefined) ?? settings.font,
    face: an?.kind === 'text' ? an.face ?? null : null,
  });
}

const inspector = new Inspector(settings, change => {
  /* An open paragraph takes the change first: inside Edit text the panel is
     describing the words under the caret, not some other mark on the page.
     Only when nothing is open does it fall through to the selected mark. */
  if (viewer.styleInBlock(change)) { dirty = true; return; }
  restyleSelected(change);
  viewer.repaintOverlays();
});

annots.onChange(pages => {
  viewer.repaintOverlays(pages);
  $('metaMarks').textContent = String(annots.count);
});

viewer.overlays = {
  create: (page, w, h) => new Overlay(page, annots, w, h, {
    tool: () => tool,
    settings: () => settings,
    scale: () => viewer.scale,
    selected: () => selected,
    select: id => {
      selected = id;
      inspector.show(tool, !!id, id ? annots.find(id) : null);
      reflectSelection();
    },
    beforeEdit: label => record(label),
    afterEdit: () => {
      dirty = true;
      $('metaMarks').textContent = String(annots.count);
    },
    requestImage: pickImage,
    requestSignature: () => {
      const saved = SignatureDialog.saved();
      if (saved) return Promise.resolve(saved);
      signature.open();
      return Promise.resolve(null);
    },
    signatureNow: () => SignatureDialog.saved(),
    signatureWidth: () => sigWidth,
    keepPlacing: () => ($('sigKeep') as HTMLInputElement).checked,
    /* Placed and handed straight over: the common case is one signature you then
       nudge into place, so Select takes over with it already chosen. Ticking
       "keep placing" is for the other case — fifty pages, scroll and click. */
    placed: id => {
      /* "Place several" belongs to the signature; a picture is placed once and
         wants to be picked up immediately. */
      const an = annots.find(id);
      const keep = an?.kind === 'image' && an.variant === 'sign'
        && ($('sigKeep') as HTMLInputElement).checked;
      if (keep) return;
      setTool('select');
      selected = id;
      inspector.show('select', true);
      viewer.repaintOverlays();
    },
    requestLink: () => Promise.resolve(window.prompt('Link address', 'https://')),
    cropReady: () => { /* the Apply button in the panel is the confirmation */ },
  }),
};

/* ── signature ──────────────────────────────────────────
   Made once, then placed. The dialog only appears when there is nothing saved
   yet, or when you ask to change it. */
const signature = new SignatureDialog($('ovlSign'));
signature.onPlace(() => {
  setTool('sign');
  toast('Now click the page where the signature should go.');
});
$('sigEdit').onclick = () => signature.open();
($('sigSize') as HTMLInputElement).addEventListener('input', e => {
  sigWidth = Number((e.target as HTMLInputElement).value);
  viewer.repaintOverlays();
});

/* ── crop ───────────────────────────────────────────────
   The box is a proposal until it is applied, so a mis-drag costs a click rather
   than a resized page. */
function cropRegion() {
  return annots.all.find(a => a.kind === 'region' && a.variant === 'crop') ?? null;
}

$('cropApply').onclick = () => {
  const region = cropRegion();
  if (!region || region.kind !== 'region') { toast('Drag out the area to keep first.'); return; }
  const r = rectOf(region.a, region.b);
  const page = region.page;
  /* The box goes first, then the snapshot. Recording before removing it meant
     undoing a crop brought the proposal back with the page — and a stray crop
     box is not something anyone asked to keep. */
  annots.remove(region.id);
  record('the crop');
  setTool('select');
  void apply('Cropping…', d => d.crop(page, r), undefined, true);
};

$('cropCancel').onclick = () => {
  const region = cropRegion();
  if (region) annots.remove(region.id);
  setTool('select');
};

/** Reads a picture off disk as a data URL. Never leaves the page. */
function pickImage(): Promise<string | null> {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg';
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) { resolve(null); return; }
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(f);
    };
    input.click();
  });
}

function setTool(next: ToolId): void {
  const was = tool;
  /* An un-applied crop box belongs to the crop mode. Leaving it behind when you
     move to another tool leaves a green rectangle nobody can explain. */
  if (tool === 'crop' && next !== 'crop') {
    const stale = cropRegion();
    if (stale) annots.remove(stale.id);
  }
  tool = next;
  if (next !== 'select') { selected = null; }
  for (const b of document.querySelectorAll<HTMLElement>('.tool')) {
    b.setAttribute('aria-pressed', String(TOOL_OF[b.dataset['tip'] ?? ''] === next));
  }
  ($('stage') as HTMLElement).dataset['tool'] = next;
  /* Leaving Edit text writes the open paragraph back. Compared against the tool
     we came from, not the one we just assigned — the test used to be made after
     the assignment, so it was never true and a rewritten paragraph was quietly
     abandoned whenever you picked another tool. */
  if (was !== next) void viewer.closeBlocks(true);
  viewer.repaintBlocks();
  viewer.repaintFields();
  /* The words stop being selectable outside Select, so the layer has to be
     told; otherwise the highlighter would keep selecting instead of drawing. */
  viewer.repaintTexts();
  if (next !== 'select') { window.getSelection()?.removeAllRanges(); $('mk').hidden = true; }
  inspector.show(next, !!selected, selected ? annots.find(selected) : null);
  inspector.refreshFonts();
  reflectSelection();
  viewer.repaintOverlays();
}


/* ── the form's own fields ──────────────────────────────
   Kept apart from the marks: a widget is part of the file, a mark is something
   we drew on top of it. They are also written out differently — one into the
   AcroForm, one onto the page — so mixing them would either flatten a form that
   should stay fillable or leave a filled one looking blank in Acrobat. */
const fields = new FieldStore();

fields.onChange(() => {
  dirty = true;
  $('metaFields').textContent = String(fields.filled);
});

viewer.fields = {
  create: (page, w, h) => new FieldLayer(page, w, h, fields, {
    /* Select and Fields let the pointer reach a form's boxes; the drawing
       tools do not. A highlighter that kept landing in a text box would be
       unusable, and Select is what the editor opens with, so a form is
       typeable the moment it appears. */
    interactive: () => tool === 'select' || tool === 'field',
    scale: () => viewer.scale,
    touched: () => { dirty = true; },
  }),
};

/* ── the paragraph editor ───────────────────────────────
   Edit text no longer asks you to draw a box round the words you mean. The
   page's own paragraphs are found when the tool is switched on and drawn as
   frames; you click the one you want. What comes back is a cover and a set of
   text runs — which is exactly what the writer already knows how to put into a
   file, so nothing new had to be invented for the export path. */
let blockDiscard: ((discard: boolean) => void) | null = null;

const answerDiscard = (discard: boolean): void => {
  const reply = blockDiscard;
  blockDiscard = null;
  $('ovlBlockCf').classList.remove('on');
  reply?.(discard);
};

$('bkDiscard').onclick = () => answerDiscard(true);
$('bkKeep').onclick = () => answerDiscard(false);
/* Dismissing the dialog any other way means "no", not "yes" — the safe reading
   of an ambiguous gesture is the one that keeps the work. */
$('ovlBlockCf').addEventListener('click', e => {
  if (e.target === $('ovlBlockCf') || (e.target as HTMLElement).closest('[data-close]')) {
    answerDiscard(false);
  }
});

viewer.blocks = {
  create: (page, w, h) => new BlockLayer(page, w, h, {
    interactive: () => tool === 'edit-text',
    scale: () => viewer.scale,
    beforeEdit: label => record(label),

    /* What the panel shows while a paragraph is open. Null when it closes, so
       the panel goes back to describing whatever mark is selected instead. */
    report: style => {
      if (!style) { inspector.show(tool, !!selected, selected ? annots.find(selected) : null); reflectSelection(); return; }
      inspector.show('edit-text', true);
      inspector.reflect({
        color: style.color,
        size: style.size,
        font: style.font,
        face: style.face,
        mixedFont: style.mixedFont,
        bold: style.bold,
        italic: style.italic,
        track: style.track,
      });
    },

    sibling: (face, bold, italic) => restyledFace(face, bold, italic),

    confirmDiscard: () => new Promise<boolean>(resolve => {
      blockDiscard = resolve;
      $('ovlBlockCf').classList.add('on');
    }),

    drop: ids => { for (const id of ids) annots.remove(id); $('metaMarks').textContent = String(annots.count); },

    commit: (pageNo, cover, bg, runs) => {
      const made: string[] = [];
      if (!runs.length) return made;
      /* One annotation per piece of styled text, placed where the editor laid
         it out. Per run rather than per block, because a single-font box is
         what used to lose the bold lead-in of a bullet. */
      let first = true;
      for (const r of runs) {
        const id = nextId();
        made.push(id);
        annots.add({
          id, page: pageNo, kind: 'text',
          /* Only names the registry can actually embed reach the annotation —
             a face with no bytes would dress the screen in a font the export
             cannot honour. */
          ...(r.face && docFace(r.face)?.bytes ? {face: r.face} : {}),
          at: {x: r.at.x, y: r.at.y},
          /* The line breaks were decided on screen, in the document's own face.
             This is a record of them, not a request to lay the paragraph out
             again — so the run says so, and the width is only what the frame
             and the handles are drawn at. */
          nowrap: true,
          ...(r.tracking ? {tracking: r.tracking} : {}),
          /* Where the baseline was and how wide the words were, both measured
             on screen. The writer used to guess at both. */
          ...(r.lead ? {lead: r.lead} : {}),
          ...(r.ink ? {ink: r.ink} : {}),
          w: Math.max(cover.w, 20),
          text: r.text, size: r.size, color: r.color, font: r.font,
          /* The cover rides on the first run so it is painted before any of the
             new words, and only once however many runs there are. */
          ...(first ? {
            cover: {a: {x: cover.x, y: cover.y}, b: {x: cover.x + cover.w, y: cover.y + cover.h}},
            coverColor: bg,
          } : {}),
        });
        first = false;
      }
      dirty = true;
      $('metaMarks').textContent = String(annots.count);
      toast('Paragraph rewritten. It goes into the file when you export.');
      return made;
    },
  }),
};

/* ── selecting words, and marking them ──────────────────
   Until now the page was a picture: dragging across it selected nothing, and
   the only way to strike a line through a sentence was to draw one by hand and
   hope it landed. The text layer puts an invisible, selectable copy of every
   run over the canvas, and this turns whatever you select into a real mark. */
viewer.texts = {
  create: (page, w, h) => new TextLayer(page, w, h, {
    /* Only under Select. Every other tool wants the drag for itself, and a
       highlighter that selected text instead of drawing would be broken. */
    interactive: () => tool === 'select',
    scale: () => viewer.scale,
  }),
};

const markBar = $('mk');
const MARKS = ['highlight', 'strike', 'underline', 'squiggle'] as const;
type MarkVariant = typeof MARKS[number];

function liveSelection(): {range: Range; text: string} | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const text = sel.toString().trim();
  if (!text) return null;
  const range = sel.getRangeAt(0);
  /* A selection somewhere else — the sidebar, the footer, a dialog — is not
     ours to mark. Both ends are tested rather than the common ancestor,
     because a passage dragged from one page onto the next has the whole column
     as its ancestor and would otherwise look like it belonged to nothing. */
  const onPage = (n: Node | null): boolean => {
    const el = n instanceof Element ? n : n?.parentElement ?? null;
    return !!el?.closest('.tl');
  };
  if (!onPage(range.startContainer) && !onPage(range.endContainer)) return null;
  return {range, text};
}

function hideMarkBar(): void {
  markBar.hidden = true;
}

/* Placed against the selection rather than in the toolbar, because the toolbar
   is at the other end of the window from the words you just chose. Above by
   preference, below when the selection starts near the top of the stage. */
function showMarkBar(range: Range): void {
  /* Never over a dialog: the backdrop is there to say that nothing behind it
     is in play, and a toolbar floating on top of it says the opposite. */
  if (anyModalOpen()) { hideMarkBar(); return; }
  const r = range.getBoundingClientRect();
  if (!r.width && !r.height) { hideMarkBar(); return; }

  /* A selection scrolled out of view takes its bar with it. Without this the
     bar clamped itself to the stage edge and sat there over the toolbar,
     attached to words nobody could see. */
  const view = stage.getBoundingClientRect();
  if (r.bottom < view.top || r.top > view.bottom) { hideMarkBar(); return; }

  markBar.hidden = false;
  const bar = markBar.getBoundingClientRect();
  const gap = 10;
  const ceiling = view.top + 8;
  let top = r.top - bar.height - gap;
  markBar.classList.toggle('mk--under', top < ceiling);
  if (top < ceiling) top = Math.max(r.bottom + gap, ceiling);

  const half = bar.width / 2;
  const x = Math.min(
    Math.max(r.left + r.width / 2, half + 12),
    window.innerWidth - half - 12,
  );
  markBar.style.left = `${x - half}px`;
  markBar.style.top = `${top}px`;
}

type MRect = {x: number; y: number; w: number; h: number};

/* Where the selection falls, page by page, in page points. One pass, used for
   three things at once: drawing the band, deciding which buttons are already
   on, and building the mark itself. */
function selectionRects(range: Range): Array<{page: number; root: HTMLElement; size: {w: number; h: number}; rects: MRect[]}> {
  const out: Array<{page: number; root: HTMLElement; size: {w: number; h: number}; rects: MRect[]}> = [];
  for (const root of viewer.textLayers()) {
    const page = Number(root.dataset['page']);
    const size = viewer.pointSize(page);
    if (!size) continue;
    out.push({page, root, size, rects: rectsIn(root, size.w, size.h, range)});
  }
  return out;
}

/* How much of `a` lies under `b`. Both are one-rectangle-per-line, so the
   rectangles within each list never overlap and the sum is a true area. */
function covered(a: MRect[], b: MRect[]): number {
  const total = a.reduce((n, r) => n + r.w * r.h, 0);
  if (total <= 0) return 0;
  let shared = 0;
  for (const p of a) {
    for (const q of b) {
      const w = Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x);
      const h = Math.min(p.y + p.h, q.y + q.h) - Math.max(p.y, q.y);
      if (w > 0 && h > 0) shared += w * h;
    }
  }
  return shared / total;
}

/* Marks of one kind already lying on the selected words. Two ways to count as
   the same passage: the existing mark covers most of what is selected, or what
   is selected swallows most of the existing mark. The first is "you highlighted
   this line again"; the second is "you highlighted the whole paragraph that
   line was in". Both should end with one mark or none, never two stacked. */
function marksOn(page: number, variant: string, rects: MRect[]): string[] {
  if (!rects.length) return [];
  return annots.byPage(page)
    .filter(a => a.kind === 'mark' && a.variant === variant)
    .filter(a => {
      const theirs = (a as Extract<Annot, {kind: 'mark'}>).rects;
      return covered(rects, theirs) >= 0.6 || covered(theirs, rects) >= 0.6;
    })
    .map(a => a.id);
}

/* Live band under the cursor. selectionchange fires on every pixel of a drag,
   so the work is deferred to the next frame — one repaint per frame rather than
   one per event, which on a dense page is the difference between smooth and
   not. */
let painting = 0;
function repaintSelection(): void {
  if (painting) return;
  painting = requestAnimationFrame(() => {
    painting = 0;
    const live = liveSelection();
    const found = live ? selectionRects(live.range) : [];
    for (const root of viewer.textLayers()) {
      const here = found.find(f => f.root === root);
      paintSelection(root, here?.rects ?? [], here?.size.w ?? 1, here?.size.h ?? 1);
    }
    /* A button that is lit says "this is already on, pressing me takes it off",
       which is the only thing that makes the toggle findable. */
    for (const b of markBar.querySelectorAll<HTMLElement>('.mk-b')) {
      const what = b.dataset['mark'] ?? '';
      const on = (MARKS as readonly string[]).includes(what)
        && found.some(f => marksOn(f.page, what, f.rects).length > 0);
      b.classList.toggle('mk-b--on', on);
      b.setAttribute('aria-pressed', String(on));
    }

    /* The bar is part of the same picture: shown while there is a live
       selection under the Select tool, positioned at it, gone otherwise. One
       place decides, so it can never again be stranded on screen after the
       selection it belonged to has gone. */
    if (live && tool === 'select') showMarkBar(live.range);
    else hideMarkBar();
  });
}

document.addEventListener('selectionchange', repaintSelection);

/* 'strike' is the id; 'strikethrough' is the word. */
const label = (v: MarkVariant): string => (v === 'strike' ? 'strikethrough' : v);

function markSelection(variant: MarkVariant): void {
  const live = liveSelection();
  if (!live) return;

  const colour = variant === 'highlight' ? settings.highlightColor : settings.color;

  /* Worked out in full before anything is added. Every page the selection
     touches gets its own annotation, so a passage running over a page break is
     marked on both halves — and if it turns out to touch none of them, nothing
     has been changed and there is no undo step to explain. */
  const work = selectionRects(live.range).filter(w => w.rects.length);
  if (!work.length) { toast('Select some text on the page first.'); return; }

  /* The same button on the same words is a switch, not a stamp.
   *
   * Pressing Underline twice used to draw two lines a hair apart, and the only
   * way back was Undo — so a marker you pressed by mistake was easier to leave
   * than to remove. Now the second press takes the first one off. */
  const existing = work.map(w => marksOn(w.page, variant, w.rects));
  if (existing.some(ids => ids.length)) {
    record(`the ${label(variant)}`);
    for (const ids of existing) for (const id of ids) annots.remove(id);
    dirty = true;
    window.getSelection()?.removeAllRanges();
    hideMarkBar();
    return;
  }

  /* Before the change, not after it: the history holds the state an undo goes
     back to, so a snapshot taken afterwards would undo to the marked page. */
  record(`the ${label(variant)}`);
  for (const w of work) {
    annots.add({id: nextId(), page: w.page, kind: 'mark', variant, rects: w.rects, color: colour});
  }
  dirty = true;
  window.getSelection()?.removeAllRanges();
  hideMarkBar();
}

for (const b of markBar.querySelectorAll<HTMLElement>('.mk-b')) {
  const what = b.dataset['mark'] ?? '';
  /* pointerdown, not click: by the time click fires the browser has already
     dropped the selection to focus the button. */
  b.addEventListener('pointerdown', e => {
    e.preventDefault();
    if (what === 'copy') {
      const live = liveSelection();
      if (!live) return;
      void navigator.clipboard.writeText(live.text)
        .then(() => toast('Copied.'))
        .catch(() => toast('The browser would not let us reach the clipboard.'));
      hideMarkBar();
      return;
    }
    if ((MARKS as readonly string[]).includes(what)) markSelection(what as MarkVariant);
  });
}

/* The bar lives and dies with the selection itself, on selectionchange —
   which is the one event that cannot miss a way of selecting or deselecting.
   The pointerup/keyup pair it replaces missed enough of them that the bar
   could be orphaned on screen with nothing selected under it. It follows the
   words on scroll rather than hiding, because the selection is still there
   and a control for it should be too. */
viewer.onScroll(() => repaintSelection());

$('deleteSel').onclick = () => {
  if (!selected) return;
  /* Recorded first. Deleting a mark was the one edit in the editor that could
     not be taken back — Ctrl+Z simply stepped over it to whatever came before,
     which is worse than no undo at all because the stack looks like it worked. */
  record('deleting a mark');
  annots.remove(selected);
  selected = null;
  inspector.show(tool, false);
  viewer.repaintOverlays();
};

addEventListener('keydown', e => {
  if ((e.key === 'Delete' || e.key === 'Backspace') && selected
      && !(e.target as HTMLElement).isContentEditable) {
    e.preventDefault();
    record('deleting a mark');
    annots.remove(selected);
    selected = null;
    inspector.show(tool, false);
  }
  /* A dialog on screen owns Escape, and so does an open paragraph. Dismissing
     one and also throwing away the tool the user had chosen is two things for
     one keypress — and switching tools commits the paragraph, so a key pressed
     to abandon a half-finished move was writing that move into the page. */
  if (e.key === 'Escape' && !anyModalOpen() && !viewer.blockOpen) { selected = null; setTool('select'); }
});

/* ── history ────────────────────────────────────────────
   Every mutation records the state it is about to replace. Because a
   structural edit already produces a whole new file rather than mutating one,
   undo is a stack of past states rather than a log of inverse operations —
   which is how cropping, rotating and deleting a page all became undoable
   without any of them knowing that undo exists. */
const history = new History();

/* Which revision of the file is on screen. Bumped only where the bytes are
   actually rewritten, which is the one place it can happen — see applyNow. */
let docStamp = 0;

/* One copy of the file per revision, shared by every snapshot taken while that
   revision is on screen. `doc.raw` hands back a fresh copy each time it is
   asked, so calling it per action meant a hundred edits held a hundred copies
   of the document — which is why the history was capped at twenty steps. Only
   rotating, cropping and page moves make a new revision, and only those need a
   new copy. */
const revisions = new Map<number, Uint8Array>();

const bytesFor = (stamp: number): Uint8Array => {
  let bytes = revisions.get(stamp);
  if (!bytes) { bytes = doc!.raw; revisions.set(stamp, bytes); }
  return bytes;
};

const snapshot = (label: string): Snapshot =>
  ({bytes: bytesFor(docStamp), annots: cloneAnnots(annots.all), label, stamp: docStamp});

function record(label: string): void {
  if (doc) history.push(snapshot(label));
}

async function restore(snap: Snapshot): Promise<void> {
  annots.load(snap.annots);
  selected = null;
  inspector.show(tool, false);

  /* The overlay is the whole of the change in almost every case, so almost
     every undo is a repaint. Reopening the file to put a highlight back was
     tearing down six rendered pages, four layers each, and rebuilding them from
     bytes — a second of blank paper for something that never left the DOM. */
  if (snap.stamp === docStamp) {
    viewer.repaintOverlays();
    $('metaMarks').textContent = String(annots.count);
    return;
  }

  const name = doc?.name ?? 'document.pdf';
  await show(await QuireDoc.open(snap.bytes, name), {keepScale: true});
  /* The rebuilt document is that revision of the file, not a new one — so
     stepping back to it a second time takes the cheap path. */
  docStamp = snap.stamp;
}

function step(dir: 'undo' | 'redo'): Promise<unknown> {
  return serial(() => stepNow(dir));
}

async function stepNow(dir: 'undo' | 'redo'): Promise<void> {
  if (!doc) return;
  const current = snapshot('');
  const target = dir === 'undo' ? history.undo(current) : history.redo(current);
  if (!target) return;
  /* Only announced as work when it is work. Flashing a modal spinner for a
     repaint that finishes in the same frame reads as the editor stalling. */
  const heavy = target.stamp !== docStamp;
  if (heavy) busy(true, dir === 'undo' ? 'Undoing…' : 'Redoing…');
  try {
    await restore(target);
    if (target.label) toast(`${dir === 'undo' ? 'Undid' : 'Redid'} ${target.label}.`);
  } finally {
    if (heavy) busy(false);
  }
}

history.onChange(() => {
  const u = document.querySelector<HTMLButtonElement>('.tool[data-tip="Undo"]');
  const r = document.querySelector<HTMLButtonElement>('.tool[data-tip="Redo"]');
  if (u) u.disabled = !history.canUndo;
  if (r) r.disabled = !history.canRedo;
});

addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const k = e.key.toLowerCase();
  if (k === 'f') { e.preventDefault(); openFind(); return; }
  if (k === 'z' && !e.shiftKey) { e.preventDefault(); void step('undo'); }
  else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); void step('redo'); }
});

/* ── toolbar ────────────────────────────────────────── */

/* Structural edits move page numbers under the annotations, so each one says
   how its own page numbering changed and the store follows. */
const WIRED: Record<string, () => void> = {
  /* The keyboard has always undone; the two buttons that say so had nothing
     behind them and fell through to the "not wired up yet" message. Which is
     the worst kind of gap — the feature works, and the control for it does
     not, so anyone who does not know the shortcut concludes it is missing. */
  Search: () => openFind(),
  /* An open paragraph owns Undo, exactly as Ctrl+Z does. Two buttons for the
     same idea that disagree about what they undo is worse than one. */
  Undo: () => { if (!viewer.undoInBlock()) void step('undo'); },
  Redo: () => void step('redo'),
  Rotate: () => void apply('Rotating…', d => d.rotatePage(viewer.currentPage, 90)),
  Delete: () => {
    const n = viewer.currentPage;
    void apply('Removing page…', d => d.deletePage(n),
      p => p === n ? null : p > n ? p - 1 : p);
  },
  Pages: () => {
    const n = viewer.currentPage;
    void apply('Inserting page…', d => d.insertBlankAfter(n), p => p > n ? p + 1 : p);
  },
};

$('bar').addEventListener('click', e => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('.tool');
  if (!btn) return;
  const name = btn.dataset['tip'] ?? '';

  /* Two kinds of button share this bar. Rotate, Delete and Pages act on the
     file immediately and go back to whatever tool you had; the rest put the
     editor into a mode. Treating them alike would leave Rotate looking armed
     after it had already fired. */
  const act = WIRED[name];
  if (act) { act(); return; }

  const next = TOOL_OF[name];
  if (next) { setTool(next); return; }

  toast(`${name} is designed but not wired up yet.`);
});


/* ── find ───────────────────────────────────────────── */

const finder = new Finder();
let hits: Hit[] = [];
let hitAt = -1;

viewer.finds = {
  create: (page, w, h) => new FindLayer(page, w, h, {
    hits: () => hits,
    all: () => hits,
    currentIndex: () => hitAt,
  }),
};

function paintHits(): void {
  const typed = ($('findQ') as HTMLInputElement).value.trim();
  $('findN').textContent = !typed ? ''
    : hits.length ? `${hitAt + 1} of ${hits.length}` : 'no matches';
  ($('findPrev') as HTMLButtonElement).disabled = hits.length < 2;
  ($('findNext') as HTMLButtonElement).disabled = hits.length < 2;
  viewer.repaintFinds();
}

async function runFind(): Promise<void> {
  const q = ($('findQ') as HTMLInputElement).value;
  if (!doc) return;
  await finder.index(doc);
  hits = finder.search(q);
  hitAt = hits.length ? 0 : -1;
  paintHits();
  if (hits.length) revealHit();
}

function revealHit(): void {
  const hit = hits[hitAt];
  if (!hit) return;
  const size = viewer.pointSize(hit.page);
  viewer.goToPoint(hit.page, size ? hit.y / size.h : 0);
  thumbs.select(hit.page);
}

function stepHit(by: number): void {
  if (!hits.length) return;
  hitAt = (hitAt + by + hits.length) % hits.length;
  paintHits();
  revealHit();
}

function openFind(): void {
  ($('find') as HTMLElement).hidden = false;
  const input = $('findQ') as HTMLInputElement;
  input.focus();
  input.select();
  if (input.value) void runFind();
}

function closeFind(): void {
  ($('find') as HTMLElement).hidden = true;
  hits = [];
  hitAt = -1;
  paintHits();
}

/* Debounced, because the index is scanned per keystroke and a fast typist
   would otherwise queue a search per character on a document of ten thousand
   runs. */
let findTimer = 0;
$('findQ').addEventListener('input', () => {
  window.clearTimeout(findTimer);
  findTimer = window.setTimeout(() => void runFind(), 140);
});
$('findQ').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); stepHit(e.shiftKey ? -1 : 1); }
  if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
});
$('findNext').onclick = () => stepHit(1);
$('findPrev').onclick = () => stepHit(-1);
$('findClose').onclick = () => closeFind();

/* ── new / export ───────────────────────────────────── */

/* New opens a blank document and puts the template list in reach, rather than
   dropping you on an empty stage with nothing to do next. */
async function startFresh(): Promise<void> {
  await openTemplate(templateById('blank')!);
  await start.open();
}

/* One modal, one place that decides what its Discard button does.
 *
 * There used to be two: the New button bound `cfDiscard.onclick` at load, and
 * every guarded hashchange bound it again. A property assignment replaces
 * rather than adds, so after the first link had been intercepted, New silently
 * ran the link's stale closure instead of opening a new document — and if the
 * modal was ever dismissed without answering, `pending` stayed set and the next
 * confirmation ran the wrong thing. Now the intent is passed in, stored once,
 * and cleared whichever way the dialog closes. */
let pending: (() => void) | null = null;

/* The second argument finishes the sentence. The same dialog is raised for two
   different departures, and telling someone who clicked the logo that "starting
   a new one discards them" describes something they did not ask to do. */
function askToDiscard(then: () => void, what = 'Starting a new one discards them'): void {
  pending = then;
  $('cfName').textContent = doc?.name ?? 'this document';
  $('cfWhat').textContent = what;
  $('ovlNew').classList.add('on');
}

$('cfDiscard').onclick = () => {
  const go = pending;
  pending = null;
  dirty = false;
  document.querySelectorAll('.ovl.on').forEach(o => o.classList.remove('on'));
  (go ?? (() => void startFresh()))();
};

/* Closing the dialog any other way — the ✕, the backdrop, Escape — abandons
   the intent rather than leaving it armed. */
$('ovlNew').addEventListener('click', e => {
  if (e.target === $('ovlNew') || (e.target as HTMLElement).closest('[data-close]')) pending = null;
});

$('newBtn').onclick = () => {
  if (!dirty) { void startFresh(); return; }
  askToDiscard(() => void startFresh());
};

$('cfExport').onclick = () => {
  $('ovlNew').classList.remove('on');
  $('exportBtn').click();
};

$('exportBtn').onclick = async () => {
  if (!doc) return;
  /* A paragraph still open has not reached the annotation store yet, so an
     export taken over the top of it wrote out the original file and looked like
     the edit had been thrown away. Closing first is the whole fix. */
  await viewer.closeBlocks(true);
  $('exName').textContent = doc.name;
  $('exSize').textContent = kb(doc.size);
  $('exPages').textContent = String(doc.pageCount);
  $('exMarks').textContent = String(annots.count);
  const redacting = annots.all.some(a => a.kind === 'region' && a.variant === 'redact');
  ($('exRedact') as HTMLElement).hidden = !redacting;
  ($('exFlat') as HTMLElement).hidden = true;
  $('ovlExport').classList.add('on');

  /* The dialog opens straight away and the caveat arrives a moment later,
     because working out whether this file can be rewritten means re-saving it.
     Made to wait for that, the button would feel broken on a fourteen-page
     form; the note lands well before anyone has read as far as Download.
     Only worth saying when it will actually happen, too — an untouched form
     comes out as the original bytes, fillable and unchanged. */
  const asked = doc;
  if (!(annots.count || fields.size)) return;
  void asked.canWrite().then(ok => {
    if (doc !== asked) return;   // they moved on; this answer is about a file that is gone
    ($('exFlat') as HTMLElement).hidden = ok;
  });
};

/* The format picker. Three buttons rather than a dropdown, so the choice and
   what it costs you are both on screen at once. */
$('exFormat').addEventListener('click', e => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('.seg-b');
  if (!btn) return;
  $('exFormat').dataset['value'] = btn.dataset['v'] ?? 'pdf';
  for (const b of $('exFormat').querySelectorAll('.seg-b')) {
    b.setAttribute('aria-checked', String(b === btn));
  }
  $('exFormatNote').textContent = btn.dataset['note'] ?? '';
  /* Only a PDF has metadata to strip; for a picture the option is meaningless
     and offering it anyway is a small lie. */
  $('exMetaRow').hidden = btn.dataset['v'] !== 'pdf';
});

$('downloadBtn').onclick = () => void download();

async function download(): Promise<void> {
  if (!doc) return;
  const format = ($('exFormat').dataset['value'] ?? 'pdf') as 'pdf' | 'png' | 'jpg';
  const strip = ($('exStrip') as HTMLInputElement).checked;
  busy(true, annots.count || fields.size ? 'Writing your changes into the file…' : 'Preparing the file…');
  try {
    /* The overlay is a view of the model, never the file. This is the moment
       the two become one thing — and the only moment, which is why what you see
       on screen and what lands in your downloads cannot disagree. */
    const deps = {
      raster: (p: number, s: number, boxes: Array<{x: number; y: number; w: number; h: number}>) =>
        doc!.rasterWithBoxes(p, s, boxes),
    };

    let bytes: Uint8Array;
    if (!(annots.count || fields.size)) {
      /* Nothing was changed, so the file that came in is the best file to hand
         back — still the real form, still fillable, byte for byte. */
      bytes = doc.raw;
    } else {
      try {
        bytes = await burn(doc.raw, annots, deps, fields);
      } catch (err) {
        /* Attempted rather than predicted. A file that cannot be rewritten
           still has to come out filled, and the surest way to know which kind
           this is, is to have tried. */
        if (await doc.canWrite()) throw err;   // a real fault, not this one
        busy(true, 'This form cannot be rewritten — drawing your answers in…');
        bytes = await burnFlat(
          doc.pageCount, await doc.pageSizes(), annots, deps, fields,
          (done, total) => busy(true, `Drawing your answers in — page ${done} of ${total}…`),
        );
      }
    }

    /* Metadata is stripped by default. A PDF carries the producing
       application, the author, and creation and modification dates, and a form
       filled in privately has no reason to name the machine it was filled in
       on. Anyone who wants that kept can untick the box. */
    if (strip && format === 'pdf') bytes = await stripMetadata(bytes);

    let blob: Blob;
    let name = doc.name.replace(/\.pdf$/i, '');
    if (format === 'pdf') {
      blob = doc.toBlob(bytes);
      name += '.pdf';
    } else {
      /* The same engine the converter pages use, loaded only when somebody
         actually asks for a picture. */
      busy(true, 'Rendering the pages…');
      const eng = await import('./convert/heavy');
      const sheets = await eng.pdfToImages(
        bytes, format === 'png' ? 'image/png' : 'image/jpeg', name,
        (done, total) => busy(true, `Rendering — page ${done} of ${total}…`),
      );
      if (sheets.length === 1) { blob = sheets[0]!.blob; name = sheets[0]!.name; }
      else { blob = await eng.zip(sheets); name += '.zip'; }
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);

    document.querySelectorAll('.ovl.on').forEach(o => o.classList.remove('on'));
    dirty = false;
    toast('Saved to your downloads.');
  } catch (err) {
    toast(err instanceof Error ? `Export failed: ${err.message}` : 'Export failed.');
  } finally {
    busy(false);
  }
}

/* Author, title, subject, keywords, producer and both dates, removed.
   Failing here must not fail the export — an unstrippable file is still a file
   worth downloading, and the checkbox is a preference rather than a promise. */
async function stripMetadata(bytes: Uint8Array): Promise<Uint8Array> {
  try {
    const d = await PDFDocument.load(bytes.slice(), {updateMetadata: false});
    d.setTitle(''); d.setAuthor(''); d.setSubject('');
    d.setKeywords([]); d.setProducer(''); d.setCreator('');
    return await d.save();
  } catch {
    return bytes;
  }
}


document.querySelectorAll('[data-close]').forEach(b =>
  b.addEventListener('click', () =>
    document.querySelectorAll('.ovl.on').forEach(o => o.classList.remove('on'))));
document.querySelectorAll('.ovl').forEach(o =>
  o.addEventListener('mousedown', e => { if (e.target === o) o.classList.remove('on'); }));
addEventListener('keydown', e => {
  /* Only the topmost, so a confirmation raised over the start dialog closes
     itself and leaves what is underneath alone. */
  if (e.key !== 'Escape') return;
  const top = [...document.querySelectorAll('.ovl.on')].at(-1);
  if (!top) return;
  e.stopPropagation();
  /* A dialog that someone is waiting on cannot simply be hidden — the promise
     behind it would never settle and the paragraph would stay open forever with
     no way back in. Escaping the question means no. */
  if (top.id === 'ovlBlockCf') { answerDiscard(false); return; }
  top.classList.remove('on');
});

wireModals();

addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

/* The logo is a link home, and a link out of a page with unsaved work is worth
   a question — but our own question, not the browser's. Chrome suppresses its
   beforeunload panel unless the page has seen a gesture it recognises, so on
   the click that matters it can say nothing at all and simply not navigate. */
document.querySelector<HTMLAnchorElement>('a.logo')?.addEventListener('click', e => {
  if (!dirty) return;
  e.preventDefault();
  askToDiscard(() => { dirty = false; location.href = './'; }, 'Leaving this page discards them');
});

/* ── entry ──────────────────────────────────────────── */

/* A route is an instruction, and an instruction that has been carried out
   should stop being in the address bar. Leaving `#new=blank` there meant a
   refresh threw away whatever had been done since and opened a blank page
   again — and the address described a document that was no longer on screen.
   replaceState rather than assignment: writing to location.hash would fire
   hashchange and route a second time. */
function clearRoute(): void {
  if (!location.hash) return;
  /* window.history spelled out: `history` in this module is the undo stack. */
  window.history.replaceState(null, '', location.pathname + location.search);
}

async function boot(): Promise<void> {
  /* The hash, not the query string. Static hosts that serve clean URLs answer
     /editor.html with a 301 to /editor and drop everything after the '?' —
     which is why both entry buttons were opening the same screen. A hash never
     reaches the server, so nothing can lose it. The query is still read as a
     fallback for links written by hand. */
  const params = new URLSearchParams(
    location.hash.replace(/^#/, '') || location.search.replace(/^\?/, ''),
  );

  /* The address wins.
   *
   * A file parked by a drop on the home page used to be opened before the hash
   * was even looked at, so clicking "Open the form" on a W-9 page landed you in
   * whatever had been dropped in an earlier session — and reloading the very
   * same URL then worked, because by then the parked file had been consumed.
   * Someone who followed a link to a named document asked for that document;
   * a handoff sitting in IndexedDB from an hour ago did not. */
  const form = params.get('form');
  const wanted = params.get('template') ?? (params.get('new') === 'blank' ? 'blank' : null);

  if (form) { clearRoute(); await openForm(form); return; }
  const t = wanted ? templateById(wanted) : null;
  if (t) { clearRoute(); await openTemplate(t); return; }

  const handed = await takeHandoff();
  if (handed) { await openFile(handed); return; }

  /* "Try the sample document" — and any link naming a template that no longer
     exists — opens the same blank page with the picker over it, so closing the
     dialog still leaves you somewhere you can work rather than on a grey stage. */
  await openTemplate(templateById('blank')!);
  await start.open();
  if (wanted) toast(`There is no “${wanted}” template — pick one below.`);
}

void boot();

/* A hash-only change never reloads the page, so a link to another form from
   inside the editor would otherwise do nothing at all. Routing on hashchange
   as well makes those links behave like every other link on the site. */
addEventListener('hashchange', () => {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  const form = params.get('form');
  const template = params.get('template') ?? (params.get('new') === 'blank' ? 'blank' : null);

  const go = () => {
    clearRoute();
    if (form) { void openForm(form); return; }
    const t = template ? templateById(template) : null;
    if (t) { void openTemplate(t); return; }
    if (params.get('start') === '1') void start.open();
  };

  /* Unsaved work is not thrown away because a link was clicked. */
  if (!dirty) { go(); return; }
  askToDiscard(go);
});
