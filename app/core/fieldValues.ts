/* What the user has typed into a form's own fields.
 *
 * A PDF form's fields already exist inside the file — they are not marks we
 * added, so they do not belong in the annotation store. Keeping them apart
 * matters at export: marks are drawn onto the page, field values are written
 * into the AcroForm, and confusing the two would either flatten a form that
 * should stay fillable or leave a filled form looking blank in Acrobat.
 *
 * Keyed by field name because that is what the PDF itself uses — the same name
 * can appear as several widgets across several pages (a signature block
 * repeated at the foot of every page, for instance), and typing into one of
 * them should fill all of them, exactly as a real reader does. */

export type FieldKind = 'text' | 'check' | 'radio' | 'choice';

export interface FieldBox {
  page: number;
  left: number; top: number; width: number; height: number;   // page points
}

export interface FieldValue {
  kind: FieldKind;
  /* Where the widget sits. Only needed by the flattening export, which has no
     AcroForm to write into and must draw the answer onto the page instead. */
  boxes?: FieldBox[];
  /** Text for text and choice fields; the export value for check and radio. */
  value: string;
  /** For checkboxes and radios: whether this option is the chosen one. */
  on?: boolean;
}

export class FieldStore {
  private values = new Map<string, FieldValue>();
  private listeners = new Set<(name: string) => void>();

  onChange(fn: (name: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /* Everything the user has touched, which is what the export has to act on:
     a box they unticked is a change to write, not an absence of one — the file
     may well have had it ticked to begin with. */
  get size(): number { return this.values.size; }

  /* What is actually written in, which is what the panel should show. Unticking
     a box you ticked by accident ought to take the counter back down; going by
     `size` it would not, and a number that only ever climbs is a number nobody
     trusts. */
  get filled(): number {
    let n = 0;
    for (const [, v] of this.values) {
      if (v.kind === 'check' || v.kind === 'radio' ? v.on : Boolean(v.value)) n++;
    }
    return n;
  }
  get entries(): Array<[string, FieldValue]> { return [...this.values]; }

  get(name: string): FieldValue | undefined { return this.values.get(name); }

  /* `seed` marks a value that came out of the file rather than out of a
     person. It still goes in the store — a part-completed form should open
     showing what is in it — but it must not count as an edit. It used to, and
     the consequence was that opening any form with a pre-filled field turned
     the document dirty on load, so the browser raised "Leave site?" on the
     way out of a document nobody had touched. */
  set(name: string, v: FieldValue, seed = false): void {
    /* An emptied text field is not the same as an untouched one only in
       theory — in the file both mean "no value", so clearing it clears the
       entry rather than storing an empty string that would still count as a
       change on the way out. */
    if (v.kind === 'text' && !v.value) this.values.delete(name);
    else this.values.set(name, v);
    if (!seed) for (const fn of this.listeners) fn(name);
  }

  clear(): void {
    const names = [...this.values.keys()];
    this.values.clear();
    for (const n of names) for (const fn of this.listeners) fn(n);
  }

  load(entries: Array<[string, FieldValue]>): void {
    this.values = new Map(entries);
    for (const [n] of entries) for (const fn of this.listeners) fn(n);
  }

  snapshot(): Array<[string, FieldValue]> {
    return this.entries.map(([n, v]) => [n, {...v}]);
  }
}
