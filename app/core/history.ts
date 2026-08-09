import type {Annot} from './annots';

/* Undo and redo.
 *
 * A snapshot is the file's bytes plus a deep copy of the marks — the two things
 * that together are the document. Storing bytes rather than a QuireDoc matters:
 * every live document holds a pdf.js worker, and keeping twenty of those alive
 * to support twenty undos would cost more memory than the file itself.
 *
 * Because every structural edit already produces a whole new file rather than
 * mutating one, this is a stack of past states rather than a log of inverse
 * operations — which is why cropping, deleting a page and rotating all become
 * undoable without any of them knowing that undo exists. */

export interface Snapshot {
  bytes: Uint8Array;
  annots: Annot[];
  label: string;
  /* Which revision of the file these bytes are.
   *
   * Most of what gets undone never touched the file: a highlight, a signature,
   * a stamp all live in the overlay until export. Only rotating, cropping and
   * page moves rewrite the bytes, and only those need the document rebuilt to
   * be undone. Two snapshots sharing a stamp share a file, so stepping between
   * them is a matter of swapping the overlay and repainting — which is instant,
   * where a rebuild blanks every page for a second and scrolls you back to the
   * top of the document you were reading. */
  stamp: number;
}

/* Two hundred steps, not twenty.
 *
 * The old ceiling was a memory argument that stopped being true: a snapshot
 * used to carry its own copy of the whole file, so twenty of them was already
 * twenty copies of the PDF. Snapshots now share one copy per revision of the
 * bytes (see main.ts), which leaves only the annotation list — a few kilobytes
 * — per step. Fifty edits should undo fifty times, and now they do. */
const LIMIT = 200;

export class History {
  private past: Snapshot[] = [];
  private future: Snapshot[] = [];
  private listeners: Array<() => void> = [];

  onChange(fn: () => void): void { this.listeners.push(fn); }
  private emit(): void { for (const fn of this.listeners) fn(); }

  get canUndo(): boolean { return this.past.length > 0; }
  get canRedo(): boolean { return this.future.length > 0; }
  get undoLabel(): string { return this.past.at(-1)?.label ?? ''; }
  get redoLabel(): string { return this.future.at(-1)?.label ?? ''; }

  /** Called just before a change, with the state that is about to be replaced. */
  push(snapshot: Snapshot): void {
    this.past.push(snapshot);
    if (this.past.length > LIMIT) this.past.shift();
    /* Any new edit invalidates the redo branch. Keeping it would let you redo
       your way into a document that never existed. */
    this.future = [];
    this.emit();
  }

  undo(current: Snapshot): Snapshot | null {
    const prev = this.past.pop();
    if (!prev) return null;
    this.future.push(current);
    this.emit();
    return prev;
  }

  redo(current: Snapshot): Snapshot | null {
    const next = this.future.pop();
    if (!next) return null;
    this.past.push(current);
    this.emit();
    return next;
  }

  clear(): void {
    this.past = [];
    this.future = [];
    this.emit();
  }
}

/** Structured clone keeps the model plain — no shared references to mutate. */
export const cloneAnnots = (items: readonly Annot[]): Annot[] =>
  items.map(a => structuredClone(a) as Annot);
