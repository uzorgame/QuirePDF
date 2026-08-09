/* The document's own typefaces.
 *
 * Everything the editor writes used to be set in one of the standard fourteen,
 * which is why an edited heading came back in Helvetica whatever the page was
 * set in — the width changed, so the layout changed, so the edit was visible
 * from across the room. pdf.js has the real fonts all along: rendering a page
 * sanitises every embedded face into ordinary OpenType and registers it with
 * the browser under its internal key. This registry keeps three facts per face
 * — the human name, that browser key, and the bytes — so the same font the
 * page was printed in can be offered in the font menu, shown while editing,
 * and embedded back into the exported file.
 *
 * Filled as a side effect of reading blocks (core/blocks.ts walks every text
 * item anyway) and reset when a document closes, because keys like "g_d17_f4"
 * are only meaningful for the load that minted them. */

export interface DocFace {
  /** Clean name, subset prefix stripped: "SegoeUI-Semibold". */
  name: string;
  /** pdf.js's registration key — also the CSS font-family the browser knows. */
  cssKey: string;
  /** Sanitised OpenType bytes, when pdf.js exposes them. Type3 fonts do not. */
  bytes: Uint8Array | null;
}

const faces = new Map<string, DocFace>();

export function registerDocFace(name: string, cssKey: string, bytes: Uint8Array | null): void {
  if (!name) return;
  const have = faces.get(name);
  /* Never let a later sighting without bytes erase an earlier one with them. */
  if (have?.bytes && !bytes) return;
  faces.set(name, {name, cssKey, bytes});
}

/** Every face seen in the open document, for the font menu. */
export function docFaces(): DocFace[] {
  return [...faces.values()].sort((m, n) => m.name.localeCompare(n.name));
}

export function docFace(name: string): DocFace | null {
  return faces.get(name) ?? null;
}

/** A sibling of `name` in the requested weight and slope, if the document
 *  carries one — the honest way to make B work on a document face. */
export function siblingFace(name: string, bold: boolean, italic: boolean): DocFace | null {
  const base = name.replace(/[-_ ]?(bold|black|heavy|semibold|light|italic|oblique|regular)/gi, '');
  for (const f of faces.values()) {
    const rest = f.name.slice(base.length).toLowerCase();
    if (!f.name.toLowerCase().startsWith(base.toLowerCase())) continue;
    const isB = /bold|black|heavy|semib/.test(rest);
    const isI = /italic|oblique/.test(rest);
    if (isB === bold && isI === italic) return f;
  }
  return null;
}

export function resetDocFonts(): void {
  faces.clear();
}
