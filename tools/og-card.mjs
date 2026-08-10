/* The link preview card, drawn rather than photographed.
 *
 * Every chat and every feed that shows a link shows this file, so it is the
 * first and often the only thing anyone sees of the product. It says the two
 * things the site is — an editor and a converter — and backs them with the
 * counts, which are read off the pages that exist rather than typed in here: a
 * number in an image is a number nobody will remember to update.
 *
 * Run it with `npm run og` after adding or removing pages.
 *
 * The three faces are the site's own, vendored beside this file. They are
 * variable fonts and register only their lightest instance, so weight is added
 * by stroking the outline — the same thing a browser does when asked for a bold
 * it has not got. */
import {createCanvas, GlobalFonts, Path2D} from '@napi-rs/canvas';
import {writeFileSync, readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join, dirname} from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const font = (file, name) => GlobalFonts.registerFromPath(join(HERE, 'fonts', file), name);
font('SpaceGrotesk.ttf', 'SG');
font('Inter.ttf', 'INTER');
font('JetBrainsMono.ttf', 'JBM');

const count = (dir) => readdirSync(join(ROOT, dir)).filter(f => f.endsWith('.html')).length;
const CONVERSIONS = count('convert');
const FORMS = count('forms');

const W = 1200, H = 630, M = 80;
const BLUE = '#2563eb';
const DEEP = '#1b45c4';
const PALE = '#dbeafe';
const LABEL = '#a9c3f9';
const FAINT = 'rgba(255,255,255,0.30)';

const c = createCanvas(W, H);
const g = c.getContext('2d');

const write = (s, x, y, size, fam, weight, colour, align) => {
  g.font = `${size}px ${fam}`;
  const w = g.measureText(s).width;
  const at = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
  g.fillStyle = colour;
  g.strokeStyle = colour;
  g.lineWidth = weight;
  g.lineJoin = 'round';
  g.fillText(s, at, y);
  if (weight > 0) g.strokeText(s, at, y);
  return w;
};

/* The field, with one corner turned a shade deeper — a page has a folded
   corner and so does this. */
g.fillStyle = BLUE;
g.fillRect(0, 0, W, H);
g.fillStyle = DEEP;
g.beginPath();
g.moveTo(W, 0);
g.lineTo(W, H);
g.lineTo(W - 380, H);
g.closePath();
g.fill();

/* The app's own mark, reversed for the field it sits on. */
const markAt = (x, y, s) => {
  const u = s / 64, px = x + 12 * u, py = y + 12 * u, k = 1.25 * u;
  const shape = (d, fill) => {
    g.save(); g.translate(px, py); g.scale(k, k);
    g.fillStyle = fill; g.fill(new Path2D(d)); g.restore();
  };
  shape('M3 4a3 3 0 0 1 3-3h13.5L29 10.5V28a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V4z', '#ffffff');
  shape('M19.5 1 29 10.5h-6.5a3 3 0 0 1-3-3V1z', '#93b4f7');
  g.save(); g.translate(px, py); g.scale(k, k);
  g.strokeStyle = BLUE; g.lineWidth = 3.2; g.lineCap = 'round';
  g.beginPath();
  g.moveTo(16, 15.5); g.lineTo(16, 24.5);
  g.moveTo(11.5, 20); g.lineTo(20.5, 20);
  g.stroke();
  g.restore();
  g.lineCap = 'butt';
};
markAt(M, 64, 74);
write('QuirePDF', M + 96, 122, 52, 'SG', 3, '#ffffff');

/* What it is, then what is unusual about it. */
write('A PDF editor and a file converter,', M, 268, 62, 'SG', 3, '#ffffff');
write('with no server behind either.', M, 342, 62, 'SG', 3, '#ffffff');
write('Edit the words a PDF already has — in the font it already carries.',
      M, 404, 26, 'INTER', 0.4, PALE);

/* The counts, from the pages themselves, and three of the form numbers by
   name. A total says how many there are and nothing about whether the one
   somebody needs is among them; a W-9 in the preview answers that before they
   click. These three are the most looked-for of the hundred and five. */
const columns = [
  [String(CONVERSIONS), 'CONVERSIONS', 46, 'SG', 2],
  [String(FORMS), 'FILLABLE FORMS', 46, 'SG', 2],
  ['W-9 · DS-11 · 1099-MISC', 'INCLUDING', 26, 'JBM', 0.6],
];
let x = M;
columns.forEach(([n, label, size, family, track], i) => {
  if (i) {
    g.strokeStyle = FAINT;
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(x - 40, 452); g.lineTo(x - 40, 516); g.stroke();
  }
  const nw = write(n, x, 500, size, family, track, '#ffffff');
  const lw = write(label, x, 526, 15, 'JBM', 0.2, LABEL);
  x += Math.max(nw, lw) + 112;
});

g.strokeStyle = FAINT;
g.lineWidth = 1;
g.beginPath();
g.moveTo(M, 566);
g.lineTo(W - M, 566);
g.stroke();
write('uz-or.com/quirePDF', M, 601, 22, 'JBM', 0.3, '#c7dbfd');
write('NO SERVER · NO UPLOAD · FREE', W - M, 601, 22, 'JBM', 0.3, '#c7dbfd', 'right');

const out = join(ROOT, 'og-image.png');
writeFileSync(out, c.toBuffer('image/png'));
console.log(`og-image.png — ${CONVERSIONS} conversions, ${FORMS} forms`);
