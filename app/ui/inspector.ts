import type {Annot, FontId, ToolId} from '../core/annots';
import {isBold, isItalic} from '../core/annots';
import {docFaces, siblingFace} from '../core/docFonts';
import type {ToolSettings} from './overlay';

/* The right-hand panel. It shows only the controls the current tool actually
   uses — a colour picker beside the crop tool is noise, and noise is what makes
   a toolbar feel like a settings dialog.
 *
 * Two jobs, not one. With nothing selected the controls set the defaults for
 * the next mark; with a mark selected they restyle that mark, live. The second
 * job used to be missing entirely, which is why picking red with a text mark
 * selected changed the panel and nothing else — the least explicable kind of
 * control there is. `apply` is the bridge: main.ts decides what a change does
 * to the selection, the panel only reports that it happened. */

interface Row { id: string; tools: ToolId[] }

const ROWS: Row[] = [
  {id: 'insColor', tools: ['select', 'text', 'edit-text', 'draw', 'highlight', 'shape', 'stamp']},
  {id: 'insWidth', tools: ['draw', 'highlight', 'shape', 'eraser']},
  {id: 'insSize',  tools: ['select', 'text', 'edit-text']},
  {id: 'insTrack', tools: ['edit-text']},
  {id: 'insFont',  tools: ['select', 'text', 'edit-text']},
  {id: 'insStyle', tools: ['select', 'text', 'edit-text']},
  {id: 'insShape', tools: ['shape']},
  {id: 'insStamp', tools: ['stamp']},
  {id: 'insField', tools: ['field']},
  {id: 'insSign',  tools: ['sign']},
  {id: 'insCrop',  tools: ['crop']},
];

/* Rows that only make sense against a selected mark. Under Select with nothing
   picked they would be controls aimed at nothing. */
const NEED_SELECTION = new Set(['insColor', 'insSize', 'insFont', 'insStyle']);

const HINTS: Partial<Record<ToolId, string>> = {
  select: 'Click a mark to move or resize it. Press Delete to remove it.',
  text: 'Click where the text should start, then type. This adds new text of your own.',
  'edit-text': 'Every paragraph gets a frame. Click one to select it, double-click to rewrite it.',
  draw: 'Draw freehand. Hold and drag.',
  eraser: 'Drag over your own marks to rub them out. The circle shows the nib; the slider sets its size. It never touches the original page — that is what Redact is for.',
  highlight: 'Drag across a line to mark it.',
  shape: 'Drag to draw. Hold near a corner of an existing shape to resize it.',
  image: 'Click the page, then choose a picture.',
  link: 'Drag over the area that should be clickable, then enter the address.',
  sign: 'Click the page to place your signature. Make or change it with the button below.',
  stamp: 'Click where the stamp belongs.',
  redact: 'Drag over anything that must not survive. On export the page is replaced by a picture of itself, so the text underneath is gone for real.',
  field: 'Drag out a box. It becomes a real form field you can fill in any PDF reader.',
  crop: 'Drag the area you want to keep. Everything outside it is trimmed.',
};

const LABEL: Partial<Record<ToolId, string>> = {
  select: 'Select', text: 'Add text', 'edit-text': 'Edit text', draw: 'Draw',
  eraser: 'Eraser', highlight: 'Highlight', shape: 'Shapes', image: 'Image',
  link: 'Link', sign: 'Sign', stamp: 'Stamp', redact: 'Redact', field: 'Fields',
  crop: 'Crop',
};

/** What a change from the panel means. main.ts routes it to the settings, the
 *  selected mark, or both. */
export interface StyleChange {
  color?: string;
  size?: number;
  width?: number;
  font?: FontId;
  /** Document face by name; null clears it back to the standard family. */
  face?: string | null;
  bold?: boolean;
  italic?: boolean;
  /** Extra advance per character, in points. */
  track?: number;
}

const $ = (id: string) => document.getElementById(id);

export class Inspector {
  constructor(
    private readonly settings: ToolSettings,
    private readonly apply: (change: StyleChange) => void,
  ) {
    /* Highlight keeps a separate colour from the pen — ink wants to be dark, a
       marker light enough to read through. Sharing one value meant each tool
       silently reconfigured the other. */
    this.pick('swatches', '[data-color]', el => {
      const colour = el.dataset['color']!;
      if (this.tool === 'highlight') this.settings.highlightColor = colour;
      else this.settings.color = colour;
      this.apply({color: colour});
    });

    const custom = $('swCustom') as HTMLInputElement | null;
    custom?.addEventListener('input', () => {
      const colour = custom.value;
      if (this.tool === 'highlight') this.settings.highlightColor = colour;
      else this.settings.color = colour;
      this.apply({color: colour});
    });

    const font = $('fontPick') as HTMLSelectElement | null;
    font?.addEventListener('change', () => {
      const v = font.value;
      if (v.startsWith('face:')) {
        this.apply({face: v.slice(5)});
      } else {
        this.settings.font = v as FontId;
        this.apply({font: v as FontId, face: null});
      }
    });

    /* A number you can read and type beats a slider you have to decode. The
       presets live in a datalist, so the common sizes are one click and the
       odd ones are still reachable. */
    const size = $('sizeBox') as HTMLInputElement | null;
    size?.addEventListener('change', () => {
      if (!size.value.trim()) return;
      const v = Math.min(1000, Math.max(1, Number(size.value) || 14));
      size.value = String(v);
      this.settings.fontSize = v;
      this.apply({size: v});
    });

    /* Blank is not zero. A selection running through two spacings has none to
       show, and typing nothing into the box must not silently set it flat. */
    const track = $('trackBox') as HTMLInputElement | null;
    track?.addEventListener('change', () => {
      if (!track.value.trim()) return;
      const v = Math.min(50, Math.max(-20, Number(track.value) || 0));
      track.value = String(v);
      this.apply({track: v});
    });

    $('btnBold')?.addEventListener('click', () => this.toggle('bold'));
    $('btnItalic')?.addEventListener('click', () => this.toggle('italic'));

    this.pick('shapePick', '[data-shape]', el => { this.settings.shape = el.dataset['shape'] as ToolSettings['shape']; this.apply({}); });
    this.pick('stampPick', '[data-stamp]', el => { this.settings.stampLabel = el.dataset['stamp']!; this.apply({}); });
    this.pick('fieldPick', '[data-field]', el => { this.settings.fieldType = el.dataset['field'] as ToolSettings['fieldType']; this.apply({}); });

    const width = $('rangeWidth') as HTMLInputElement | null;
    width?.addEventListener('input', () => {
      const v = Number(width.value);
      this.settings.width = v;
      const label = $('widthVal');
      if (label) label.textContent = String(v);
      this.apply({width: v});
    });

    const fill = $('shapeFill') as HTMLInputElement | null;
    fill?.addEventListener('change', () => { this.settings.filled = fill.checked; this.apply({}); });
  }

  private toggle(which: 'bold' | 'italic'): void {
    const btn = $(which === 'bold' ? 'btnBold' : 'btnItalic');
    const on = btn?.getAttribute('aria-pressed') !== 'true';
    btn?.setAttribute('aria-pressed', String(on));
    this.apply(which === 'bold' ? {bold: on} : {italic: on});
  }

  private pick(groupId: string, sel: string, apply: (el: HTMLElement) => void): void {
    const group = $(groupId);
    group?.addEventListener('click', e => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>(sel);
      if (!btn || !group.contains(btn)) return;
      for (const b of group.querySelectorAll(sel)) b.setAttribute('aria-pressed', String(b === btn));
      apply(btn);
    });
  }

  private tool: ToolId = 'select';

  /* What the panel currently claims. Filled from the selected mark when there
     is one, from the defaults when there is not — the fields must always show
     real values, never their initial markup. */
  reflect(state: {color: string; size: number | null; font: FontId; face: string | null;
                  mixedFont?: boolean; bold?: boolean; italic?: boolean;
                  track?: number | null}): void {
    const current = this.tool === 'highlight' ? this.settings.highlightColor : state.color;
    for (const b of document.querySelectorAll<HTMLElement>('#swatches .sw-c')) {
      b.setAttribute('aria-pressed', String(b.dataset['color'] === current));
    }
    const custom = $('swCustom') as HTMLInputElement | null;
    if (custom && /^#[0-9a-f]{6}$/i.test(current)) custom.value = current;

    const size = $('sizeBox') as HTMLInputElement | null;
    /* Blank rather than a lie: a selection spanning two sizes has no size, and
       showing one of them invites you to "keep" a value you never chose. */
    if (size) size.value = state.size === null ? '' : String(Math.round(state.size * 10) / 10);

    const track = $('trackBox') as HTMLInputElement | null;
    if (track && state.track !== undefined) {
      track.value = state.track === null ? '' : String(Math.round(state.track * 100) / 100);
    }

    const font = $('fontPick') as HTMLSelectElement | null;
    if (font) {
      /* A selection running through two typefaces has no typeface. Naming one
         of them would invite you to keep a setting you never chose, and the
         next click on anything else would silently apply it to the rest. */
      const mixed = font.querySelector<HTMLOptionElement>('option[value="mixed"]')
        ?? (() => { const o = document.createElement('option');
                    o.value = 'mixed'; o.textContent = '—'; o.disabled = true;
                    font.prepend(o); return o; })();
      mixed.hidden = !state.mixedFont;
      if (state.mixedFont) { font.value = 'mixed'; return; }
      const want = state.face ? `face:${state.face}` : state.font;
      if ([...font.options].some(o => o.value === want)) font.value = want;
      else font.value = state.font;
    }

    const bold = state.bold ?? (state.face ? /bold|black|heavy|semib/i.test(state.face) : isBold(state.font));
    const italic = state.italic ?? (state.face ? /italic|oblique/i.test(state.face) : isItalic(state.font));
    $('btnBold')?.setAttribute('aria-pressed', String(bold));
    $('btnItalic')?.setAttribute('aria-pressed', String(italic));
  }

  /** The document changed or loaded: rebuild the font menu around its faces. */
  refreshFonts(): void {
    const font = $('fontPick') as HTMLSelectElement | null;
    if (!font) return;
    const had = font.value;

    let group = font.querySelector<HTMLOptGroupElement>('optgroup[data-doc]');
    group?.remove();

    const faces = docFaces();
    if (faces.length) {
      group = document.createElement('optgroup');
      group.label = 'This document';
      group.dataset['doc'] = '1';
      for (const f of faces) {
        const o = document.createElement('option');
        o.value = `face:${f.name}`;
        o.textContent = f.name.replace(/[-_]/g, ' ');
        group.append(o);
      }
      /* The document's own faces first: they are what the page is set in, and
         what an edit should default to staying in. */
      font.prepend(group);
    }
    if ([...font.options].some(o => o.value === had)) font.value = had;
  }

  show(tool: ToolId, hasSelection: boolean, selected?: Annot | null): void {
    this.tool = tool;
    const title = $('inspTitle');
    const hint = $('inspHint');
    if (title) title.textContent = LABEL[tool] ?? 'Tool';
    if (hint) hint.textContent = HINTS[tool] ?? '';

    const textish = !!selected && selected.kind === 'text';
    for (const row of ROWS) {
      const el = $(row.id);
      if (!el) continue;
      let on = row.tools.includes(tool);
      if (on && tool === 'select' && NEED_SELECTION.has(row.id)) {
        /* Under Select the styling rows exist for the selected mark. Colour
           applies to anything that has one; size and font only to text. */
        on = row.id === 'insColor' ? hasSelection : textish;
      }
      (el as HTMLElement).hidden = !on;
    }

    /* The marker's palette, and the pen's, are not interchangeable. */
    const marker = tool === 'highlight';
    for (const b of document.querySelectorAll<HTMLElement>('#swatches .sw-c')) {
      const colour = (marker ? b.dataset['mark'] : b.dataset['ink']) ?? '#111111';
      b.dataset['color'] = colour;
      b.style.background = colour;
    }

    const del = $('deleteSel');
    if (del) (del as HTMLElement).hidden = !hasSelection;
  }
}

/** The bold/italic sibling of a face, when the document carries one. */
export function restyledFace(name: string, bold: boolean, italic: boolean): string | null {
  return siblingFace(name, bold, italic)?.name ?? null;
}
