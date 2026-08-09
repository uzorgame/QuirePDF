import {PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage} from 'pdf-lib';

/* The starting documents.
 *
 * These are built with pdf-lib at the moment you pick one, not shipped as
 * files. That is worth the extra code for two reasons: the result is a real
 * PDF with real text objects, so every line in it is editable rather than a
 * picture of a form; and the whole library costs zero bytes of download until
 * somebody actually opens one. */

const A4 = {w: 595.28, h: 841.89} as const;
const INK = rgb(0.07, 0.07, 0.08);
const MUTED = rgb(0.55, 0.55, 0.58);
const RULE = rgb(0.85, 0.85, 0.86);
const FAINT = rgb(0.93, 0.93, 0.94);
const ACC = rgb(0.145, 0.388, 0.921);

interface Kit {
  page: PDFPage;
  sans: PDFFont;
  bold: PDFFont;
  /** Text positioned from the top edge, because that is how people read a page. */
  text(s: string, x: number, top: number, o?: {size?: number; bold?: boolean; color?: ReturnType<typeof rgb>}): void;
  rule(x1: number, top: number, x2: number, o?: {color?: ReturnType<typeof rgb>; thickness?: number}): void;
  box(x: number, top: number, w: number, h: number, o?: {fill?: ReturnType<typeof rgb>; border?: ReturnType<typeof rgb>}): void;
  /** A labelled blank the user types into. */
  field(label: string, x: number, top: number, w: number): void;
}

function kit(page: PDFPage, sans: PDFFont, bold: PDFFont): Kit {
  const y = (top: number) => page.getHeight() - top;
  const k: Kit = {
    page, sans, bold,
    text(s, x, top, o = {}) {
      const size = o.size ?? 10;
      page.drawText(s, {x, y: y(top) - size, size, font: o.bold ? bold : sans, color: o.color ?? INK});
    },
    rule(x1, top, x2, o = {}) {
      page.drawLine({
        start: {x: x1, y: y(top)}, end: {x: x2, y: y(top)},
        thickness: o.thickness ?? 0.75, color: o.color ?? RULE,
      });
    },
    box(x, top, w, h, o = {}) {
      page.drawRectangle({
        x, y: y(top) - h, width: w, height: h,
        color: o.fill, borderColor: o.border, borderWidth: o.border ? 0.75 : 0,
      });
    },
    field(label, x, top, w) {
      k.text(label.toUpperCase(), x, top, {size: 6.5, color: MUTED, bold: true});
      k.rule(x, top + 26, x + w);
    },
  };
  return k;
}

async function sheet(doc: PDFDocument): Promise<Kit> {
  const page = doc.addPage([A4.w, A4.h]);
  const sans = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  return kit(page, sans, bold);
}

/* ── the library ──────────────────────────────────────────────────────── */

export interface Template {
  id: string;
  name: string;
  blurb: string;
  group: 'Blank' | 'Business' | 'Work' | 'Personal';
  build(doc: PDFDocument): Promise<void>;
}

export const TEMPLATES: Template[] = [

  {
    id: 'blank', name: 'Blank page', group: 'Blank',
    blurb: 'One empty A4 sheet. Everything else starts here.',
    async build(doc) { await sheet(doc); },
  },

  {
    id: 'lined', name: 'Lined paper', group: 'Blank',
    blurb: 'Ruled sheet with a title line — for notes you intend to print.',
    async build(doc) {
      const k = await sheet(doc);
      k.field('Title', 56, 60, 483);
      for (let top = 130; top < 790; top += 26) k.rule(56, top, 539, {color: FAINT});
    },
  },

  {
    id: 'grid', name: 'Grid paper', group: 'Blank',
    blurb: '5 mm squares, edge to edge. Sketches, plans, seating charts.',
    async build(doc) {
      const k = await sheet(doc);
      const step = 14.17; // 5 mm in points
      for (let x = 56; x <= 539; x += step) {
        k.page.drawLine({start: {x, y: 56}, end: {x, y: A4.h - 56}, thickness: 0.4, color: FAINT});
      }
      for (let top = 56; top <= A4.h - 56; top += step) k.rule(56, top, 539, {color: FAINT, thickness: 0.4});
    },
  },

  {
    id: 'invoice', name: 'Invoice', group: 'Business',
    blurb: 'Sender, client, line items, totals and payment terms.',
    async build(doc) {
      const k = await sheet(doc);
      k.text('INVOICE', 56, 56, {size: 26, bold: true});
      k.text('No.', 430, 62, {size: 8, color: MUTED, bold: true});
      k.rule(455, 78, 539);
      k.text('Date', 430, 88, {size: 8, color: MUTED, bold: true});
      k.rule(455, 104, 539);

      k.text('FROM', 56, 130, {size: 6.5, color: MUTED, bold: true});
      k.text('BILL TO', 310, 130, {size: 6.5, color: MUTED, bold: true});
      for (let i = 0; i < 4; i++) {
        k.rule(56, 162 + i * 22, 270, {color: FAINT});
        k.rule(310, 162 + i * 22, 539, {color: FAINT});
      }

      const head = 270;
      k.box(56, head, 483, 24, {fill: rgb(0.96, 0.96, 0.97)});
      k.text('DESCRIPTION', 66, head + 8, {size: 7, bold: true, color: MUTED});
      k.text('QTY', 350, head + 8, {size: 7, bold: true, color: MUTED});
      k.text('RATE', 405, head + 8, {size: 7, bold: true, color: MUTED});
      k.text('AMOUNT', 480, head + 8, {size: 7, bold: true, color: MUTED});
      for (let i = 1; i <= 10; i++) k.rule(56, head + 24 + i * 26, 539, {color: FAINT});

      const tot = head + 24 + 10 * 26 + 26;
      k.text('Subtotal', 405, tot, {size: 9, color: MUTED});
      k.text('Tax', 405, tot + 22, {size: 9, color: MUTED});
      k.text('Total due', 405, tot + 48, {size: 11, bold: true});
      k.rule(400, tot + 40, 539, {color: RULE});
      k.rule(400, tot + 68, 539, {color: INK, thickness: 1.2});

      k.text('PAYMENT TERMS', 56, tot, {size: 6.5, color: MUTED, bold: true});
      k.rule(56, tot + 22, 340, {color: FAINT});
      k.rule(56, tot + 44, 340, {color: FAINT});
    },
  },

  {
    id: 'receipt', name: 'Receipt', group: 'Business',
    blurb: 'Proof of payment: who paid whom, how much, and for what.',
    async build(doc) {
      const k = await sheet(doc);
      k.text('RECEIPT', 56, 56, {size: 24, bold: true});
      k.rule(56, 96, 539, {color: INK, thickness: 1.2});

      k.field('Receipt number', 56, 120, 220);
      k.field('Date', 320, 120, 219);
      k.field('Received from', 56, 190, 483);
      k.field('Amount', 56, 260, 220);
      k.field('Payment method', 320, 260, 219);
      k.field('For', 56, 330, 483);

      k.box(56, 410, 483, 70, {border: RULE});
      k.text('AMOUNT IN WORDS', 66, 420, {size: 6.5, color: MUTED, bold: true});

      k.field('Received by', 56, 530, 220);
      k.field('Signature', 320, 530, 219);
    },
  },

  {
    id: 'letter', name: 'Formal letter', group: 'Business',
    blurb: 'Letterhead, date, address block, body and sign-off.',
    async build(doc) {
      const k = await sheet(doc);
      k.rule(56, 56, 539, {color: ACC, thickness: 2.5});
      k.text('YOUR NAME OR COMPANY', 56, 70, {size: 12, bold: true});
      k.text('Street · City · Postcode · email · phone', 56, 90, {size: 8, color: MUTED});

      k.rule(56, 132, 539, {color: FAINT});
      k.text('Date', 439, 150, {size: 8, color: MUTED, bold: true});
      k.rule(439, 172, 539, {color: FAINT});

      k.text('RECIPIENT', 56, 200, {size: 6.5, color: MUTED, bold: true});
      for (let i = 0; i < 4; i++) k.rule(56, 232 + i * 22, 300, {color: FAINT});

      k.text('Dear', 56, 340, {size: 11});
      k.rule(90, 356, 300, {color: FAINT});
      for (let i = 0; i < 14; i++) k.rule(56, 400 + i * 24, 539, {color: FAINT});

      k.text('Yours sincerely,', 56, 760, {size: 11});
      k.rule(56, 812, 260, {color: RULE});
    },
  },

  {
    id: 'contract', name: 'Simple agreement', group: 'Business',
    blurb: 'Parties, scope, fee, term, and two signature blocks.',
    async build(doc) {
      const k = await sheet(doc);
      k.text('AGREEMENT', 56, 56, {size: 22, bold: true});
      k.text('Made on', 56, 92, {size: 9, color: MUTED});
      k.rule(105, 108, 250, {color: FAINT});
      k.text('between', 265, 92, {size: 9, color: MUTED});
      k.rule(310, 108, 539, {color: FAINT});
      k.rule(56, 136, 539, {color: INK, thickness: 1});

      const sections = ['1. Scope', '2. Fee and payment', '3. Term', '4. Confidentiality', '5. Termination'];
      let top = 168;
      for (const s of sections) {
        k.text(s, 56, top, {size: 11, bold: true});
        for (let i = 0; i < 3; i++) k.rule(56, top + 34 + i * 20, 539, {color: FAINT});
        top += 110;
      }

      k.rule(56, 730, 539, {color: RULE});
      k.text('SIGNED BY THE PARTIES', 56, 744, {size: 6.5, color: MUTED, bold: true});
      k.rule(56, 800, 270, {color: RULE});
      k.rule(310, 800, 539, {color: RULE});
      k.text('Name and signature', 56, 806, {size: 7, color: MUTED});
      k.text('Name and signature', 310, 806, {size: 7, color: MUTED});
    },
  },

  {
    id: 'resume', name: 'Résumé', group: 'Personal',
    blurb: 'One page: contact, experience, education, skills.',
    async build(doc) {
      const k = await sheet(doc);
      k.text('YOUR NAME', 56, 56, {size: 24, bold: true});
      k.text('Job title', 56, 88, {size: 11, color: ACC});
      k.text('email · phone · city · portfolio', 56, 110, {size: 8.5, color: MUTED});
      k.rule(56, 140, 539, {color: INK, thickness: 1});

      const block = (title: string, top: number, rows: number) => {
        k.text(title.toUpperCase(), 56, top, {size: 8, bold: true, color: MUTED});
        k.rule(56, top + 18, 539, {color: FAINT});
        for (let i = 0; i < rows; i++) k.rule(56, top + 46 + i * 22, 539, {color: FAINT});
      };
      block('Experience', 170, 8);
      block('Education', 400, 4);
      block('Skills', 550, 3);
      block('Languages', 660, 2);
    },
  },

  {
    id: 'agenda', name: 'Meeting agenda', group: 'Work',
    blurb: 'Time, attendees, numbered items and an actions box.',
    async build(doc) {
      const k = await sheet(doc);
      k.text('MEETING AGENDA', 56, 56, {size: 20, bold: true});
      k.field('Subject', 56, 100, 483);
      k.field('Date and time', 56, 165, 220);
      k.field('Location', 320, 165, 219);
      k.field('Attendees', 56, 230, 483);

      k.text('ITEMS', 56, 300, {size: 7, bold: true, color: MUTED});
      k.rule(56, 318, 539, {color: RULE});
      for (let i = 1; i <= 8; i++) {
        const top = 336 + (i - 1) * 30;
        k.text(String(i).padStart(2, '0'), 56, top, {size: 9, color: ACC, bold: true});
        k.rule(80, top + 18, 470, {color: FAINT});
        k.rule(485, top + 18, 539, {color: FAINT});
      }
      k.text('MIN', 485, 322, {size: 6.5, color: MUTED, bold: true});

      k.text('ACTIONS AGREED', 56, 600, {size: 7, bold: true, color: MUTED});
      k.box(56, 618, 483, 160, {border: RULE});
      for (let i = 1; i < 6; i++) k.rule(56, 618 + i * 27, 539, {color: FAINT});
    },
  },

  {
    id: 'timesheet', name: 'Weekly timesheet', group: 'Work',
    blurb: 'Seven days, in and out, hours and a weekly total.',
    async build(doc) {
      const k = await sheet(doc);
      k.text('TIMESHEET', 56, 56, {size: 20, bold: true});
      k.field('Name', 56, 100, 220);
      k.field('Week beginning', 320, 100, 219);

      const cols = [56, 170, 260, 350, 440, 539];
      const heads = ['DAY', 'IN', 'OUT', 'BREAK', 'HOURS'];
      const head = 170;
      k.box(56, head, 483, 24, {fill: rgb(0.96, 0.96, 0.97)});
      heads.forEach((h, i) => k.text(h, cols[i]! + 10, head + 8, {size: 7, bold: true, color: MUTED}));

      const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
      days.forEach((d, i) => {
        const top = head + 24 + i * 34;
        k.text(d, 66, top + 11, {size: 10});
        k.rule(56, top + 34, 539, {color: FAINT});
      });
      cols.forEach(x => k.page.drawLine({
        start: {x, y: A4.h - head}, end: {x, y: A4.h - (head + 24 + days.length * 34)},
        thickness: 0.75, color: RULE,
      }));

      const tot = head + 24 + days.length * 34 + 24;
      k.text('TOTAL HOURS', 350, tot, {size: 8, bold: true, color: MUTED});
      k.rule(440, tot + 22, 539, {color: INK, thickness: 1.2});

      k.field('Employee signature', 56, tot + 80, 220);
      k.field('Approved by', 320, tot + 80, 219);
    },
  },
  {
    id: 'purchase-order', name: 'Purchase order', group: 'Business',
    blurb: 'Order number, supplier, line items and a delivery address.',
    async build(doc) {
      const k = await sheet(doc);
      k.text('PURCHASE ORDER', 56, 56, {size: 22, bold: true});
      k.text('PO No.', 420, 62, {size: 7, color: MUTED, bold: true});
      k.rule(455, 78, 539);
      k.text('Date', 420, 88, {size: 7, color: MUTED, bold: true});
      k.rule(455, 104, 539);

      k.text('SUPPLIER', 56, 130, {size: 6.5, color: MUTED, bold: true});
      k.text('DELIVER TO', 310, 130, {size: 6.5, color: MUTED, bold: true});
      for (let i = 0; i < 4; i++) {
        k.rule(56, 162 + i * 22, 270, {color: FAINT});
        k.rule(310, 162 + i * 22, 539, {color: FAINT});
      }

      const head = 270;
      k.box(56, head, 483, 24, {fill: rgb(0.96, 0.96, 0.97)});
      ['ITEM', 'DESCRIPTION', 'QTY', 'UNIT PRICE', 'TOTAL'].forEach((h, i) =>
        k.text(h, [66, 120, 330, 390, 480][i]!, head + 8, {size: 7, bold: true, color: MUTED}));
      for (let i = 1; i <= 12; i++) k.rule(56, head + 24 + i * 26, 539, {color: FAINT});

      const foot = head + 24 + 12 * 26 + 26;
      k.text('Order total', 400, foot, {size: 11, bold: true});
      k.rule(395, foot + 22, 539, {color: INK, thickness: 1.2});
      k.field('Authorised by', 56, foot, 300);
    },
  },

  {
    id: 'packing-slip', name: 'Packing slip', group: 'Business',
    blurb: 'What is in the box, for whom, and against which order.',
    async build(doc) {
      const k = await sheet(doc);
      k.text('PACKING SLIP', 56, 56, {size: 22, bold: true});
      k.field('Order number', 56, 100, 220);
      k.field('Ship date', 320, 100, 219);
      k.field('Ship to', 56, 165, 220);
      k.field('Carrier and tracking', 320, 165, 219);

      const head = 240;
      k.box(56, head, 483, 24, {fill: rgb(0.96, 0.96, 0.97)});
      ['SKU', 'DESCRIPTION', 'ORDERED', 'SHIPPED'].forEach((h, i) =>
        k.text(h, [66, 160, 360, 460][i]!, head + 8, {size: 7, bold: true, color: MUTED}));
      for (let i = 1; i <= 14; i++) k.rule(56, head + 24 + i * 26, 539, {color: FAINT});

      k.text('NOTES', 56, 650, {size: 6.5, color: MUTED, bold: true});
      k.box(56, 668, 483, 80, {border: RULE});
      k.field('Received by', 56, 770, 220);
      k.field('Date', 320, 770, 219);
    },
  },

  {
    id: 'job-application', name: 'Job application', group: 'Work',
    blurb: 'Applicant details, position, history and availability.',
    async build(doc) {
      const k = await sheet(doc);
      k.text('APPLICATION FOR EMPLOYMENT', 56, 56, {size: 18, bold: true});
      k.rule(56, 92, 539, {color: INK, thickness: 1});

      k.text('POSITION APPLIED FOR', 56, 116, {size: 6.5, color: MUTED, bold: true});
      k.rule(56, 142, 539);

      k.text('APPLICANT', 56, 170, {size: 8, bold: true, color: ACC});
      k.field('Full name', 56, 194, 483);
      k.field('Address', 56, 254, 483);
      k.field('Phone', 56, 314, 220);
      k.field('Email', 320, 314, 219);
      k.field('Available from', 56, 374, 220);
      k.field('Right to work', 320, 374, 219);

      k.text('EMPLOYMENT HISTORY', 56, 440, {size: 8, bold: true, color: ACC});
      k.rule(56, 458, 539, {color: RULE});
      for (let i = 0; i < 3; i++) {
        const top = 480 + i * 84;
        k.field('Employer', 56, top, 220);
        k.field('Role', 320, top, 219);
        k.rule(56, top + 60, 539, {color: FAINT});
      }

      k.field('Signature', 56, 750, 220);
      k.field('Date', 320, 750, 219);
    },
  },

  {
    id: 'expense-report', name: 'Expense report', group: 'Work',
    blurb: 'Dated claims with category, amount and an approval line.',
    async build(doc) {
      const k = await sheet(doc);
      k.text('EXPENSE REPORT', 56, 56, {size: 20, bold: true});
      k.field('Name', 56, 100, 220);
      k.field('Period', 320, 100, 219);
      k.field('Department', 56, 165, 220);
      k.field('Employee number', 320, 165, 219);

      const head = 235;
      k.box(56, head, 483, 24, {fill: rgb(0.96, 0.96, 0.97)});
      ['DATE', 'DESCRIPTION', 'CATEGORY', 'AMOUNT'].forEach((h, i) =>
        k.text(h, [66, 150, 330, 470][i]!, head + 8, {size: 7, bold: true, color: MUTED}));
      for (let i = 1; i <= 15; i++) k.rule(56, head + 24 + i * 26, 539, {color: FAINT});

      const foot = head + 24 + 15 * 26 + 24;
      k.text('TOTAL CLAIMED', 350, foot, {size: 8, bold: true, color: MUTED});
      k.rule(450, foot + 22, 539, {color: INK, thickness: 1.2});
      k.field('Claimant signature', 56, foot + 60, 220);
      k.field('Approved by', 320, foot + 60, 219);
    },
  },

  {
    id: 'attendance', name: 'Attendance sheet', group: 'Work',
    blurb: 'Names down the side, days across — classes, shifts, sign-ins.',
    async build(doc) {
      const k = await sheet(doc);
      k.text('ATTENDANCE SHEET', 56, 56, {size: 20, bold: true});
      k.field('Group or class', 56, 100, 220);
      k.field('Month', 320, 100, 219);

      const left = 56, top = 170, nameW = 150, cols = 15, colW = (483 - nameW) / cols;
      k.box(left, top, 483, 26, {fill: rgb(0.96, 0.96, 0.97)});
      k.text('NAME', left + 10, top + 9, {size: 7, bold: true, color: MUTED});
      for (let c = 0; c < cols; c++) {
        k.text(String(c + 1), left + nameW + c * colW + colW / 2 - 3, top + 9, {size: 6.5, color: MUTED});
      }
      const rows = 18;
      for (let r = 1; r <= rows; r++) k.rule(left, top + 26 + r * 28, 539, {color: FAINT});
      for (let c = 0; c <= cols; c++) {
        const x = left + nameW + c * colW;
        k.page.drawLine({
          start: {x, y: A4.h - top}, end: {x, y: A4.h - (top + 26 + rows * 28)},
          thickness: 0.5, color: FAINT,
        });
      }
      k.page.drawLine({
        start: {x: left, y: A4.h - top}, end: {x: left, y: A4.h - (top + 26 + rows * 28)},
        thickness: 0.75, color: RULE,
      });
    },
  },

  {
    id: 'feedback', name: 'Feedback form', group: 'Work',
    blurb: 'Five rated statements and room to say what the scale cannot.',
    async build(doc) {
      const k = await sheet(doc);
      k.text('FEEDBACK FORM', 56, 56, {size: 20, bold: true});
      k.text('Your answers are anonymous unless you choose to sign at the bottom.', 56, 88, {size: 9.5, color: MUTED});
      k.rule(56, 118, 539, {color: RULE});

      k.text('1 = strongly disagree   ·   5 = strongly agree', 56, 140, {size: 8, color: MUTED});
      const statements = [
        'The information was clear and easy to follow.',
        'The pace suited me.',
        'My questions were answered.',
        'I can apply what I learned.',
        'I would recommend this to a colleague.',
      ];
      statements.forEach((s, i) => {
        const top = 180 + i * 56;
        k.text(s, 56, top, {size: 10.5});
        for (let n = 0; n < 5; n++) {
          k.box(360 + n * 36, top + 20, 22, 22, {border: RULE});
          k.text(String(n + 1), 368 + n * 36, top + 25, {size: 9, color: MUTED});
        }
      });

      k.text('WHAT WORKED WELL', 56, 480, {size: 6.5, color: MUTED, bold: true});
      k.box(56, 498, 483, 96, {border: RULE});
      k.text('WHAT SHOULD CHANGE', 56, 616, {size: 6.5, color: MUTED, bold: true});
      k.box(56, 634, 483, 96, {border: RULE});
      k.field('Name (optional)', 56, 756, 483);
    },
  },
];

export const templateById = (id: string): Template | undefined =>
  TEMPLATES.find(t => t.id === id);

export const TEMPLATE_GROUPS: Template['group'][] = ['Blank', 'Business', 'Work', 'Personal'];
