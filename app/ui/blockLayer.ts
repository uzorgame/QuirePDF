import type {PDFPageProxy} from '../core/pdfjs';
import {getBlocks, type Block, type Line, type Run} from '../core/blocks';
import {CSS_FONT, isBold as boldFont, isItalic as italicFont,
        type FontId, type Pt} from '../core/annots';
import {docFace} from '../core/docFonts';

/* How wide a run will be once it is in the file.
 *
 * Measured in the browser rather than asked of pdf-lib, because the writer is
 * not here and the answer is needed while the caret is still blinking. It is
 * close enough to be right: Arial was drawn to match Helvetica's metrics, and
 * Times New Roman and Courier New match theirs, which is the whole reason those
 * substitutions are safe in the first place. */
const RULER = document.createElement('canvas').getContext('2d')!;

function drawnWidth(text: string, size: number, font: FontId, track = 0, family?: string): number {
  if (!text) return 0;
  /* The face the writer will actually use, when it has one to use. pdf.js has
     the page's own fonts registered in the browser under its own keys, so the
     ruler can be asked the same question the file will answer. */
  const stack = family ? `"${family}", ${CSS_FONT[font]}` : CSS_FONT[font];
  /* Weight and slope are asked for only of the stand-ins. A named document face
     is already the bold or the italic cut — it is embedded and drawn at its
     natural weight — and asking for bold on top of it gets Chrome's synthetic
     emboldening, which is a couple of per cent wider than the bytes the writer
     will put in the file. The run then came out narrower than the print by
     exactly that much, on the bold lead-ins this feature exists to preserve. */
  const synth = !family;
  RULER.font = `${synth && italicFont(font) ? 'italic ' : ''}${synth && boldFont(font) ? '700 ' : '400 '}`
    + `${size}px ${stack}`;
  return RULER.measureText(text).width + track * text.length;
}

/* Editing a paragraph, not a rectangle.
 *
 * The old Edit text asked you to drag a box round the words you meant, then
 * tried to work out what was inside it. That is backwards: the document already
 * knows where its paragraphs are, and a box drawn by hand will always cut one
 * in half or take half of the next column with it. Here the paragraphs are
 * found first (core/blocks.ts) and drawn as frames the moment the tool is
 * switched on, so the thing you click is the thing the document thinks it is.
 *
 * A block can be typed into, moved and resized. Everything it produces is
 * ordinary annotations — a cover over the old words and one text run per piece
 * of styled text — so it exports through the writer that already exists rather
 * than needing one of its own. */

export interface CommitRun {
  text: string;
  at: Pt;
  size: number;
  font: FontId;
  /** The document face's clean name, when the run was set in one. */
  face?: string;
  color: string;
  /* Extra advance per character, in page units, as the block was calibrated on
     screen. The file reports how wide each run was printed; the browser sets
     the same words in the same face and lands a few percent off, and calibrate()
     closes that gap with letter-spacing. Losing it on the way out is why a name
     came back from a move four per cent wider than the one it replaced. */
  tracking?: number;
  /** Distance from at.y down to this run's baseline, in page units. */
  lead: number;
  /** The advance the run was measured at on screen, in page units. */
  ink: number;
}

/** What the panel should show for whatever is selected. null where mixed. */
export interface BlockStyle {
  size: number | null;
  font: FontId;
  face: string | null;
  /** True when the selection spans more than one typeface. */
  mixedFont: boolean;
  color: string;
  bold: boolean;
  italic: boolean;
  /** Extra advance per character in points; null where the selection mixes. */
  track: number | null;
}

/** A change from the panel, applied to the selection or to the whole block. */
export interface BlockRestyle {
  size?: number;
  font?: FontId;
  face?: string | null;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  track?: number;
}

export interface BlockCtx {
  /** True while the Edit text tool is the active one. */
  interactive(): boolean;
  scale(): number;
  /** Undo point, taken before the first change to a block. */
  beforeEdit(label: string): void;
  /** The block has been rewritten: cover this box, then draw these runs.
   *  Returns the ids of the marks it made, so they can be taken back off the
   *  page when the same paragraph is opened again. */
  commit(page: number, cover: {x: number; y: number; w: number; h: number},
         bg: string, runs: CommitRun[]): string[];
  /** Remove marks a previous rewrite of this paragraph left behind. */
  drop(ids: string[]): void;
  /** Asked before throwing away an edit. Resolves true to discard. */
  confirmDiscard(): Promise<boolean>;
  /** What the caret or selection currently sits in; null when nothing is open. */
  report(style: BlockStyle | null): void;
  /** The bold/italic sibling of a document face, when the document has one. */
  sibling(face: string, bold: boolean, italic: boolean): string | null;
}

/* Paragraphs that have been rewritten: the marks they produced, the text as it
 * was left, and where it ended up. This is what makes a block editable a second
 * time — the marks come back off the page and the text goes back into the box.
 *
 * Module state, not instance state, and that is the point: the viewer rebuilds
 * its layers on every zoom, and a registry living on the instance died with it
 * — one zoom after a rewrite and the paragraph was locked out of editing for
 * good. Keyed by page and block id (ids are stable because block detection is
 * cached per page proxy); cleared when a document closes. */
interface EditedBlock {
  ids: string[];
  html: string;
  geom: {x: number; y: number; w: number; h: number};
  /* The zoom its pixel sizes were written at. A span carries its type size in
     pixels, and a pixel is a fact about the screen it was written on rather
     than about the page — so markup left at one zoom has to be rebuilt before
     it can be laid out at another. */
  scale: number;
}
const edited = new Map<string, EditedBlock>();
const editKey = (page: number, id: string) => page + ':' + id;

export function resetBlockEdits(): void {
  edited.clear();
}

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;
type Handle = typeof HANDLES[number];

/* Which of the eleven faces the writer knows is closest to what the page used.
   Nothing here can embed the document's own font, so the honest thing is to
   pick the nearest of the standard families and keep the weight and slope. */
function fontIdFor(run: {face: string; bold: boolean; italic: boolean}): FontId {
  const f = run.face.toLowerCase();
  const mono = /mono|courier|consol|menlo/.test(f);
  const serif = /times|serif|georgia|garamond|book|roman|minion|cambria/.test(f);
  return stdCut(mono ? 'courier' : serif ? 'times' : 'helvetica', run.bold, run.italic);
}

/* The cut of a standard family for a given weight and slope. All three carry
   all four, so a run that is both bold and italic no longer has to give one of
   them up — which it did, quietly, in three separate places. */
function stdCut(family: 'helvetica' | 'times' | 'courier', bold: boolean, italic: boolean): FontId {
  const slope = family === 'times' ? 'italic' : 'oblique';
  if (bold && italic) return `${family}-bold${slope}` as FontId;
  if (bold) return `${family}-bold` as FontId;
  if (italic) return `${family}-${slope}` as FontId;
  return family;
}

/* One stack, shared with the marks layer and with the ruler.
 *
 * There used to be a second list here, and its monospace began with
 * ui-monospace — which on Windows is Consolas, a full nine per cent narrower
 * than the Courier New the committed mark is drawn in and the writer's metrics
 * are matched to. A contact line was therefore edited in one typeface and
 * committed in a visibly different one. The three families in CSS_FONT are the
 * ones whose metrics match pdf-lib's standard fourteen to within a tenth of a
 * per cent, which is the whole reason those substitutions are safe. */
const cssFamily = (id: FontId): string => CSS_FONT[id];

export class BlockLayer {
  readonly root: HTMLElement;
  private blocks: Block[] = [];
  private active: Block | null = null;
  private box: HTMLElement | null = null;
  private edit: HTMLElement | null = null;
  /* The state the paragraph was opened in.
   *
   * Whether it has changed is a comparison, not a flag. A flag said yes the
   * moment anything was touched, so moving a block and then putting it back —
   * with Undo or by hand — still counted as an edit: the block was written out
   * as marks, its frame was retired, and it could never be opened again. */
  private origin: {text: string; geom: {x: number; y: number; w: number; h: number}} | null = null;
  /** Live geometry of the active block: it can be moved and resized. */
  private geom = {x: 0, y: 0, w: 0, h: 0};
  /* Painted over the paragraph's original position and left there for as long
     as the block is open. It used to be the editing box's own background, which
     meant dragging the box carried the cover away with it and the original text
     reappeared underneath — so a move looked like a copy. */
  private cover: HTMLElement | null = null;
  private faces = new Map<string, string | null>();
  /* Selected and editing are different states, the way they are in every
     layout tool. A click picks the paragraph up — frame, handles, drag to
     move — and only a double-click puts the caret in it. While merely
     selected, a press anywhere on the block is a move, which is what makes
     dragging feel like dragging instead of like fighting a text caret. */
  private editing = false;

  /* Lifting is asked for and then granted, which are two different moments.
   *
   * A drag can begin one frame after the press, and the document's own faces
   * can take several to arrive. Showing the copy before they do means showing
   * the paragraph in Helvetica and then changing its typeface and its letter
   * spacing under the cursor, which is worse than a frame in which nothing
   * appears to happen — until then the file's own printed words are on screen,
   * and those are never wrong. */
  private settled = false;
  private wantLift = false;

  /* How many lines the box's height currently accounts for.
   *
   * Height is bought a leading at a time, because a line box is a whole leading
   * tall and the block's own height is not — it is ink, ascender to descender,
   * plus a point and a half. Subtracting one from the other made every
   * generously leaded paragraph grow the moment it was clicked. */
  private fitted = 0;

  /* The line count the file gave this paragraph, and nothing for one that has
     been rewritten before: a block reopened after an edit is whatever length
     the person made it, and holding it to the file's old line count would widen
     the frame by an eighth for a sentence they added themselves. */
  private fileLines = 0;

  /* True between the first pixel of a drag and the release. A fit that lands
     mid-drag is applied for one frame and then overwritten by the drag's own
     reference geometry, which reads as the box pulsing under the cursor. */
  private dragging = false;

  /* Puts a drag in flight back where it started. Set while one is live so that
     Escape can reach it from the key handler on the box as well as from the
     window listener the drag installs for itself. */
  private dragCancel: (() => void) | null = null;

  /* Whether the panel has been used on this paragraph. Neither the words nor
     the rectangle record a change of typeface, so without this the block
     compared equal to the one that was opened and the restyle was discarded. */
  private restyled = false;

  /* Undo inside the open paragraph.
   *
   * The document's own history cannot serve here: nothing has reached it yet,
   * and a snapshot of the annotation store would undo the edit before this one
   * rather than the keystroke you just regretted. So the block keeps its own
   * short stack of its own state — the markup and the geometry — and hands
   * Ctrl+Z back to the page only once there is nothing left of its own to undo.
   * Moving a block and pressing Ctrl+Z now puts it back, which it did not. */
  private undos: Array<{html: string; geom: {x: number; y: number; w: number; h: number}}> = [];
  private lastSnap = 0;

  constructor(
    private pageNo: number,
    private pageW: number,
    private pageH: number,
    private ctx: BlockCtx,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'qb-layer';
    this.root.dataset['page'] = String(pageNo);

    /* Clicking the page outside a paragraph closes it, keeping the work. Until
       now the only ways out were Tab and Escape, so the ordinary gesture —
       finish typing, click somewhere else, export — lost the edit silently. */
    this.root.addEventListener('pointerdown', e => {
      if (e.target === this.root && this.active) void this.close(true);
    });
  }

  async load(page: PDFPageProxy): Promise<void> {
    try {
      this.blocks = await getBlocks(page, this.pageNo);
    } catch {
      this.blocks = [];
    }
    this.render();
  }

  render(): void {
    /* An edit in progress survives a repaint — zoom and tool changes both come
       through here, and losing what you had typed to either would be its own
       kind of data loss. */
    if (this.active) return;

    this.root.replaceChildren();
    this.root.classList.toggle('qb-layer--on', this.ctx.interactive());
    if (!this.ctx.interactive()) return;

    for (const b of this.blocks) this.root.append(this.frameFor(b));
  }

  /* One dotted frame. Its own method because opening a block has to leave the
     rest of them in place — the first version replaced the whole layer with the
     open box, so clicking one paragraph made every other frame vanish and there
     was no way to reach a second one without switching tools and back. */
  private frameFor(b: Block): HTMLElement {
    const el = document.createElement('div');
    el.className = 'qb';
    el.dataset['id'] = b.id;
    this.place(el, edited.get(editKey(this.pageNo, b.id))?.geom ?? b);
    if (b.angle) el.style.transform = `rotate(${b.angle}deg)`;
    el.addEventListener('pointerdown', e => {
      e.stopPropagation();
      void this.open(b, e);
    });
    return el;
  }

  private place(el: HTMLElement, r: {x: number; y: number; w: number; h: number}): void {
    el.style.left = `${(r.x / this.pageW) * 100}%`;
    el.style.top = `${(r.y / this.pageH) * 100}%`;
    el.style.width = `${(r.w / this.pageW) * 100}%`;
    el.style.height = `${(r.h / this.pageH) * 100}%`;
  }

  /* ── opening a block ───────────────────────────────────────────────────── */

  private async open(block: Block, from?: PointerEvent): Promise<void> {
    /* Awaited, not fired and forgotten. Opening a second paragraph has to wait
       for the first to be written back, or the two overlap and the layer is
       rebuilt underneath the one being opened. */
    if (this.active) {
      await this.close(true);
      if (this.active) return;   /* the user chose to keep editing */
    }

    this.active = block;
    this.origin = null;
    this.undos = [];
    this.lastSnap = 0;
    this.fitted = 0;
    this.wantLift = false;
    this.restyled = false;
    this.settled = false;
    this.dragging = false;

    /* A paragraph that has been rewritten before is picked up where it was left.
       Its marks come off the page first: they are about to be produced again
       from whatever the block looks like when it closes, and leaving the old
       set behind would stack one rewrite on top of the last. */
    const prior = edited.get(editKey(this.pageNo, block.id));
    if (prior) {
      this.ctx.beforeEdit('editing text');
      this.ctx.drop(prior.ids);
      edited.delete(editKey(this.pageNo, block.id));
    }
    this.geom = prior ? {...prior.geom} : {x: block.x, y: block.y, w: block.w, h: block.h};
    /* The patch starts where the file's own words are, whatever has been done to
       the paragraph since; only the grips move it from there. */
    this.covers = {x: block.x, y: block.y, w: block.w, h: block.h};
    this.fileLines = prior ? 0 : block.lines.length;

    const scale = this.ctx.scale();

    const box = document.createElement('div');
    box.className = 'qb qb--on';
    box.dataset['id'] = block.id;
    this.place(box, this.geom);
    /* Deliberately transparent. Hiding the original words is the cover's job,
       and the cover is exactly the size of those words. The box used to be
       opaque too, so the moment it grew — a wrap, a drag, a longer sentence —
       it painted over whatever was beneath it, and a surname or a whole line of
       the paragraph below simply vanished. */
    if (block.angle) box.style.transform = `rotate(${block.angle}deg)`;

    const edit = document.createElement('div');
    edit.className = 'qb-t';
    edit.contentEditable = 'plaintext-only';
    edit.spellcheck = false;
    /* The container's own font is not decoration.
     *
     * Its strut takes part in every line box — a line is as tall as the tallest
     * thing on it, the invisible strut included — and the spaces that stand in
     * for the file's own wraps are set in it too. Left at the interface's 12px
     * Inter, both moved with the zoom rather than with the paragraph: at small
     * type and low zoom the strut won, and every baseline in the copy sat a
     * pixel or so below the print. */
    const first = block.lines[0]!;
    const lead = first.runs[0];
    edit.style.font = `${first.size * scale}px/${block.leading * scale}px `
      + cssFamily(fontIdFor({face: lead?.face ?? '', bold: false, italic: false}));
    edit.style.textAlign = block.align === 'justify' ? 'justify' : block.align;

    /* Where the copy's measure begins and ends.
     *
     * The frame carries a point and a half of air on each side so it does not
     * clip the letters, and the text must not inherit all of it: printed at x0,
     * it has to start at x0. But writing the *first line's* inset down as the
     * paragraph's padding — which is what this did — is only right where the
     * lines are set from the left. A centred line begins where it does because
     * it is centred, and recorded as an indent it moved the whole paragraph
     * sideways and took the same width off the measure, which for a two-line
     * title was enough to drive the widening loop to its ceiling.
     *
     * So the padding restores whichever edge the alignment is measured from —
     * the left one, the right one, or both where the text is centred on an axis
     * — and the first line's own indent is written down as an indent.
     *
     * A quarter point is then taken off the other end, and only a quarter. The
     * measure is the printed one to the last fraction of a point, and a line
     * that exactly filled its column in the file — which is every line of a
     * justified paragraph — needs somewhere for the last thousandth of a pixel
     * of rounding to go, or the browser wraps a word early and the frame grows
     * to make room. A quarter point absorbs that and is a fifth of a screen
     * pixel: too little to move a justified line's right edge anywhere the eye
     * can follow. */
    const slack = 0.25;
    const inkL = Math.min(...block.lines.map(l => l.x0));
    const inkR = Math.max(...block.lines.map(l => l.x1));
    const padL = Math.max(0, inkL - block.x);
    const padR = Math.max(0, block.x + block.w - inkR);
    const centred = block.align === 'center';
    const rightSet = block.align === 'right';
    const half = Math.max(0, (padL + padR - slack) / 2);
    edit.style.paddingLeft =
      `${(centred ? half : rightSet ? Math.max(0, padL - slack) : padL) * scale}px`;
    edit.style.paddingRight =
      `${(centred ? half : rightSet ? padR : Math.max(0, padR - slack)) * scale}px`;
    edit.style.textIndent = centred || rightSet
      ? '0' : `${Math.max(0, block.lines[0]!.x0 - inkL) * scale}px`;

    /* Soft breaks and hard ones are not the same thing.
     *
     * Where a paragraph wraps is a result of its width, not part of its text —
     * so those breaks are dropped and the browser re-wraps. Putting them back
     * as <br> was what made the paragraph break twice: once where the document
     * had run out of room and again where the browser did.
     *
     * A break that leaves the line well short of the right edge is deliberate,
     * though — an address, a signature block, a list of contact details — and
     * that one is kept. The test is simply whether the line reached the margin. */
    if (prior) {
      /* Exactly as it was left, faces and all — nothing is re-derived from the
         file, because the file no longer has anything to say about a paragraph
         that has already been rewritten. */
      edit.innerHTML = prior.html;
      this.rescale(edit, prior.scale);
    } else {
      const right = block.x + block.w;
      const ink = this.inkReader(block);
      block.lines.forEach((line, i) => {
        for (const run of line.runs) edit.append(this.spanFor(run, scale, ink(run, line)));
        if (i === block.lines.length - 1) return;
        const filled = line.x1 >= right - line.size * 2.5;
        if (filled) {
          /* A wrapped line needs the space the break was standing in for — but
             only if neither side already has one, or the join comes out with a
             visible double gap in the middle of a sentence. */
          const next = block.lines[i + 1];
          if (!/\s$/.test(line.text) && !/^\s/.test(next?.text ?? '')) {
            edit.append(document.createTextNode(' '));
          }
        } else {
          edit.append(document.createElement('br'));
        }
      });
    }

    box.append(edit);
    for (const h of HANDLES) {
      const grip = document.createElement('i');
      grip.className = `qb-h qb-h--${h}`;
      grip.dataset['edge'] = h;
      box.append(grip);
    }

    /* Every other frame stays exactly where it was; only this one paragraph's
       frame is swapped for the open box. */
    this.root.querySelector(`.qb[data-id="${block.id}"]`)?.remove();
    this.root.append(box);
    this.box = box;
    this.edit = edit;

    /* Dressed before it is measured, not a frame afterwards.
     *
     * Rendering the page installs the document's own faces, so by the time a
     * paragraph can be clicked they are nearly always there for the asking —
     * and asking synchronously means the block is calibrated, fitted and lifted
     * in the face it will keep. Asking a frame later left the first paint in
     * the stand-in's letter spacing inside a box fitted to the stand-in's
     * widths, which is the re-spacing that appeared a moment after a paragraph
     * was picked up and read as the typeface changing. */
    const ready = this.dressLoaded(edit);
    this.calibrate(edit);
    this.bindGeometry(box);
    this.bindEditing(edit);
    this.bindSelectedKeys(box);

    this.snap(true);
    /* Words and geometry, not markup: the markup is restyled asynchronously as
       the document's fonts land, and a snapshot of it would call every block
       edited the moment it opened. */
    this.origin = {text: edit.textContent ?? '', geom: {...this.geom}};

    /* Selected is not the same as lifted.
     *
     * A click puts a frame round the paragraph and changes nothing else: the
     * words on screen stay the ones the file printed, pixel for pixel, because
     * they are still the file's own. The editable copy is laid out invisibly
     * behind them — it has to exist for the panel to describe it and for the
     * widths to be calibrated — and is only shown once the paragraph is
     * actually lifted off the page, by a double-click or by a drag.
     *
     * That is the only way to promise nothing moves on a click. Any re-render
     * of the same words in the browser differs from the print by something:
     * where the spacing correction falls between letters, where the baseline
     * lands in the line box, how the glyphs are hinted. Matching it to within a
     * fraction of a percent is achievable and was achieved; matching it exactly
     * is not, so the honest answer is not to show it yet. */
    this.editing = false;
    edit.contentEditable = 'false';
    box.classList.add('qb--pick');
    box.tabIndex = -1;
    box.focus({preventScroll: true});
    /* Nothing left to wait for: the faces were already installed, or this is a
       paragraph that was rewritten earlier and is wearing the markup it was
       left in. Either way it may be lifted the moment it is asked for. */
    this.settled = !!prior || ready;
    /* The panel describes the paragraph from the moment it is selected.
     *
     * Until now the only thing that told it anything was settle(), at the end of
     * the font loading — so on every path that did not reach settle() the panel
     * went on showing whatever it had been left set to. That is worse than
     * showing nothing: the controls looked like they were describing the
     * selected paragraph, and choosing the value they already displayed fired no
     * change event at all, so the font "would not save". settle() reports again
     * when the real faces land; this is the first, immediate answer. */
    this.reportStyle();
    /* The press that selected the paragraph also arms the move, so press-hold-
       drag works as one gesture. It is only armed, not started: nothing is
       lifted or moved until the pointer has travelled far enough to mean it. */
    if (from) this.startDrag(box, from, null);

    box.addEventListener('dblclick', e => {
      e.preventDefault();
      e.stopPropagation();
      this.enterEditing(e as MouseEvent);
    });

    /* A paragraph that has been rewritten before has already left the page —
       its marks came off a moment ago, so the file's original words are showing
       again, at the original position. There is nothing left to protect and
       nothing still settling, so it is lifted at once rather than waiting for a
       drag that may never come. */
    if (prior) this.lift();

    /* The document's own face, once it has arrived. Until then the text is set
       in the nearest standard family, which is the right size but the wrong
       shape — noticeably so on a CV set in anything but Helvetica.
     *
     * Run for a reopened paragraph too. The guard that skipped it reasoned that
     * stored markup came back "exactly as it was left, faces and all" — true
     * only if it was dressed before it was stored, and a block closed while a
     * face was still loading was not. That paragraph then opened in Helvetica
     * for the rest of the session while its neighbours opened in the page's own
     * typeface. */
    void this.dressInRealFonts(edit).catch(() => this.markSettled(edit));
  }

  /* The words the panel is talking about.
   *
   * A document has one selection, and a click into the panel's own size box
   * takes it — so by the time the change arrives the highlight in the paragraph
   * is gone and there is nothing left to apply it to. Reaching for the whole
   * block then looked like the panel ignoring the selection, which is exactly
   * what the user saw. The last real selection inside the paragraph is
   * therefore kept, and used when the live one has moved away. */
  private picked: Range | null = null;

  /* Held as a field so it can be taken off again: the listener is on the
     document, and one left behind per opened paragraph would answer for a block
     that no longer exists. */
  private readonly onSelectionChange = (): void => { this.rememberPick(); };

  /** The selection inside the block, live or remembered. Null for none. */
  private pickedRange(): Range | null {
    const edit = this.edit;
    if (!edit || !this.editing) return null;
    const sel = window.getSelection();
    if (sel && sel.rangeCount && !sel.isCollapsed) {
      const live = sel.getRangeAt(0);
      if (edit.contains(live.commonAncestorContainer)) return live;
    }
    /* Remembered — but only while it still describes this paragraph. */
    if (this.picked && edit.contains(this.picked.commonAncestorContainer)
        && !this.picked.collapsed) return this.picked;
    return null;
  }

  /** Called whenever the caret moves inside the block, to keep that memory true. */
  private rememberPick(): void {
    const edit = this.edit;
    if (!edit) return;
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const r = sel.getRangeAt(0);
    if (!edit.contains(r.commonAncestorContainer)) return;
    /* A collapsed caret is a deliberate "no selection", and must clear the
       memory — otherwise a change meant for the whole paragraph would land on
       words the user had already stopped pointing at. */
    this.picked = r.collapsed ? null : r.cloneRange();
  }

  /* Every span the selection touches — or all of them when nothing is
     selected, because then the panel is describing the paragraph. */
  private spansInPlay(): HTMLElement[] {
    const edit = this.edit;
    if (!edit) return [];
    const all = [...edit.querySelectorAll<HTMLElement>('span')];
    const range = this.pickedRange();
    if (!range) return all;
    const touched = all.filter(s => range.intersectsNode(s));
    return touched.length ? touched : all;
  }

  /** Tell the panel what the selection is set in. */
  reportStyle(): void {
    const spans = this.spansInPlay();
    if (!spans.length) { this.ctx.report(null); return; }
    const one = <T>(read: (s: HTMLElement) => T): T | null => {
      const first = read(spans[0]!);
      return spans.every(s => read(s) === first) ? first : null;
    };
    const face = one(s => s.dataset['face'] ?? '');
    const font = one(s => s.dataset['font'] ?? 'helvetica') as FontId | null;
    this.ctx.report({
      size: one(s => Math.round((Number(s.dataset['size']) || 12) * 100) / 100),
      font: font ?? 'helvetica',
      mixedFont: face === null || font === null,
      /* A face is only a face if the document knows it by that name — the
         fallback id is stored in the same slot for spans that never had one. */
      face: face && face !== font ? face : null,
      color: one(s => s.dataset['color'] ?? '#111111') ?? '#111111',
      bold: spans.every(s => s.dataset['bold'] === 'true'),
      italic: spans.every(s => s.dataset['italic'] === 'true'),
      /* Reported in points, and only what the user asked for. The correction
         calibrate() applies is not a setting — it is the amount by which the
         browser's idea of the face differs from the file's, and showing it as a
         letter-spacing the user had chosen would invite them to "keep" it. */
      track: one(s => Math.round((Number(s.dataset['track']) || 0) * 100) / 100),
    });
  }

  /* One span, restyled in place. Everything the writer later reads lives in
     the dataset, so both have to move together or the screen and the file
     disagree about what you chose. */
  private restyleSpan(el: HTMLElement, c: BlockRestyle): void {
    const scale = this.ctx.scale();
    if (c.size || c.font || c.face !== undefined || c.bold !== undefined
        || c.italic !== undefined || c.track !== undefined) {
      /* A deliberate restyle retires the printed width as a target: the run is
         no longer trying to look like what the document had there. */
      delete el.dataset['w'];
    }
    if (c.track !== undefined) {
      /* Kept in points beside the pixels, because the pixels are only true at
         this zoom — the same run reopened at another magnification has to be
         able to say what was actually asked for. */
      el.dataset['track'] = String(c.track);
      el.style.letterSpacing = `${c.track * scale}px`;
      el.style.wordSpacing = '';
    }
    if (c.size) {
      el.dataset['size'] = String(c.size);
      el.style.fontSize = `${c.size * scale}px`;
      /* The old spacing was calibrated against the old size and is now a
         distortion rather than a correction. */
      el.style.letterSpacing = '';
    }
    if (c.color) { el.dataset['color'] = c.color; el.style.color = c.color; }

    let face = el.dataset['face'] ?? '';
    let font = (el.dataset['font'] as FontId) ?? 'helvetica';
    let bold = el.dataset['bold'] === 'true';
    let italic = el.dataset['italic'] === 'true';

    if (c.face !== undefined) {
      if (c.face) { face = c.face; }
      else { face = ''; el.dataset['key'] = ''; }
    }
    if (c.font) { font = c.font; face = ''; el.dataset['key'] = ''; }
    if (c.bold !== undefined) bold = c.bold;
    if (c.italic !== undefined) italic = c.italic;

    if ((c.bold !== undefined || c.italic !== undefined) && face) {
      /* Weight on a real typeface means a different cut of it, not a heavier
         rendering of the same one. Where the document has no such cut, fall
         back to the standard family, which does. */
      const sib = this.ctx.sibling(face, bold, italic);
      if (sib) face = sib; else face = '';
    }
    if (!face) {
      font = stdCut(font.startsWith('times') ? 'times'
        : font.startsWith('courier') ? 'courier' : 'helvetica', bold, italic);
    }

    el.dataset['face'] = face || font;
    el.dataset['font'] = font;
    el.dataset['bold'] = String(bold);
    el.dataset['italic'] = String(italic);

    const registered = face ? docFace(face) : null;
    const key = registered?.cssKey ?? '';
    if (face && key) {
      el.dataset['key'] = key;
      el.style.fontFamily = `"${key}", ${cssFamily(font)}`;
      /* The document's cut carries its own weight; asking again doubles it. */
      el.style.fontWeight = '400';
      el.style.fontStyle = 'normal';
    } else {
      el.style.fontFamily = cssFamily(font);
      el.style.fontWeight = bold ? '700' : '400';
      el.style.fontStyle = italic ? 'italic' : 'normal';
    }
    /* A change of face invalidates the calibration, which was a correction for
       the face that has just been replaced — but not a spacing the user chose
       for themselves, which is a decision about the words rather than about the
       typeface and survives being set in another one. */
    if (c.track === undefined
        && (c.font || c.face !== undefined || c.bold !== undefined || c.italic !== undefined)) {
      const own = Number(el.dataset['track']);
      el.style.letterSpacing = own ? `${own * scale}px` : '';
      el.style.wordSpacing = '';
    }
  }

  /** Apply a change from the panel to the selection, or to the whole block. */
  applyStyle(c: BlockRestyle): void {
    const edit = this.edit;
    if (!edit) return;
    this.snap(true);
    this.restyled = true;
    /* A restyled paragraph is no longer the file's own, so it comes off the page
       as soon as it is asked to look different — otherwise the new typeface sat
       invisibly behind the old print until something else lifted it. */
    this.lift();

    const range = this.pickedRange();

    if (!range) {
      for (const el of edit.querySelectorAll<HTMLElement>('span')) this.restyleSpan(el, c);
    } else {
      /* Extracting splits any span the selection cuts through, so what comes
         back is exactly the chosen letters and nothing else. */
      const frag = range.extractContents();
      const walk = document.createTreeWalker(frag, NodeFilter.SHOW_TEXT);
      const texts: Text[] = [];
      for (let n = walk.nextNode(); n; n = walk.nextNode()) texts.push(n as Text);
      for (const t of texts) {
        let host = t.parentElement;
        if (!host || host.tagName !== 'SPAN') {
          /* A bare text node — a joining space — needs a span of its own to
             carry the style, cloned from whatever it sat beside. */
          const donor = frag.querySelector('span');
          const span = document.createElement('span');
          if (donor) {
            span.setAttribute('style', donor.getAttribute('style') ?? '');
            for (const k of ['size', 'font', 'face', 'key', 'bold', 'italic', 'color']) {
              if (donor.dataset[k] !== undefined) span.dataset[k] = donor.dataset[k]!;
            }
          }
          t.replaceWith(span);
          span.append(t);
          host = span;
        }
        this.restyleSpan(host, c);
      }
      range.insertNode(frag);
      /* The words that were restyled stay the chosen ones, so a second change
         lands on them again — whether or not the caret is still in the block,
         because by now the focus is very likely in the panel. */
      this.picked = range.cloneRange();
      const sel = window.getSelection();
      if (sel && this.editing) { sel.removeAllRanges(); sel.addRange(range); }
    }

    this.grow();
    this.fitToContent();
    this.reportStyle();
  }

  /* Lift the paragraph off the page: cover the print, show the copy.
   *
   * Deferred until the moment it is needed, so that selecting a block leaves
   * the page untouched. Idempotent — a drag and then a double-click must not
   * paint two covers. */
  private lift(): void {
    if (this.cover) return;
    /* Asked for, not necessarily granted. */
    this.wantLift = true;
    if (this.settled) this.reveal();
  }

  /* The patch that hides the printed words.
   *
   * Wider than the box the file reports, because glyphs overhang it — a
   * comma's tail or an italic f left a sliver of the old text showing round a
   * tight patch. The same rectangle serves the live cover and the committed
   * one: they were two and a half points apart, so a hairline of the original
   * stayed visible for the whole of a drag and vanished at the commit. */
  private static coverRect(b: {x: number; y: number; w: number; h: number}) {
    return {x: b.x - 2.5, y: b.y - 2.5, w: b.w + 5, h: b.h + 5};
  }

  /* What the white patch covers, which is not the same as where the paragraph
   * now is.
   *
   * Moving a block leaves the original words where they were, so the patch must
   * stay behind with them. Resizing it is the other case entirely: the grips are
   * the only way to say "hide more of the page than the detector found", and
   * with the patch pinned to the detected rectangle they said nothing at all —
   * the frame grew, the paper underneath did not change, and dragging the bottom
   * edge was an operation with no result. So a resize moves this rectangle and a
   * move does not. */
  private covers = {x: 0, y: 0, w: 0, h: 0};

  private reveal(): void {
    const box = this.box, block = this.active;
    if (!box || !block || this.cover) return;
    const cover = document.createElement('div');
    cover.className = 'qb-cover';
    this.place(cover, BlockLayer.coverRect(this.covers));
    /* Sampled from the unpadded block, so the paper colour is read from the
       same rectangle the commit reads it from. */
    cover.style.background = this.sample(block);
    if (block.angle) cover.style.transform = `rotate(${block.angle}deg)`;
    this.cover = cover;
    /* Behind the box, so the frame and its grips stay on top. */
    box.before(cover);
    box.classList.add('qb--lifted');
    /* The copy is the thing being looked at now, so it may have the room it
       needs — and not before. */
    this.fitToContent();
  }

  /** The faces have landed, or there were never any to wait for. */
  private markSettled(edit: HTMLElement): void {
    if (this.edit !== edit) return;
    this.settled = true;
    if (this.wantLift) this.reveal();
  }

  /** The double-click: caret in, word under the pointer selected. */
  private enterEditing(at?: MouseEvent): void {
    const box = this.box, edit = this.edit;
    if (!box || !edit || this.editing) return;
    this.lift();
    this.editing = true;
    box.classList.remove('qb--pick');
    box.classList.add('qb--edit');
    edit.contentEditable = 'plaintext-only';
    edit.focus({preventScroll: true});
    window.setTimeout(() => this.reportStyle(), 0);
    if (at) {
      this.caretAt(at.clientX, at.clientY);
      /* A double-click means the word, in every editor anyone has used. */
      const sel = window.getSelection() as (Selection & {
        modify?(alter: string, dir: string, unit: string): void;
      }) | null;
      try {
        sel?.modify?.('move', 'backward', 'word');
        sel?.modify?.('extend', 'forward', 'word');
      } catch { /* selection stays a caret — still usable */ }
    }
  }

  /** Escape from the caret back to the frame, keeping the text as it is. */
  private exitEditing(): void {
    const box = this.box, edit = this.edit;
    if (!box || !edit) return;
    this.editing = false;
    edit.contentEditable = 'false';
    box.classList.remove('qb--edit');
    this.reportStyle();
    box.classList.add('qb--pick');
    window.getSelection()?.removeAllRanges();
    box.focus({preventScroll: true});
  }

  /* Loads the fonts the page itself uses and re-sets the block in them.
   *
   * pdf.js hands over a sanitised OpenType copy of every embedded face, which
   * the browser will accept through FontFace. Without it the block visibly
   * changes typeface — and therefore apparent size — the moment it is opened,
   * which makes the editor feel like it is replacing the text rather than
   * letting you edit it. */
  private async dressInRealFonts(edit: HTMLElement): Promise<void> {
    const spans = [...edit.querySelectorAll<HTMLElement>('span')];
    const keys = new Set(spans.map(s => s.dataset['key'] ?? '').filter(Boolean));
    const families = new Map<string, string>();

    for (const key of keys) {
      const family = await this.faceFor(key);
      if (family) families.set(key, family);
    }
    if (this.edit !== edit) return;
    /* A page whose faces will never resolve — a Type3 font, or bytes pdf.js
       could not hand over — has nothing to wait for, and a paragraph that could
       not be lifted at all would be a worse failure than a stand-in face. */
    if (!families.size) { this.reportStyle(); this.markSettled(edit); return; }

    const dress = (root: HTMLElement): void => {
      for (const s of root.querySelectorAll<HTMLElement>('span')) {
        const family = families.get(s.dataset['key'] ?? '');
        if (!family) continue;
        this.wearFace(s, family);
      }
    };
    dress(edit);

    /* The widths have all changed, so the calibration has to be redone against
       the face that is actually on screen now — and *only* once the browser is
       actually laying out with it.
     *
     * Measuring straight after setting font-family looks safe, because reading
     * a width forces layout. It is not: a face registered moments earlier can
     * still be reported as loaded while the matching that picks it for a span
     * has not happened yet, so the width comes back from the inherited fallback
     * instead. Calibrating against that told the run to stretch by the maximum
     * the clamp allows, which is exactly the tracking that made a clicked title
     * look a size larger. Waiting for the font set, then for a frame, and then
     * calibrating twice, removes every version of that race. */
    void this.settle(edit);

    /* Every stored snapshot is re-dressed the same way, origin included.
     *
     * The fonts land asynchronously, and the user may already have moved the
     * block by then — so the snapshots in the stack describe markup that no
     * longer exists. Left alone, the mismatch made changed() answer yes
     * forever: Escape then asked about discarding work that had never been
     * typed, and a block that was merely moved and moved back still counted as
     * rewritten. Rewriting the stored HTML through the same transformation
     * keeps the comparison honest without losing anyone's work. */
    const scratch = document.createElement('div');
    const redress = (html: string): string => {
      scratch.innerHTML = html;
      dress(scratch);
      return scratch.innerHTML;
    };
    for (const u of this.undos) u.html = redress(u.html);
  }

  /** Calibrate once the browser is really rendering with the document's faces. */
  private async settle(edit: HTMLElement): Promise<void> {
    const frame = () => new Promise<void>(r => requestAnimationFrame(() => r()));
    try { await document.fonts.ready; } catch { /* a browser without it still works */ }
    await frame();
    if (this.edit !== edit) return;
    this.calibrate(edit);

    /* A second pass a frame later. calibrate() clears its own previous result
       before measuring, so running it twice is a correction, not a compounding
       — and the second reading is the one taken with everything in place. */
    await frame();
    if (this.edit !== edit) return;
    this.calibrate(edit);
    this.fitToContent();
    this.reportStyle();
    this.markSettled(edit);
  }

  /* One span, in the face the file names, with the nearest standard family kept
     behind it. Every path that dresses a run goes through here, because three
     paths writing three different font stacks meant the same run measured
     differently depending on which of them had touched it last — and one of
     them named the pdf.js key alone, so a character the embedded subset did not
     carry came out in the browser's last-resort serif. */
  private wearFace(s: HTMLElement, family: string): void {
    const font = (s.dataset['font'] as FontId) ?? 'helvetica';
    s.style.fontFamily = `"${family}", ${cssFamily(font)}`;
    /* The real face carries its own weight and slope; asking for them again
       gives a synthesised bold on top of a bold. */
    s.style.fontWeight = '400';
    s.style.fontStyle = 'normal';
  }

  /* The document's faces the browser can already lay out with, taken now.
   *
   * Answers whether every span got one, which is the same question as whether
   * there is anything left to wait for before the paragraph can be shown. */
  private dressLoaded(edit: HTMLElement): boolean {
    let all = true;
    for (const s of edit.querySelectorAll<HTMLElement>('span')) {
      const key = s.dataset['key'] ?? '';
      if (!key) continue;
      let ready = this.faces.get(key) ?? null;
      if (!ready) {
        for (const face of document.fonts) {
          if (face.family === key && face.status === 'loaded') { ready = key; break; }
        }
        if (ready) this.faces.set(key, ready);
      }
      if (ready) this.wearFace(s, ready); else all = false;
    }
    return all;
  }

  /* Markup left at one zoom, reopened at another.
   *
   * A span carries its type size in pixels, and a pixel is a fact about the
   * screen it was written on rather than about the page — so a paragraph edited
   * at one zoom came back laid out at that zoom inside a frame placed at this
   * one. The size is rebuilt from the page units the span kept all along; the
   * spacing correction and the printed width it aims at were both measured in
   * pixels, so they are simply carried across. */
  private rescale(edit: HTMLElement, was: number): void {
    const now = this.ctx.scale();
    if (!(was > 0) || Math.abs(now - was) < 1e-6) return;
    const k = now / was;
    for (const s of edit.querySelectorAll<HTMLElement>('span')) {
      const size = Number(s.dataset['size']);
      if (size > 0) s.style.fontSize = `${size * now}px`;
      const track = parseFloat(s.style.letterSpacing);
      if (track) s.style.letterSpacing = `${track * k}px`;
      const w = Number(s.dataset['w']);
      if (w > 0) s.dataset['w'] = String(w * k);
    }
  }

  /* The face pdf.js is already using to paint this page.
   *
   * There is nothing to load. Rendering the page installs every embedded font
   * into document.fonts under its own key — the same "g_d17_f5" the text items
   * are tagged with — so the editor can simply name it. Building a second copy
   * from commonObjs.data, which is what this did first, produced a font the
   * browser then had to parse again for no gain; and where the copy failed the
   * block fell back to Helvetica and visibly changed shape on opening. */
  private async faceFor(key: string): Promise<string | null> {
    /* Only successes are remembered. A page whose fonts have not finished
       installing answers "no" once, and caching that answer left the block in
       the fallback face for the rest of the session — which is the paragraph
       that opens in the wrong typeface while its neighbours open in the right
       one. */
    const known = this.faces.get(key);
    if (known) return known;

    let found: string | null = null;
    for (const face of document.fonts) {
      if (face.family !== key) continue;
      /* Registered is not the same as ready: pdf.js adds the face and loads it
         asynchronously, and using it before it is ready shows the fallback for
         a frame. */
      if (face.status !== 'loaded') { try { await face.load(); } catch { break; } }
      found = key;
      break;
    }

    this.faces.set(key, found);
    return found;
  }

  private spanFor(run: Run, scale: number, ink: string): HTMLElement {
    const id = fontIdFor(run);
    const s = document.createElement('span');
    s.textContent = run.text;
    s.style.fontSize = `${run.size * scale}px`;
    s.style.fontFamily = cssFamily(id);
    s.style.fontWeight = run.bold ? '700' : '400';
    s.style.fontStyle = run.italic ? 'italic' : 'normal';
    s.style.color = ink;
    s.dataset['size'] = String(run.size);
    s.dataset['font'] = id;
    s.dataset['face'] = run.face || id;
    s.dataset['key'] = run.fontKey;
    s.dataset['bold'] = String(run.bold);
    s.dataset['italic'] = String(run.italic);
    s.dataset['color'] = ink;
    s.dataset['w'] = String(run.w * scale);
    /* The words as the file printed them. The printed width beside it is a fact
       about *these* characters, so once they have been typed over it is no
       longer a target — holding new text to the old run's advance would squeeze
       or stretch it by however much the sentence changed length. */
    s.dataset['t'] = run.text;
    return s;
  }

  /* Making the HTML as wide as the print.
   *
   * The page was set in a font we cannot use here, at widths the file records
   * exactly. Laying the same words out in Helvetica gives a different length —
   * a few percent, which over a line is several characters — so the moment a
   * block opens the text visibly jumps. Spreading the difference across the
   * letters holds each run to the width the document says it has. */
  private calibrate(edit: HTMLElement): void {
    for (const s of edit.querySelectorAll<HTMLElement>('span')) {
      const want = Number(s.dataset['w']);
      const text = s.textContent ?? '';
      if (!(want > 0 && text.length > 1)) continue;
      /* Only while the run still holds the words the width was measured for.
         Typed over, it keeps whatever correction it had — a per-character
         allowance for the difference between two faces, which is still the
         right idea for the new letters — rather than being pulled back to a
         length that belonged to a sentence that is no longer there. */
      const pristine = s.dataset['t'];
      if (pristine !== undefined && pristine !== text) continue;

      /* Measured on a canvas, not by asking the element how wide it is.
       *
       * A span whose text has wrapped reports the width of its container —
       * from the layout's point of view the content fits, and the number that
       * comes back is the box, not the words. Calibrating against that told a
       * run to stretch by the maximum the clamp allows, which is precisely the
       * tracking that made a clicked title look a size bigger than the page.
       * A ruler never wraps, so it always answers the question actually asked. */
      const cs = getComputedStyle(s);
      RULER.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const got = RULER.measureText(text).width;
      if (!(got > 0)) continue;

      /* Clamped to a fraction of the type size. The spread exists to absorb the
         few percent by which one face runs wider than another; unbounded, it
         grows into visible tracking, which reads worse than a slightly wrong
         width ever would. */
      const cap = parseFloat(cs.fontSize) * 0.12;
      const track = Math.max(-cap, Math.min(cap, (want - got) / text.length));
      s.style.letterSpacing = `${track}px`;

      /* Whatever the letters could not absorb is put on the spaces, because on
       * a tracked line that is exactly where it came from.
       *
       * An embedded subset carries the glyphs the page used, and a page encodes
       * its word gaps as positioning rather than as characters — so the face has
       * no space of its own and the browser takes one from the next family in
       * the stack. For prose that is harmless, the stand-in's space being within
       * a fraction of a percent of the document's. For a heading set in a
       * monospaced face it is not: Courier New's space is 5.76px against the
       * 1.92px the file advances by, and nine of them put "E X P E R I E N C E"
       * eighteen per cent over its measure, far more than the clamp on the
       * letters could ever give back. Spaces are where the error is, so spaces
       * are where the correction belongs. */
      const spaces = text.length - text.replace(/ /g, '').length;
      if (!spaces) { s.style.wordSpacing = ''; continue; }
      s.style.wordSpacing = '';
      RULER.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const spread = RULER.measureText(text).width + track * text.length;
      s.style.wordSpacing = `${(want - spread) / spaces}px`;
    }

    /* The target is kept, not consumed. The run is calibrated more than once —
       against the stand-in face while the document's own is still loading, and
       again once it arrives — and a target deleted on the first pass leaves the
       second with nothing to aim at. */
  }

  private caretAt(clientX: number, clientY: number): void {
    const d = document as Document & {
      caretPositionFromPoint?(x: number, y: number): {offsetNode: Node; offset: number} | null;
      caretRangeFromPoint?(x: number, y: number): Range | null;
    };
    const range = d.caretRangeFromPoint?.(clientX, clientY) ?? (() => {
      const p = d.caretPositionFromPoint?.(clientX, clientY);
      if (!p) return null;
      const r = document.createRange();
      r.setStart(p.offsetNode, p.offset);
      r.collapse(true);
      return r;
    })();
    if (!range || !this.edit?.contains(range.startContainer)) return;
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }

  /* ── typing ────────────────────────────────────────────────────────────── */

  /** Remember the block's state. Consecutive keystrokes share one entry. */
  private snap(force = false): void {
    if (!this.edit) return;
    const now = performance.now();
    /* Typing a word is one undo, not eight. The gap is the one every editor
       uses: long enough that a burst of keys is a burst, short enough that a
       pause between two thoughts is two entries. */
    if (!force && now - this.lastSnap < 700 && this.undos.length) return;
    this.lastSnap = now;
    this.undos.push({html: this.edit.innerHTML, geom: {...this.geom}});
    if (this.undos.length > 60) this.undos.shift();
  }

  /** Has anything actually moved or been typed since the block was opened? */
  private changed(): boolean {
    const o = this.origin;
    if (!this.edit || !o) return false;
    /* Restyling changes neither the words nor the rectangle, which is why it was
       being thrown away: the comparison found the paragraph identical to the one
       that had been opened and closed it without writing anything. Picking a
       font, a size or a weight in the panel is an edit like any other, and the
       block has to remember that it happened. */
    if (this.restyled) return true;
    if ((this.edit.textContent ?? '') !== o.text) return true;
    const g = this.geom;
    return Math.abs(g.x - o.geom.x) > 0.01 || Math.abs(g.y - o.geom.y) > 0.01
        || Math.abs(g.w - o.geom.w) > 0.01 || Math.abs(g.h - o.geom.h) > 0.01;
  }

  /** Step back inside the block. False when there is nothing of ours left. */
  undo(): boolean {
    const back = this.undos.pop();
    if (!back || !this.edit || !this.box) return false;
    this.edit.innerHTML = back.html;
    this.geom = {...back.geom};
    this.place(this.box, this.geom);
    this.box.classList.toggle('qb--over', this.overlapsNeighbour());
    this.lastSnap = 0;
    if (this.editing) this.edit.focus({preventScroll: true});
    else this.box.focus({preventScroll: true});
    return true;
  }

  /* The frame answers keys of its own while the caret is elsewhere. */
  private bindSelectedKeys(box: HTMLElement): void {
    box.addEventListener('keydown', e => {
      if (this.editing) return;
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation();
        /* A drag in flight is what Escape is about; the paragraph stays open. */
        if (this.dragCancel) { this.dragCancel(); return; }
        void this.close(true);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault(); e.stopPropagation();
        void this.closeAndNext();
        return;
      }
      if (e.key === 'Enter' || e.key === 'F2') {
        e.preventDefault();
        this.enterEditing();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        if (this.undo()) e.stopPropagation();
      }
    });
  }

  /** Commit this paragraph and hand the frame to the next one down the page. */
  private async closeAndNext(): Promise<void> {
    const current = this.active;
    await this.close(true);
    if (!current || this.active) return;
    const i = this.blocks.findIndex(b => b.id === current.id);
    const next = this.blocks[(i + 1) % Math.max(1, this.blocks.length)];
    if (next && next.id !== current.id) void this.open(next);
  }

  private bindEditing(edit: HTMLElement): void {
    edit.addEventListener('beforeinput', () => this.snap());
    edit.addEventListener('input', () => { this.rememberPick(); this.grow(); this.reportStyle(); });
    /* The panel follows the caret. Without this it kept describing whatever was
       under the cursor when the block opened, however far the selection moved. */
    edit.addEventListener('keyup', () => { this.rememberPick(); this.reportStyle(); });
    edit.addEventListener('pointerup', () => { this.rememberPick(); this.reportStyle(); });
    /* A drag-select ends outside the element as often as inside it, and a
       double-click's word selection is made after the event this listener would
       otherwise have to read. selectionchange sees both. */
    document.addEventListener('selectionchange', this.onSelectionChange, true);
    edit.addEventListener('paste', e => {
      /* Plain text only. A paste that carried its own markup would put styles
         into the block that nothing downstream can write into a PDF. */
      e.preventDefault();
      const text = e.clipboardData?.getData('text/plain') ?? '';
      if (text) document.execCommand('insertText', false, text.replace(/\r/g, ''));
    });

    edit.addEventListener('keydown', e => {
      /* Both keys are stopped here rather than merely handled.
       *
       * Escape means three things in this editor — drop the selection, close
       * the dialog, leave the paragraph — and while a paragraph is open it can
       * only mean the last. Left to bubble, the page's own handler switched the
       * tool back to Select, which closed and saved the block; and the dialog
       * handler answered the very question this keystroke had just asked. */
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation();
        /* Out of the caret, not out of the paragraph — Escape twice leaves.
           The discard question is only worth asking when there is typed work
           to lose; geometry is undoable in place. */
        const o = this.origin;
        if (o && this.edit && (this.edit.textContent ?? '') !== o.text) {
          void this.ctx.confirmDiscard().then(discard => {
            if (!discard) return;
            /* Back to the very first snapshot — the one taken as the block
               opened — which restores the words without losing the fonts the
               spans have since been dressed in. */
            const first = this.undos[0];
            if (first && this.edit && this.box) {
              this.edit.innerHTML = first.html;
              this.geom = {...first.geom};
              this.place(this.box, this.geom);
              this.undos = [first];
            }
            this.exitEditing();
          });
        } else {
          this.exitEditing();
        }
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault(); e.stopPropagation();
        void this.closeAndNext();
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        /* A block is a paragraph, not a document. Enter breaks the line inside
           it; there is nowhere for a second paragraph to go. */
        e.preventDefault();
        document.execCommand('insertLineBreak');
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        /* Ours first. Only when the block has nothing left to undo does the
           keystroke belong to the document, and then it must reach it — hence
           no stopPropagation on the way out. */
        e.preventDefault();
        if (this.undo()) e.stopPropagation();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        /* Select the block, not the page. */
        e.preventDefault();
        const r = document.createRange();
        r.selectNodeContents(edit);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(r);
      }
    });
  }

  /* The box takes the size its contents need.
   *
   * Its width starts as the paragraph's own, which is the width of the printed
   * text and not a millimetre more — so a substitute face rendering half a
   * percent wide was enough to wrap "Mykhailo Nahreba" onto two lines the
   * instant the block was clicked. Nothing had been edited; the editor simply
   * could not fit the words back into the space they came out of. Widening the
   * frame a hair is invisible and keeps the line structure the document had. */
  private fitToContent(): void {
    const box = this.box, edit = this.edit, block = this.active;
    if (!box || !edit || !block) return;

    /* Nothing is fitted while the paragraph is still the file's own.
     *
     * The copy is hidden rather than absent, so it takes part in layout and can
     * be measured at any time — which is how a click came to resize the frame
     * the user was looking at. Until the copy is showing, the only honest
     * rectangle is the one the detector found: a frame that grows on a click
     * breaks exactly the promise that keeping the copy hidden was made to keep. */
    if (!this.cover) return;
    /* And never between two moves of a drag: the fit would be applied for one
       frame and then overwritten by the drag's own reference geometry, which
       reads as the box pulsing under the cursor. stop() does it instead. */
    if (this.dragging) return;

    const was = {...this.geom};

    /* Widen a percent at a time until the paragraph occupies the same number of
       lines the document gave it. Twelve steps is an eighth wider, far more
       than any substitute face needs and low enough that a genuinely overlong
       block gives up rather than growing across the page. */
    for (let guard = 0; guard < 12 && this.fileLines && this.lineCount() > this.fileLines; guard++) {
      this.geom.w += Math.max(2, this.geom.w * 0.012);
      this.place(box, this.geom);
    }

    /* Height is counted in lines, not in pixels.
     *
     * A flow of n line boxes is n whole leadings tall; the block's own height is
     * ink, from the first ascender to the last descender, plus a point and a
     * half. Comparing one against the other grew every generously leaded
     * paragraph by the half-leading at each end the moment it was opened — and
     * left tight prose alone, which is why the fault looked intermittent. So
     * the box is only ever bought another line's worth of room, and only when
     * it is genuinely holding another line.
     *
     * The count is taken on the first fit rather than at open, so a paragraph
     * reopened after a rewrite comes back at the height it was left at whatever
     * the file once said about it. */
    const now = this.lineCount();
    if (!this.fitted) this.fitted = now;
    else if (now > this.fitted) {
      this.geom.h += (now - this.fitted) * block.leading;
      this.fitted = now;
      this.place(box, this.geom);
    }

    this.alignBaseline();

    /* The fit is not an edit — but only the fit.
     *
     * What the loops above did is folded into the block's idea of where it
     * started, so that opening a paragraph and letting the substitute face
     * settle does not by itself count as a rewrite. Copying the whole geometry
     * across folded in the *move* as well: the fit that runs at the end of a
     * drag declared the dragged position to be the original one, the block then
     * compared equal to itself, closed without committing, and the paragraph
     * sprang back to where the file had it. Only the width and height the fit
     * actually changed belong here. */
    const dw = this.geom.w - was.w;
    const dh = this.geom.h - was.h;
    if (this.origin) { this.origin.geom.w += dw; this.origin.geom.h += dh; }
    if (this.undos.length) {
      this.undos[0]!.geom.w += dw;
      this.undos[0]!.geom.h += dh;
    }
  }

  /* Put the copy's first baseline exactly where the file printed it.
   *
   * Nothing else in the box is aimed at the baseline. The copy's top edge is
   * the block's top edge, and where the baseline then falls is half the leading
   * plus whatever ascent the face happens to have — which is only right by
   * accident, and only at one particular leading. At 1.4 of the type size the
   * copy sat a couple of pixels below the print and at 1.0 a couple above, so
   * different paragraphs in the same document stepped different ways as they
   * were picked up. (Until now two of those pixels were being cancelled by the
   * copy being laid out inside the frame's border, one wrong thing hiding
   * another.)
   *
   * Measured rather than derived, because an inline-block with hidden overflow
   * takes its bottom edge as its baseline, which makes it a ruler for the line
   * it sits on — and it accounts for the strut and every run on that line at
   * once. The distance is taken from the box rather than from the page, so a
   * paragraph that has been dragged keeps the alignment instead of being pulled
   * back to where it was printed. */
  private alignBaseline(): void {
    const edit = this.edit, block = this.active, box = this.box;
    if (!edit || !block || !box) return;
    const layer = this.root.getBoundingClientRect();
    if (!layer.height) return;

    const sel = window.getSelection();
    const keep = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    const probe = document.createElement('i');
    probe.style.cssText = 'display:inline-block;width:0;height:0;overflow:hidden';
    edit.prepend(probe);
    const got = probe.getBoundingClientRect().bottom;
    probe.remove();
    if (keep && sel) { sel.removeAllRanges(); sel.addRange(keep); }
    if (!got) return;

    const want = box.getBoundingClientRect().top
      + (block.lines[0]!.baseline - block.y) * (layer.height / this.pageH);
    const dy = (Number(edit.dataset['dy']) || 0) + (want - got);
    edit.dataset['dy'] = String(dy);
    /* -1px is where the copy sits with no correction: flush with the frame's
       own rectangle, over its border. */
    edit.style.top = `${-1 + dy}px`;
  }

  /* How many lines the copy is on right now.
   *
   * Counted from the line boxes themselves rather than divided out of a height.
   * The copy is stretched to the frame so that a click anywhere inside it finds
   * the caret, which means its scrollHeight answers for the frame and not for
   * the text — and a paragraph whose frame happened to round up was reported as
   * one line longer for ever, so the widening loop ran all twelve of its steps
   * for no reason anyone could see. A range over the contents reports one
   * rectangle per run per line, and it is the distinct tops that are the lines. */
  private lineCount(): number {
    const edit = this.edit, block = this.active;
    if (!edit || !block) return 1;
    const lineH = parseFloat(getComputedStyle(edit).lineHeight)
      || (block.leading * this.ctx.scale()) || 1;
    const r = document.createRange();
    r.selectNodeContents(edit);
    const tops: number[] = [];
    for (const rect of r.getClientRects()) {
      if (!rect.height) continue;
      /* Half a leading: two runs of different sizes on one line differ by the
         difference of their ascents, which is far less than that, and two lines
         differ by a whole one. */
      if (!tops.some(t => Math.abs(t - rect.top) < lineH * 0.5)) tops.push(rect.top);
    }
    return Math.max(1, tops.length);
  }

  /** The block grows downwards as it fills; nothing below it moves. */
  private grow(): void {
    const block = this.active;
    if (!this.box || !this.edit || !block) return;
    /* By the line, and by the same count the fit uses. Measured in pixels
       against an ink height, the first character typed into an untouched
       paragraph bought it a fraction of a line it had not asked for. */
    const now = this.lineCount();
    if (!this.fitted) this.fitted = now;
    if (now <= this.fitted) return;
    this.geom.h += (now - this.fitted) * block.leading;
    this.fitted = now;
    this.place(this.box, this.geom);
    this.box.classList.toggle('qb--over', this.overlapsNeighbour());
  }

  private overlapsNeighbour(): boolean {
    return this.blocks.some(b =>
      b.id !== this.active?.id
      && b.x < this.geom.x + this.geom.w && b.x + b.w > this.geom.x
      && b.y < this.geom.y + this.geom.h && b.y + b.h > this.geom.y);
  }

  /* ── moving and resizing ───────────────────────────────────────────────── */

  private bindGeometry(box: HTMLElement): void {
    box.addEventListener('pointerdown', e => {
      const t = e.target as HTMLElement;
      const grip = t.closest<HTMLElement>('.qb-h');
      /* While editing, the body belongs to the caret; only the grips move
         anything. While merely selected, the whole block is a handle. */
      if (!grip && this.editing) return;

      e.preventDefault();
      e.stopPropagation();
      /* Capture is an optimisation — it keeps the drag alive when the pointer
         leaves the page — and it throws on an id the browser does not consider
         active. Letting that exception through aborted the handler before the
         move listener was even attached, so the grip did nothing at all. */
      try { box.setPointerCapture(e.pointerId); } catch { /* not fatal */ }

      this.startDrag(box, e, (grip?.dataset['edge'] as Handle | undefined) ?? null);
    });
  }

  /* One drag, whoever started it — the press that opened the block, a grip, or
     the body of a selected block. */
  private startDrag(box: HTMLElement, e: PointerEvent, edgeIn: Handle | null): void {
    const fromClient = {x: e.clientX, y: e.clientY};
    const edge = edgeIn ?? undefined;
    const id = e.pointerId;
    /* Nothing is moved, snapshotted or lifted yet. A press is not a drag: the
       block only starts following the pointer once it has travelled far enough
       to be a deliberate gesture, which is what stops a click from nudging a
       paragraph out of place.
     *
     * The two reference points are taken at different moments, and the reason
     * is that they answer different questions. The geometry is read when the
     * drag goes live: the press that opens a paragraph arms this before the
     * document's own fonts have landed and before the lift refits the box, so a
     * geometry captured at the press would be a frame out of date. The pointer
     * origin is the press, because the press is where the cursor took hold and
     * nothing can change that afterwards. Taking both at the threshold threw
     * away every pixel the pointer had already travelled — a drag out and back
     * to the press point left the paragraph a hundred pixels from where it
     * started, and even the gentlest drag was three pixels out. */
    let live = false;
    let start = this.geom;
    let startCover = this.covers;
    let from = this.pointAt(fromClient.x, fromClient.y);

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      if (!live) {
        const moved = Math.hypot(ev.clientX - fromClient.x, ev.clientY - fromClient.y);
        if (moved < 3) return;
        live = true;
        /* Lifted first. The paragraph leaves the page here, not before: until it
           moves, the printed words are still the right ones to be looking at —
           and lifting is what allows the box to be fitted to the copy, so a
           geometry read before it would be a frame out of date and the block
           would jump by the fit on the first pixel of movement. */
        this.lift();
        this.dragging = true;
        start = {...this.geom};
        startCover = {...this.covers};
        this.snap(true);
      }
      const p = this.pointOf(ev);
      const dx = p.x - from.x;
      const dy = p.y - from.y;
      this.geom = edge ? resize(start, edge, dx, dy) : {...start, x: start.x + dx, y: start.y + dy};
      this.place(box, this.geom);
      /* The patch grows and shrinks with the grips, and stays put for a move.
         Dragging the bottom edge down is the one way to say "cover the line
         below as well", and until the patch listened to it the gesture had no
         result of any kind. */
      if (edge) {
        this.covers = resize(startCover, edge, dx, dy);
        if (this.cover) this.place(this.cover, BlockLayer.coverRect(this.covers));
      }
      box.classList.toggle('qb--over', this.overlapsNeighbour());
    };

    /* Bound to the window, not to the box.
     *
     * The press that opens a paragraph lands on its dotted frame, and that
     * frame is removed and replaced by the editing box in the same tick — so a
     * pointerup listener on the box never hears the release, the move listener
     * is never taken off, and the paragraph follows the cursor with no button
     * held down. The window hears every release there is. */
    const detach = () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', stop, true);
      window.removeEventListener('pointercancel', stop, true);
      window.removeEventListener('keydown', onKey, true);
      this.dragCancel = null;
      try { box.releasePointerCapture(id); } catch { /* never captured */ }
    };

    const stop = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      detach();
      if (!this.dragging) return;
      this.dragging = false;
      /* Whatever the faces settled into while the block was under the pointer
         is taken account of now, when there is no reference geometry left to
         invalidate. */
      this.fitToContent();
    };

    /* Escape means "forget this drag", not "I am finished with this paragraph".
     *
     * It used to mean the second, because the key handler on the box only knew
     * how to close and save — so pressing it half way through a move wrote the
     * half-moved paragraph into the page and retired the frame, which is the
     * opposite of what the key is for everywhere else. The geometry the drag
     * started from is right here in the closure; putting it back is all the
     * cancel ever needed. */
    const cancel = () => {
      if (!this.dragging) { detach(); return; }
      this.dragging = false;
      this.geom = {...start};
      this.place(box, this.geom);
      box.classList.remove('qb--over');
      detach();
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape' || !this.dragging) return;
      ev.preventDefault();
      ev.stopPropagation();
      cancel();
    };

    this.dragCancel = cancel;
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', stop, true);
    window.addEventListener('pointercancel', stop, true);
    window.addEventListener('keydown', onKey, true);
  }

  private pointOf(e: PointerEvent): Pt {
    return this.pointAt(e.clientX, e.clientY);
  }

  /** The same conversion, for a position remembered rather than delivered. */
  private pointAt(clientX: number, clientY: number): Pt {
    const r = this.root.getBoundingClientRect();
    return {
      x: ((clientX - r.left) / r.width) * this.pageW,
      y: ((clientY - r.top) / r.height) * this.pageH,
    };
  }

  /* ── closing ───────────────────────────────────────────────────────────── */

  /** Save or abandon the open block. Returns once it is closed. */
  async close(save: boolean): Promise<void> {
    const block = this.active;
    if (!block) return;

    if (!save && this.changed()) {
      /* Escape does not throw work away without asking. Losing a paragraph you
         have just rewritten because you reached for the wrong key is a bad
         trade for one keystroke's convenience. */
      const discard = await this.ctx.confirmDiscard();
      if (!discard) return;
    }

    /* Measured once more against whatever is actually on screen.
     *
     * The correction travels into the file, and a paragraph closed in the few
     * frames before the document's faces settled would otherwise export a
     * spacing solved for Helvetica sitting on the page's own typeface. It
     * cannot make an untouched block look changed: changed() compares words and
     * geometry, and calibrate leaves a run alone once its words have been typed
     * over. */
    if (this.edit) this.calibrate(this.edit);
    const runs = save && this.changed() ? this.readBack() : null;
    const html = this.edit?.innerHTML ?? null;
    const geom = {...this.geom};
    this.active = null;
    this.box = null;
    this.edit = null;
    this.picked = null;
    document.removeEventListener('selectionchange', this.onSelectionChange, true);
    this.cover?.remove();
    this.cover = null;
    this.editing = false;
    this.ctx.report(null);

    if (runs?.length && html) {
      const b = block;
      this.ctx.beforeEdit('editing text');
      /* The cover has to clear the original, not merely match it: glyphs
         overhang the box the file reports, and a tight rectangle leaves a
         hairline of the old words showing along the edge. It is always the
         paragraph's *first* position — a block that has been moved twice still
         has only one set of original words to hide. */
      const ids = this.ctx.commit(
        this.pageNo,
        /* The same rectangle the live cover used, so what the commit paints is
           what the drag showed. */
        BlockLayer.coverRect(this.covers),
        this.sample(b),
        runs,
      );
      /* Kept, not retired.
       *
       * The first version dropped the paragraph from the list once it had been
       * written out, on the reasoning that its words were no longer on the
       * page. But they are — they are the words you just typed — and a
       * paragraph you can edit once and never again is not an editor. So the
       * marks it produced are remembered, and opening it again takes them back
       * off the page and hands you the text as you left it. */
      edited.set(editKey(this.pageNo, b.id),
                 {ids, html, geom: {...geom}, scale: this.ctx.scale()});
    }
    this.render();
  }

  get isOpen(): boolean { return !!this.active; }

  /* Reading the edited text back out, one piece per style per line.
   *
   * Walking characters and grouping them by where they landed is slower than
   * reading the spans directly, but it is the only way to know where the text
   * actually broke: the browser re-wraps as you type, and a span that started
   * as one line can end as three. It runs once, when the block closes. */
  private readBack(): CommitRun[] {
    const edit = this.edit;
    if (!edit) return [];
    const layer = this.root.getBoundingClientRect();
    if (!layer.width) return [];

    const toPage = (x: number, y: number): Pt => ({
      x: ((x - layer.left) / layer.width) * this.pageW,
      y: ((y - layer.top) / layer.height) * this.pageH,
    });

    /* `left`/`right` bound everything the piece occupies, spaces included, and
       set where the next piece begins. `inkLeft`/`inkRight` bound only what
       gets drawn, and set how wide it has to be drawn: a run's trailing space
       is part of the advance but not part of the word. */
    type Piece = {text: string; size: number; font: FontId; face?: string; color: string;
                  track: number; top: number; base: number; left: number; right: number;
                  inkLeft: number; inkRight: number};
    /* Screen pixels back to page units, taken from the layer that was actually
       measured rather than from the zoom it was asked for. Positions already go
       through the layer's own width; a second, slightly different number for
       the widths was a systematic stretch in the opposite direction to the
       position error, so a long line's right edge could never close. */
    const perUnit = layer.width / this.pageW || this.ctx.scale() || 1;
    const pieces: Piece[] = [];
    const walk = document.createTreeWalker(edit, NodeFilter.SHOW_TEXT);
    const range = document.createRange();

    /* Text that has no position of its own, waiting to be attached to the next
     * piece that has one.
     *
     * The space joining two wrapped lines is inserted as a text node of its own,
     * and at a wrap point a space measures as nothing at all — no width, no
     * height, no position. Pushed as a piece it landed at NaN, sorted into a
     * group of its own, and took its width out of the line it belonged to. The
     * two runs it was separating then came out touching in the file while
     * looking correctly spaced on screen, which is precisely the defect that
     * survived three attempts at fixing the layout instead. */
    let carry = '';

    for (let node = walk.nextNode(); node; node = walk.nextNode()) {
      const text = node.textContent ?? '';
      if (!text) continue;
      const host = node.parentElement;
      const size = Number(host?.dataset['size']) || 12;
      const font = (host?.dataset['font'] as FontId) || 'helvetica';
      const rawFace = host?.dataset['face'] || undefined;
      /* The fallback id doubles as the face slot for spans that never had a
         real one; only a name the registry knows is worth writing out. */
      const face = rawFace && docFace(rawFace) ? rawFace : undefined;
      const color = host?.dataset['color'] || '#111111';
      /* What calibrate() had to add or take away per character to make this run
         as wide as the file says it was printed. It has to travel with the run:
         drop it and the words come back a few per cent wider than the ones they
         replaced, which is the whole of "the text still shifts". */
      const track = host && host !== edit
        ? (parseFloat(getComputedStyle(host).letterSpacing) || 0) / perUnit
        : 0;

      /* How far the baseline sits below the top of this run's rectangle.
       *
       * A range's rectangle runs from the ascender to the descender of the face
       * it is set in, so its top is the baseline less the ascent — measured,
       * because the ascent is a property of the face and every face has a
       * different one. The writer used to assume 1.02 of the type size, which
       * is not the ascent of anything: Arial's is 0.91, Times New Roman's 0.89.
       * That tenth of a size is how far every rewritten paragraph sank. */
      const cs = host && host !== edit ? getComputedStyle(host) : null;
      RULER.font = cs
        ? `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
        : `${size * perUnit}px sans-serif`;
      const m = RULER.measureText('H');
      /* 0.91 only where the browser will not report a font box at all — the
         ascent of Arial, which is the family most of these substitutions land
         in. It is a worse answer than the measurement and a far better one than
         the ink height of an H, which is the cap height and a fifth short. */
      const asc = m.fontBoundingBoxAscent
        || (parseFloat(cs?.fontSize ?? '0') || size * perUnit) * 0.91;

      let piece = '';
      let top = NaN;
      let left = 0;
      let right = 0;
      let inkLeft = NaN;
      let inkRight = 0;

      const flush = () => {
        if (piece) {
          pieces.push({text: carry + piece, size, font, face, color, track,
                       top, base: top + asc, left, right,
                       inkLeft: Number.isNaN(inkLeft) ? left : inkLeft, inkRight});
          carry = '';
        }
        piece = '';
        inkLeft = NaN;
        inkRight = 0;
      };

      for (let i = 0; i < text.length; i++) {
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        const r = range.getBoundingClientRect();
        /* A space at a wrap point measures as nothing. It still belongs to the
           text, so it is carried along — but it cannot be allowed to be the
           thing that fixes the piece's position, or the piece is filed at NaN
           and sorts into whichever line the comparison happens to favour.
         *
         * Width alone decides that, not width and height together. The space
         * joining two wrapped lines is collapsed to no width but still reports
         * the height of the line box it sits at the end of — so the stricter
         * test let it keep a position, and a position it kept: filed as a line
         * of its own, dropped for having no printable text, and its two
         * neighbours merged straight into each other. That is where
         * "US/Canadian dispatch" came out of the file as "US/Canadiandispatch". */
        if (!r.width) { piece += text[i]; continue; }
        if (Number.isNaN(top)) {
          top = r.top;
          left = r.left;
        } else if (Math.abs(r.top - top) > 3) {
          /* Three pixels, not one and a half: subpixel layout jitter reported
             the last letter of a line a hair lower than the rest, and the
             split turned "Developer" into "Develope" and a stray "r". */
          flush();
          top = r.top;
          left = r.left;
        }
        right = r.right;
        if ((text[i] ?? '').trim()) {
          if (Number.isNaN(inkLeft)) inkLeft = r.left;
          inkRight = r.right;
        }
        piece += text[i];
      }
      /* A node the browser gave no position to at all — the joining space at a
         wrap — is carried to whichever piece comes next rather than filed on
         its own at nowhere. */
      if (Number.isNaN(top)) { carry += piece; piece = ''; } else flush();
    }

    /* A piece that is nothing but space belongs to the piece before it.
     *
     * The space that joins two wrapped lines is a text node of its own, so it
     * is set in the box's own font rather than the run's — a taller line box,
     * sitting a few pixels off the text it separates. Grouped by position it
     * therefore became a line of its own: dropped for having nothing to print,
     * and its neighbours left to merge straight into one another. That is where
     * "US/Canadian dispatch" came out of the file as "US/Canadiandispatch".
     *
     * Merged here, in document order, before position has any say: a space
     * belongs where it was typed, not where it was measured. */
    for (let i = pieces.length - 1; i > 0; i--) {
      if (pieces[i]!.text.trim()) continue;
      pieces[i - 1]!.text += pieces[i]!.text;
      /* The advance grows to cover the space; what has to be drawn does not. */
      pieces[i - 1]!.right = Math.max(pieces[i - 1]!.right, pieces[i]!.right);
      pieces.splice(i, 1);
    }

    /* Where each piece starts is not where it was measured.
     *
     * On screen every run is stretched by letter-spacing so it matches the
     * width the original document reported; in the file it is drawn in a
     * standard face at its natural width. Keep the measured positions and the
     * two disagree — a run that is wider in Helvetica than it was in the
     * document's own font runs straight into the one after it, which is what
     * produced "fivd shipped" and "developeRutaLive" in the export.
     *
     * So only the first piece of each line keeps its measured position. The
     * rest follow it, each advanced by the width it will actually be drawn at.
     * A line then reads correctly whatever the original was set in — its right
     * edge may fall a little short or long, and that is the honest trade. */
    /* Grouped by baseline, which is the thing runs of different sizes actually
       share. Grouped by the top of the box instead, a twelve-point word beside
       nine-point text sat further from its neighbours than the tolerance
       allowed and was filed as a line of its own, starting at its own left
       margin — a date beside a job title, a bold lead-in on a bullet. */
    const lines: Piece[][] = [];
    for (const p of pieces.sort((m, n) => m.base - n.base || m.left - n.left)) {
      const line = lines.find(l => Math.abs(l[0]!.base - p.base) < 1.5);
      if (line) line.push(p); else lines.push([p]);
    }
    /* Sorted again, by position along the line rather than by which of them the
       browser happened to report a hair higher. Lines are grouped with a
       tolerance but ordered exactly, so a trailing space measured a fifth of a
       pixel above its neighbours came out first — and being first is what sets
       the line's starting position. Every line after the first was starting
       from the right-hand margin of the one above it. */
    for (const line of lines) line.sort((m, n) => m.left - n.left);

    /* Neighbouring pieces in the same style are one run. The walker splits on
       every text node, so a line arrives as a dozen fragments; writing each as
       its own annotation multiplied the marks and let rounding pull letters of
       one word apart. Merged, a line is usually one or two runs. */
    for (const line of lines) {
      for (let i = line.length - 1; i > 0; i--) {
        const a = line[i - 1]!, b = line[i]!;
        if (a.size === b.size && a.font === b.font && a.color === b.color
            && (a.face ?? '') === (b.face ?? '')
            && Math.abs(a.track - b.track) < 0.01) {
          a.text += b.text;
          /* The merged piece has to answer for the whole of what it now holds:
             its measured width is what the spacing is worked out from. */
          a.right = Math.max(a.right, b.right);
          if (b.text.trim()) {
            if (!a.text.slice(0, a.text.length - b.text.length).trim()) a.inkLeft = b.inkLeft;
            a.inkRight = Math.max(a.inkRight, b.inkRight);
          }
          line.splice(i, 1);
        }
      }
    }

    const out: CommitRun[] = [];
    for (const line of lines) {
      const first = line[0]!;
      /* No line begins with a space. The one carried down from the wrap above
         is in the text so the two lines do not read as one word; on the page
         the break already separates them, and honouring it here would indent
         every wrapped line by a space. */
      first.text = first.text.replace(/^\s+/, '');
      if (!first.text) { line.shift(); if (!line.length) continue; }
      const start = toPage(first.left, first.top);
      /* Only the start of the line is measured; the runs on it follow one
       * another in the metrics of the face they will be *drawn* in.
       *
       * Keeping each run's measured position looks right on screen and comes
       * out jammed in the file, and the reason is the font. The block is edited
       * in the document's own face — that is what makes opening a paragraph
       * look like editing rather than replacing — but the file is written in
       * one of the standard fourteen, which is a different width for the same
       * words. Measured positions are therefore in the wrong units the moment
       * they leave the screen. Advancing by the drawn width instead costs a
       * line its exact right-hand edge and gains it every space in between. */
      let x = start.x;
      for (const p of line) {
        /* How wide this piece has to come out, and what it would come out at
         * left alone.
         *
         * The screen is the reference, because the screen was calibrated to the
         * file: each run was stretched until it was as wide as the document
         * says it was printed. The writer, though, may not be setting it in the
         * same face — a face whose bytes pdf.js could not hand over is drawn in
         * one of the standard fourteen instead, and Helvetica is a fifth wider
         * than the mono a contact line was set in. So the spacing is worked out
         * against the face that will actually draw it, and the run lands on the
         * width it is replacing whether or not its own typeface survived. */
        const usable = p.face && docFace(p.face)?.bytes ? docFace(p.face) : null;
        const body = p.text.trim();
        /* From the first inked pixel to the last, and that is the whole advance
           already: the browser puts the letter-space *inside* each character's
           advance box, so the rectangle runs from the first pen position to the
           position after the last glyph and its spacing — which is exactly what
           the PDF's character spacing will reproduce. Adding one more by hand
           overshot every tracked run by a whole letter-space, worst on the short
           ones this feature exists to preserve. */
        const wanted = (p.inkRight - p.inkLeft) / perUnit;
        const natural = drawnWidth(body, p.size, p.font, 0, usable?.cssKey);
        const cap = p.size * 0.4;
        const track = body.length > 1 && wanted > 0
          ? Math.max(-cap, Math.min(cap, (wanted - natural) / body.length))
          : 0;

        if (body) {
          out.push({
            /* Measured, not computed: where the words begin is something the
               browser already worked out, and re-deriving it from font metrics
               only introduces a second opinion. */
            text: body,
            at: {x: x + (p.inkLeft - p.left) / perUnit, y: start.y},
            size: p.size, font: p.font, face: p.face, color: p.color,
            /* The line keeps one y — the frame is drawn from it — while each run
               carries its own baseline down to the writer, so two sizes on one
               line stay on the line they shared. */
            lead: (p.base - first.top) / perUnit,
            ink: wanted,
            ...(Math.abs(track) > 0.001 ? {tracking: track} : {}),
          });
        }
        x += (p.right - p.left) / perUnit;
      }
    }
    return out;
  }

  /* ── the page underneath ───────────────────────────────────────────────── */

  /** The colour of the paper around a block, read off the rendered page. */
  private sample(b: {x: number; y: number; w: number; h: number}): string {
    const canvas = this.root.parentElement?.querySelector('canvas');
    if (!canvas) return '#ffffff';
    const ctx = canvas.getContext('2d', {willReadFrequently: true});
    if (!ctx) return '#ffffff';

    const sx = canvas.width / this.pageW;
    const sy = canvas.height / this.pageH;
    /* Points just outside the box on all four sides, plus two inside the gaps
       between lines. The perimeter alone gets it wrong inside a table, where
       three pixels out is the rule rather than the paper. */
    const probes: Array<[number, number]> = [
      [b.x - 3, b.y - 3], [b.x + b.w + 3, b.y - 3],
      [b.x - 3, b.y + b.h + 3], [b.x + b.w + 3, b.y + b.h + 3],
      [b.x + b.w / 2, b.y - 3], [b.x + b.w / 2, b.y + b.h + 3],
      [b.x - 3, b.y + b.h / 2], [b.x + b.w + 3, b.y + b.h / 2],
    ];

    const seen: Array<[number, number, number]> = [];
    for (const [px, py] of probes) {
      const cx = Math.round(px * sx);
      const cy = Math.round(py * sy);
      if (cx < 0 || cy < 0 || cx >= canvas.width || cy >= canvas.height) continue;
      try {
        const d = ctx.getImageData(cx, cy, 1, 1).data;
        seen.push([d[0]!, d[1]!, d[2]!]);
      } catch { /* a tainted canvas cannot be read; fall through to white */ }
    }
    if (!seen.length) return '#ffffff';

    const mid = (i: 0 | 1 | 2) => {
      const v = seen.map(c => c[i]).sort((m, n) => m - n);
      return v[Math.floor((v.length - 1) / 2)]!;
    };
    const [r, g, bl] = [mid(0), mid(1), mid(2)];
    /* Uniform enough to be paper? If the samples disagree there is a picture or
       a rule under the block, and painting over it would be worse than leaving
       the old text showing — so we default to white and say nothing louder than
       that. */
    const spread = Math.max(...seen.map(c => Math.max(
      Math.abs(c[0] - r), Math.abs(c[1] - g), Math.abs(c[2] - bl))));
    if (spread > 24) return '#ffffff';
    return `#${[r, g, bl].map(n => n.toString(16).padStart(2, '0')).join('')}`;
  }

  /* The colour the page actually printed a run in.
   *
   * core/blocks.ts reads where the words are and what face they are in, not
   * what colour they were — pdf.js's text content does not report a fill at
   * all — so every run was handed the interface's near-black. Black text
   * therefore lightened the instant it was lifted, and a grey caption or a
   * coloured heading turned near-black on the way into the file, which is the
   * most conspicuous possible way for replacement text not to match what it
   * replaced. The rendered page has the answer and is already being read for
   * the paper colour, so it is read once more for the ink.
   *
   * Deliberately timid. The darkest pixel over a run is its ink only if the run
   * is dark type on light paper and the raster actually holds a solid core of
   * it; anything else — a tinted ground, type too small to have a solid pixel,
   * a canvas that cannot be read — keeps the near-black it has always used,
   * because a confidently wrong colour is worse than a slightly grey one. */
  private inkReader(b: Block): (run: Run, line: Line) => string {
    const dull = () => '#111111';
    const canvas = this.root.parentElement?.querySelector('canvas');
    const ctx = canvas?.getContext('2d', {willReadFrequently: true}) ?? null;
    if (!canvas || !ctx) return dull;

    const lum = (r: number, g: number, bl: number) => 0.299 * r + 0.587 * g + 0.114 * bl;
    const paper = this.sample(b);
    const pr = parseInt(paper.slice(1, 3), 16), pg = parseInt(paper.slice(3, 5), 16),
          pb = parseInt(paper.slice(5, 7), 16);
    /* Light paper only. On anything darker there is no telling the ink from the
       ground by luminance, and guessing would recolour the page. */
    if (!(lum(pr, pg, pb) > 150)) return dull;

    const sx = canvas.width / this.pageW;
    const sy = canvas.height / this.pageH;
    const x0 = Math.max(0, Math.floor(b.x * sx));
    const y0 = Math.max(0, Math.floor(b.y * sy));
    const x1 = Math.min(canvas.width, Math.ceil((b.x + b.w) * sx));
    const y1 = Math.min(canvas.height, Math.ceil((b.y + b.h) * sy));
    if (x1 - x0 < 2 || y1 - y0 < 2) return dull;

    let img: ImageData;
    try { img = ctx.getImageData(x0, y0, x1 - x0, y1 - y0); }
    catch { return dull; /* a tainted canvas cannot be read */ }
    const px = img.data;
    const wide = x1 - x0;

    return (run, line) => {
      /* The run's own rectangle: its advance across, ascender to descender
         down, so the sample cannot pick up the line above or the rule below. */
      const rx0 = Math.max(x0, Math.floor(run.x * sx)) - x0;
      const rx1 = Math.min(x1, Math.ceil((run.x + run.w) * sx)) - x0;
      const ry0 = Math.max(y0, Math.floor((line.baseline - run.size * 0.9) * sy)) - y0;
      const ry1 = Math.min(y1, Math.ceil((line.baseline + run.size * 0.25) * sy)) - y0;
      if (rx1 - rx0 < 1 || ry1 - ry0 < 1) return '#111111';

      let best = 255, br = 0, bg = 0, bb = 0;
      for (let y = ry0; y < ry1; y++) {
        for (let x = rx0; x < rx1; x++) {
          const i = (y * wide + x) * 4;
          const l = lum(px[i]!, px[i + 1]!, px[i + 2]!);
          if (l < best) { best = l; br = px[i]!; bg = px[i + 1]!; bb = px[i + 2]!; }
        }
      }
      /* A plateau, not a single pixel. One dark pixel is as likely to be the
         corner of a rule or a speck of antialiasing as it is to be ink; a
         handful of pixels at the same darkness is the inside of a stem. */
      if (best > lum(pr, pg, pb) - 40) return '#111111';
      let core = 0;
      for (let y = ry0; y < ry1 && core < 6; y++) {
        for (let x = rx0; x < rx1 && core < 6; x++) {
          const i = (y * wide + x) * 4;
          if (lum(px[i]!, px[i + 1]!, px[i + 2]!) <= best + 8) core++;
        }
      }
      if (core < 6) return '#111111';
      return `#${[br, bg, bb].map(n => n.toString(16).padStart(2, '0')).join('')}`;
    };
  }
}

function resize(
  start: {x: number; y: number; w: number; h: number},
  edge: Handle, dx: number, dy: number,
): {x: number; y: number; w: number; h: number} {
  let {x, y, w, h} = start;
  if (edge.includes('w')) { x += dx; w -= dx; }
  if (edge.includes('e')) { w += dx; }
  if (edge.includes('n')) { y += dy; h -= dy; }
  if (edge.includes('s')) { h += dy; }
  /* A block narrower than a word cannot hold anything, and a negative one
     inverts itself under the cursor. */
  if (w < 12) { w = 12; }
  if (h < 8) { h = 8; }
  return {x, y, w, h};
}
