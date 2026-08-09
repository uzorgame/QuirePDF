import {
  PDFDocument, StandardFonts,
  moveTo, lineTo, appendBezierCurve, closePath, rectangle, stroke, fill, fillAndStroke,
  setLineWidth, pushGraphicsState, popGraphicsState,
} from 'pdf-lib';

const doc = await PDFDocument.create();
const page = doc.addPage([200, 200]);
const font = await doc.embedFont(StandardFonts.Helvetica);

page.pushOperators(
  pushGraphicsState(),
  setLineWidth(2),
  moveTo(10, 10), lineTo(100, 10), stroke(),   // plain line, stroke only
  popGraphicsState(),

  pushGraphicsState(),
  rectangle(20, 20, 50, 30), stroke(),          // rectangle via 're' operator, stroke only
  popGraphicsState(),

  pushGraphicsState(),
  moveTo(20, 100), appendBezierCurve(40, 150, 80, 150, 100, 100), stroke(),  // bezier, stroke only
  popGraphicsState(),

  pushGraphicsState(),
  moveTo(120, 20), lineTo(160, 20), lineTo(160, 60), lineTo(120, 60), closePath(), fillAndStroke(), // filled+stroked closed poly
  popGraphicsState(),
);
page.drawText('Hello', {x: 10, y: 150, size: 12, font});

const bytes = await doc.save();

const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url).href;

const task = pdfjsLib.getDocument({data: bytes, disableWorker: true, isEvalSupported: false, useWorkerFetch: false});
const pdf = await task.promise;
const p = await pdf.getPage(1);
const opList = await p.getOperatorList();
const OPS = pdfjsLib.OPS;
const names = Object.fromEntries(Object.entries(OPS).map(([k,v]) => [v,k]));

console.log('fnArray length', opList.fnArray.length);
for (let i = 0; i < opList.fnArray.length; i++) {
  const fn = opList.fnArray[i];
  const args = opList.argsArray[i];
  let dump = args;
  if (names[fn] === 'constructPath') {
    const [op, data, minMax] = args;
    const flat = Array.from(data[0] ?? []);
    dump = {op: names[op], flat, minMax: Array.from(minMax ?? [])};
  }
  console.log(i, names[fn], JSON.stringify(dump));
}

console.log('DrawOPS check via OPS.rectangle/moveTo/etc still present but maybe unused:',
  {rectangle: OPS.rectangle, moveTo: OPS.moveTo, lineTo: OPS.lineTo});

await task.destroy();
