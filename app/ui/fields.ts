import type {PDFPageProxy} from '../core/pdfjs';
import type {FieldStore, FieldKind, FieldBox} from '../core/fieldValues';

/* The form's own fields, made typeable.
 *
 * A fillable PDF already carries widget annotations describing where every box
 * is. pdf.js hands them over; this layer puts a real HTML input on top of each
 * one, tinted so you can see at a glance which parts of the page expect an
 * answer. That tint is the whole difference between a scanned-looking document
 * and one that obviously wants filling in.
 *
 * Positions come from the viewport rather than from the raw rectangle, because
 * a rotated page or a crop box with a non-zero origin would otherwise put every
 * box in the wrong place — and forms from tax agencies use both.
 *
 * Values live in the FieldStore, keyed by field name. Two widgets sharing a
 * name are the same field, so typing in one fills the other, exactly as a real
 * reader behaves. */

interface Widget {
  name: string;
  kind: FieldKind;
  left: number; top: number; width: number; height: number;   // page points
  readOnly: boolean;
  multiline: boolean;
  maxLen: number | null;
  /** For check and radio: the value this widget writes when it is on. */
  exportValue: string;
  /** For choice fields. */
  options: Array<{value: string; label: string}>;
  combo: boolean;
  initial: string;
}

export class FieldLayer {
  readonly root: HTMLElement;
  private widgets: Widget[] = [];

  constructor(
    private pageNo: number,
    private pageW: number,
    private pageH: number,
    private store: FieldStore,
    private ctx: {
      interactive(): boolean;
      scale(): number;
      touched(): void;
    },
  ) {
    this.root = document.createElement('div');
    this.root.className = 'fl';
  }

  /** Reads the widgets off the page. Safe to call on a page that has none. */
  async load(proxy: PDFPageProxy): Promise<void> {
    let annots: Array<Record<string, unknown>> = [];
    try {
      annots = (await proxy.getAnnotations()) as unknown as Array<Record<string, unknown>>;
    } catch {
      /* A form we cannot read the widgets of is still a document you can mark
         up by hand, so this fails quietly rather than taking the page with it. */
      return;
    }

    const vp = proxy.getViewport({scale: 1});
    this.widgets = [];

    for (const a of annots) {
      if (a['subtype'] !== 'Widget') continue;
      const fieldType = a['fieldType'] as string | undefined;
      if (!fieldType || a['hidden']) continue;
      if (a['pushButton']) continue;   // a button does nothing to fill in

      const kind: FieldKind =
        fieldType === 'Tx' ? 'text'
        : fieldType === 'Ch' ? 'choice'
        : a['radioButton'] ? 'radio'
        : 'check';

      /* Both corners are converted and then normalised: the viewport flips the
         y-axis, and a rotated page can swap x as well, so which corner comes
         out smaller is not something to assume. */
      const rect = a['rect'] as number[];
      const [ax, ay] = vp.convertToViewportPoint(rect[0]!, rect[1]!) as number[];
      const [bx, by] = vp.convertToViewportPoint(rect[2]!, rect[3]!) as number[];
      const left = Math.min(ax!, bx!);
      const top = Math.min(ay!, by!);
      const width = Math.abs(bx! - ax!);
      const height = Math.abs(by! - ay!);
      if (width < 3 || height < 3) continue;

      const raw = a['fieldValue'];
      const initial = Array.isArray(raw) ? String(raw[0] ?? '') : String(raw ?? '');
      /* A locked box with nothing in it is not a field, whatever the file
         calls it — government forms carry a few of these as leftovers, sitting
         two millimetres wide in the margin of an instructions page. Tinting
         them tells the reader to fill in something they cannot fill in. A
         locked box that does show something is worth keeping: it is usually a
         reference number the form filled in for itself. */
      if (a['readOnly'] && !initial) continue;

      this.widgets.push({
        name: String(a['fieldName'] ?? ''),
        kind, left, top, width, height,
        readOnly: Boolean(a['readOnly']),
        multiline: Boolean(a['multiLine']),
        maxLen: typeof a['maxLen'] === 'number' && a['maxLen'] > 0 ? a['maxLen'] as number : null,
        exportValue: String(a['exportValue'] ?? a['buttonValue'] ?? 'Yes'),
        options: ((a['options'] as Array<{exportValue?: string; displayValue?: string}>) ?? [])
          .map(o => ({value: String(o.exportValue ?? ''), label: String(o.displayValue ?? o.exportValue ?? '')})),
        combo: Boolean(a['combo']),
        initial,
      });
    }

    /* Seed the store from whatever the file already had in it, so a
       part-completed form opens showing what is in it rather than blank. */
    for (const w of this.widgets) {
      if (!w.initial || this.store.get(w.name)) continue;
      if (w.kind === 'text' || w.kind === 'choice') {
        this.store.set(w.name, {kind: w.kind, value: w.initial}, true);
      } else if (w.initial !== 'Off') {
        this.store.set(w.name, {kind: w.kind, value: w.initial, on: true}, true);
      }
    }

    this.render();
  }

  get count(): number { return this.widgets.length; }

  render(): void {
    this.root.replaceChildren();
    if (!this.widgets.length) return;

    const interactive = this.ctx.interactive();
    this.root.classList.toggle('fl--on', interactive);
    const scale = this.ctx.scale();

    for (const w of this.widgets) {
      const box = document.createElement(
        w.kind === 'choice' ? 'select' : w.kind === 'text' && w.multiline ? 'textarea' : 'input',
      ) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

      box.className = 'fl-f';
      box.dataset['name'] = w.name;
      box.style.left = `${(w.left / this.pageW) * 100}%`;
      box.style.top = `${(w.top / this.pageH) * 100}%`;
      box.style.width = `${(w.width / this.pageW) * 100}%`;
      box.style.height = `${(w.height / this.pageH) * 100}%`;
      box.title = w.name;

      if (w.readOnly) {
        box.classList.add('fl-f--locked');
        (box as HTMLInputElement).disabled = true;
      }

      const stored = this.store.get(w.name);

      if (w.kind === 'text') {
        const input = box as HTMLInputElement | HTMLTextAreaElement;
        if (input instanceof HTMLInputElement) input.type = 'text';
        if (w.maxLen) input.maxLength = w.maxLen;
        input.value = stored?.value ?? '';
        /* The type is sized to the box it sits in rather than to a fixed
           number, so a one-line box and a comment box both look right. */
        input.style.fontSize = `${Math.min(w.height * 0.62, 13) * scale}px`;
        input.addEventListener('input', () => {
          this.store.set(w.name, {kind: 'text', value: input.value, boxes: this.boxesFor(w)});
          this.mirror(w.name, input.value);
          this.ctx.touched();
        });
      } else if (w.kind === 'choice') {
        const sel = box as HTMLSelectElement;
        sel.style.fontSize = `${Math.min(w.height * 0.58, 12) * scale}px`;
        const blank = document.createElement('option');
        blank.value = ''; blank.textContent = '';
        sel.append(blank);
        for (const o of w.options) {
          const opt = document.createElement('option');
          opt.value = o.value; opt.textContent = o.label;
          sel.append(opt);
        }
        sel.value = stored?.value ?? '';
        sel.addEventListener('change', () => {
          this.store.set(w.name, {kind: 'choice', value: sel.value, boxes: this.boxesFor(w)});
          this.ctx.touched();
        });
      } else {
        const input = box as HTMLInputElement;
        input.type = w.kind === 'radio' ? 'radio' : 'checkbox';
        if (w.kind === 'radio') input.name = w.name;
        /* The tick is drawn in em, and this is what an em means here: the
           shorter side of the box. Percentages cannot do it — a percentage of
           the width and a percentage of the height are independent, so in a
           wide, short widget the mark stretched sideways and came out as a
           thick bar rather than a check. */
        input.style.fontSize = `${Math.min(w.width, w.height) * scale}px`;
        input.checked = Boolean(stored?.on && stored.value === w.exportValue);
        input.addEventListener('change', () => {
          this.store.set(w.name, {
            kind: w.kind, value: w.exportValue, on: input.checked, boxes: this.boxesFor(w),
          });
          this.ctx.touched();
        });
      }

      this.root.append(box);
    }
  }

  /* Every widget carrying this field's name, so a value repeated across pages
     is drawn in all of them when the document has to be flattened. */
  private boxesFor(w: Widget): FieldBox[] {
    return this.widgets
      .filter(x => x.name === w.name)
      .map(x => ({page: this.pageNo, left: x.left, top: x.top, width: x.width, height: x.height}));
  }

  /** Keeps the other widgets of the same field in step as you type. */
  private mirror(name: string, value: string): void {
    for (const el of this.root.querySelectorAll<HTMLInputElement>(`[data-name="${CSS.escape(name)}"]`)) {
      if (el.value !== value) el.value = value;
    }
  }
}
