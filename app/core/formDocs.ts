import {PDFDocument, StandardFonts, rgb, type PDFPage} from 'pdf-lib';

/* Building a fillable form from a description of it.
 *
 * PDFAid solves this by keeping the file on a server and opening a session
 * against it. We have no server, so the form is built here, in the tab, at the
 * moment you ask for it — and it comes out with real AcroForm widgets, which
 * means it stays fillable in Acrobat, Preview and every browser viewer after
 * you download it. Nothing is uploaded and nothing expires.
 *
 * A form is a list of sections and fields. That description is the whole
 * source: the layout, the widgets and the tab order all fall out of it, so
 * adding a form is writing a few lines of data rather than drawing a page. */

const A4 = {w: 595.28, h: 841.89} as const;
const INK = rgb(0.07, 0.07, 0.08);
const MUTED = rgb(0.45, 0.45, 0.48);
const RULE = rgb(0.82, 0.82, 0.84);
const FIELD_BG = rgb(0.975, 0.976, 0.98);

export type FieldKind = 'text' | 'multiline' | 'check' | 'date' | 'money' | 'signature';

export interface FormField {
  label: string;
  kind?: FieldKind;
  /** Share of the row's width, 1 = full. Fields flow onto a row until it fills. */
  /* A fraction of the usable width. Quarters exist for the grid-shaped
     documents — a rent ledger wants date, period, due and paid on one line,
     and splitting that over two rows turns a table into a list. */
  span?: 1 | 0.75 | 0.67 | 0.5 | 0.33 | 0.25;
  hint?: string;
}

export interface FormSection {
  title?: string;
  note?: string;
  fields: FormField[];
}

export interface FormSpec {
  title: string;
  subtitle?: string;
  sections: FormSection[];
  footnote?: string;
}

const H = {
  title: 20, subtitle: 10.5, section: 10, label: 7, field: 11, note: 8.5,
};

interface Cursor {
  page: PDFPage;
  y: number;              // distance from the top of the page
  pageIndex: number;
}

export async function buildForm(doc: PDFDocument, spec: FormSpec): Promise<void> {
  const sans = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const form = doc.getForm();

  const M = 52;                       // margin
  const W = A4.w - M * 2;             // usable width
  const BOTTOM = 64;                  // keep clear of the footer

  let c: Cursor = {page: doc.addPage([A4.w, A4.h]), y: M, pageIndex: 0};
  const yOf = (top: number) => A4.h - top;

  const text = (s: string, x: number, top: number, size: number, f = sans, color = INK) =>
    c.page.drawText(s, {x, y: yOf(top) - size, size, font: f, color});

  /* Field names must be unique across the document or pdf-lib refuses the
     second one — and a form that silently loses half its boxes is worse than
     one that fails loudly. */
  const used = new Set<string>();
  const nameFor = (label: string) => {
    const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'field';
    let name = base, n = 2;
    while (used.has(name)) name = `${base}_${n++}`;
    used.add(name);
    return name;
  };

  const newPage = () => {
    c = {page: doc.addPage([A4.w, A4.h]), y: M, pageIndex: c.pageIndex + 1};
  };

  const need = (h: number) => {
    if (c.y + h > A4.h - BOTTOM) newPage();
  };

  /* ── heading ─────────────────────────────────────── */
  text(spec.title.toUpperCase(), M, c.y, H.title, bold);
  c.y += H.title + 8;
  if (spec.subtitle) {
    text(spec.subtitle, M, c.y, H.subtitle, sans, MUTED);
    c.y += H.subtitle + 10;
  }
  c.page.drawLine({
    start: {x: M, y: yOf(c.y)}, end: {x: M + W, y: yOf(c.y)},
    thickness: 1.2, color: INK,
  });
  c.y += 22;

  /* ── sections ────────────────────────────────────── */
  for (const section of spec.sections) {
    need(60);
    if (section.title) {
      text(section.title.toUpperCase(), M, c.y, H.section, bold);
      c.y += H.section + 6;
      c.page.drawLine({
        start: {x: M, y: yOf(c.y)}, end: {x: M + W, y: yOf(c.y)},
        thickness: 0.6, color: RULE,
      });
      c.y += 12;
    }
    if (section.note) {
      text(section.note, M, c.y, H.note, sans, MUTED);
      c.y += H.note + 10;
    }

    /* Fields flow left to right until the row is full, so a spec never has to
       describe a grid — only how wide each answer should be. */
    let rowX = M;
    let rowH = 0;

    const closeRow = () => {
      if (rowH) { c.y += rowH + 12; rowX = M; rowH = 0; }
    };

    for (const f of section.fields) {
      const kind = f.kind ?? 'text';
      const span = f.span ?? (kind === 'multiline' ? 1 : 0.5);
      const gap = 14;
      const width = span === 1 ? W : Math.round(W * span) - gap;
      const height = kind === 'multiline' ? 62 : kind === 'signature' ? 34 : 22;
      const block = H.label + 4 + height;

      if (rowX + width > M + W + 1) closeRow();
      if (c.y + block > A4.h - BOTTOM) { closeRow(); newPage(); }

      text(f.label.toUpperCase(), rowX, c.y, H.label, bold, MUTED);
      const top = c.y + H.label + 4;

      if (kind === 'check') {
        const box = 14;
        form.createCheckBox(nameFor(f.label)).addToPage(c.page, {
          x: rowX, y: yOf(top) - box, width: box, height: box,
          borderWidth: 1, borderColor: RULE, backgroundColor: FIELD_BG,
        });
        if (f.hint) text(f.hint, rowX + box + 8, top + 2, H.note, sans, MUTED);
      } else if (kind === 'signature') {
        /* A signature is not a text box. Leaving a ruled space says "sign here"
           without pretending a typed name is a signature — the Sign tool in the
           editor is what actually goes in it. */
        c.page.drawLine({
          start: {x: rowX, y: yOf(top + height - 6)}, end: {x: rowX + width, y: yOf(top + height - 6)},
          thickness: 0.8, color: RULE,
        });
        if (f.hint) text(f.hint, rowX, top + height, H.note - 1, sans, MUTED);
      } else {
        const field = form.createTextField(nameFor(f.label));
        if (kind === 'multiline') field.enableMultiline();
        /* Order matters: a field has no default appearance until it is placed
           on a page with a font, and asking for a size before that throws. Size
           is set afterwards, once there is something to size. */
        field.addToPage(c.page, {
          x: rowX, y: yOf(top) - height, width, height,
          font: sans,
          borderWidth: 0.8, borderColor: RULE, backgroundColor: FIELD_BG,
        });
        field.setFontSize(H.field);
        if (f.hint) text(f.hint, rowX, top + height + 3, H.note - 1, sans, MUTED);
      }

      rowH = Math.max(rowH, block + (f.hint ? 11 : 0));
      rowX += width + gap;
      if (span === 1) closeRow();
    }
    closeRow();
    c.y += 10;
  }

  if (spec.footnote) {
    need(40);
    c.y += 6;
    c.page.drawLine({
      start: {x: M, y: yOf(c.y)}, end: {x: M + W, y: yOf(c.y)},
      thickness: 0.6, color: RULE,
    });
    c.y += 10;
    text(spec.footnote, M, c.y, H.note, sans, MUTED);
  }
}
