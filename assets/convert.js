/* The image converters, running for real.
 *
 * Every one of these is a decode followed by an encode. The browser already has
 * decoders for JPEG, PNG, WEBP, AVIF, GIF, BMP and SVG, and encoders for JPEG,
 * PNG and WEBP; what it has no idea about is ICO, EPS and GIF-out, so those
 * three are written here byte by byte. Nothing is uploaded, which is the whole
 * point — a holiday photo has no business on somebody else's server just to
 * change its extension.
 *
 * The one thing this file will not do is pretend. A conversion the browser
 * cannot actually perform says so and names the reason, rather than handing
 * back a renamed file that fails to open somewhere else.
 */

/* ── decoding ─────────────────────────────────────────────────────────── */

const MAGIC = [
  [[0xFF, 0xD8, 0xFF], 'jpg'],
  [[0x89, 0x50, 0x4E, 0x47], 'png'],
  [[0x47, 0x49, 0x46, 0x38], 'gif'],
  [[0x42, 0x4D], 'bmp'],
  [[0x00, 0x00, 0x01, 0x00], 'ico'],
  [[0x25, 0x21], 'eps'],
  [[0x49, 0x49, 0x2A, 0x00], 'tiff'],
  [[0x4D, 0x4D, 0x00, 0x2A], 'tiff'],
];

/* What a file actually is, from its first bytes rather than its name.
   An extension is a claim; the magic number is evidence, and people rename
   files all the time — usually a PNG saved as .jpg. */
export async function sniff(file) {
  const head = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  for (const [sig, kind] of MAGIC) {
    if (sig.every((b, i) => head[i] === b)) return kind;
  }
  const text = new TextDecoder().decode(head).trim().toLowerCase();
  if (text.startsWith('<svg') || text.startsWith('<?xml')) return 'svg';
  /* RIFF....WEBP */
  if (head[0] === 0x52 && head[1] === 0x49 && head[8] === 0x57 && head[9] === 0x45) return 'webp';
  /* ....ftypavif / ftypheic — the brand sits at offset 8 in both. */
  const brand = String.fromCharCode(...head.slice(8, 12)).toLowerCase();
  if (brand === 'avif' || brand === 'avis') return 'avif';
  if (['heic', 'heix', 'hevc', 'mif1', 'heim'].includes(brand)) return 'heic';
  if (head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46) return 'pdf';
  return null;
}

/* The formats a page will accept, keyed by the slug's source half. `image`
   means "any picture", which is exactly what the page promises. */
const ACCEPTS = {
  image: ['jpg', 'png', 'webp', 'avif', 'gif', 'bmp', 'svg'],
  jpg: ['jpg'], jpeg: ['jpg'], jfif: ['jpg'],
  png: ['png'], webp: ['webp'], avif: ['avif'], svg: ['svg'],
  heic: ['heic'], gif: ['gif'], bmp: ['bmp'], tiff: ['tiff'],
};

export const accepts = (src) => ACCEPTS[src] ?? [src];

/* The heavy engine is a separate module with a Refused class of its own, and
   an instanceof across that boundary is false even though both mean exactly
   the same thing — so the name is what identifies one, on both sides. */
class Refused extends Error {
  name = 'Refused';
}
const refuse = (msg) => { throw new Refused(msg); };

/* Decodes to a canvas. SVG goes through an <img>, because createImageBitmap
   refuses an SVG without an intrinsic size in several engines; everything else
   goes through createImageBitmap, which is faster and does not need the DOM. */
async function toCanvas(file, kind) {
  if (kind === 'svg') return svgToCanvas(file);
  /* Safari is the only engine that decodes HEIC, so this one goes through
     libheif — the reference decoder, compiled to WebAssembly, fetched only when
     a HEIC actually turns up. */
  if (kind === 'heic') {
    const {heicToCanvas} = await engine();
    return heicToCanvas(new Uint8Array(await file.arrayBuffer()));
  }

  let bmp;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    refuse(`This file says it is ${kind.toUpperCase()}, but the browser could not decode it. `
      + 'It may be truncated or damaged.');
  }

  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  canvas.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close?.();
  return canvas;
}

/* An SVG has to be given a size before it can be rasterised: many are authored
   with only a viewBox, and drawing one of those produces a 0×0 canvas in
   Chrome and a 150×300 default in Firefox. So the size is read out of the
   markup and a sensible one supplied when it is missing. */
async function svgToCanvas(file) {
  const text = await file.text();
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  if (doc.querySelector('parsererror')) refuse('That SVG could not be parsed — the markup is not valid XML.');

  const svg = doc.documentElement;
  const vb = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
  let w = parseFloat(svg.getAttribute('width')) || (vb.length === 4 ? vb[2] : 0);
  let h = parseFloat(svg.getAttribute('height')) || (vb.length === 4 ? vb[3] : 0);
  if (!w || !h) { w = 1024; h = 1024; }
  /* Rasterised above 1:1 so the result is worth looking at — a vector redrawn
     at its nominal size is usually far smaller than anyone wants. */
  const scale = Math.min(4, Math.max(1, 1600 / Math.max(w, h)));

  const url = URL.createObjectURL(new Blob([text], {type: 'image/svg+xml'}));
  try {
    const img = new Image();
    img.decoding = 'sync';
    await new Promise((ok, no) => {
      img.onload = ok;
      img.onerror = () => no(new Refused('That SVG could not be rendered. If it links to an '
        + 'external image or font, the browser blocks that when the file is loaded locally.'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* ── encoding ─────────────────────────────────────────────────────────── */

/* JPEG has no alpha channel. Without this the transparent parts of a PNG come
   out black, which is the single most complained-about bug in every online
   PNG-to-JPG converter. */
function matte(canvas) {
  const flat = document.createElement('canvas');
  flat.width = canvas.width;
  flat.height = canvas.height;
  const ctx = flat.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, flat.width, flat.height);
  ctx.drawImage(canvas, 0, 0);
  return flat;
}

const blobOf = (canvas, type, q) => new Promise((ok, no) =>
  canvas.toBlob(b => b ? ok(b) : no(new Refused(`This browser cannot write ${type}.`)), type, q));

/* ICO is a tiny header followed by a whole PNG. Windows has accepted PNG-in-ICO
   since Vista, which saves writing a BMP encoder and a mask plane. */
async function toIco(canvas) {
  const side = Math.min(256, Math.max(canvas.width, canvas.height));
  const square = document.createElement('canvas');
  square.width = square.height = side;
  const ctx = square.getContext('2d');
  /* Letterboxed rather than stretched: an icon of a squashed logo is worse
     than an icon with a little space around it. */
  const s = Math.min(side / canvas.width, side / canvas.height);
  const w = Math.round(canvas.width * s), h = Math.round(canvas.height * s);
  ctx.drawImage(canvas, (side - w) / 2, (side - h) / 2, w, h);

  const png = new Uint8Array(await (await blobOf(square, 'image/png')).arrayBuffer());
  const out = new Uint8Array(22 + png.length);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, 0, true);            // reserved
  dv.setUint16(2, 1, true);            // type: icon
  dv.setUint16(4, 1, true);            // one image
  out[6] = side >= 256 ? 0 : side;     // 0 means 256
  out[7] = side >= 256 ? 0 : side;
  out[8] = 0;                          // palette
  out[9] = 0;                          // reserved
  dv.setUint16(10, 1, true);           // colour planes
  dv.setUint16(12, 32, true);          // bits per pixel
  dv.setUint32(14, png.length, true);
  dv.setUint32(18, 22, true);          // offset
  out.set(png, 22);
  return new Blob([out], {type: 'image/x-icon'});
}

/* EPS, written as PostScript with the pixels inline.
 *
 * A JPEG source keeps its compression — the bytes go in as-is behind a
 * DCTDecode filter, which is both smaller and lossless relative to the source.
 * Anything else is written as hex RGB, which is bulky but is what every
 * PostScript interpreter since 1990 understands. */
async function toEps(canvas, sourceIsJpeg, file) {
  const {width: w, height: h} = canvas;
  const head = `%!PS-Adobe-3.0 EPSF-3.0
%%Creator: Quire
%%BoundingBox: 0 0 ${w} ${h}
%%LanguageLevel: 2
%%Pages: 1
%%EndComments
gsave
${w} ${h} scale
/DeviceRGB setcolorspace
`;

  let body;
  if (sourceIsJpeg) {
    const raw = new Uint8Array(await file.arrayBuffer());
    body = `<< /ImageType 1 /Width ${w} /Height ${h} /BitsPerComponent 8
   /Decode [0 1 0 1 0 1] /ImageMatrix [${w} 0 0 -${h} 0 ${h}]
   /DataSource currentfile /ASCII85Decode filter /DCTDecode filter >> image
${ascii85(raw)}
`;
  } else {
    const px = canvas.getContext('2d').getImageData(0, 0, w, h).data;
    const rgb = new Uint8Array(w * h * 3);
    for (let i = 0, j = 0; i < px.length; i += 4, j += 3) {
      /* Composited onto white, because PostScript has no alpha here either. */
      const a = px[i + 3] / 255;
      rgb[j]     = Math.round(px[i]     * a + 255 * (1 - a));
      rgb[j + 1] = Math.round(px[i + 1] * a + 255 * (1 - a));
      rgb[j + 2] = Math.round(px[i + 2] * a + 255 * (1 - a));
    }
    body = `<< /ImageType 1 /Width ${w} /Height ${h} /BitsPerComponent 8
   /Decode [0 1 0 1 0 1] /ImageMatrix [${w} 0 0 -${h} 0 ${h}]
   /DataSource currentfile /ASCII85Decode filter >> image
${ascii85(rgb)}
`;
  }

  return new Blob([head + body + 'grestore\n%%EOF\n'], {type: 'application/postscript'});
}

/* ASCII85, the encoding PostScript expects. Roughly 25% overhead against 100%
   for plain hex, which on a large photograph is the difference between a file
   you can email and one you cannot. */
function ascii85(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 4) {
    const n = Math.min(4, bytes.length - i);
    let v = 0;
    for (let k = 0; k < 4; k++) v = (v * 256 + (k < n ? bytes[i + k] : 0)) >>> 0;
    if (v === 0 && n === 4) { out += 'z'; }
    else {
      const c = [];
      for (let k = 0; k < 5; k++) { c.unshift(v % 85); v = Math.floor(v / 85); }
      out += c.slice(0, n + 1).map(x => String.fromCharCode(x + 33)).join('');
    }
    if (out.length % 76 < 5) out += '\n';
  }
  return out + '~>';
}

/* ── GIF ──────────────────────────────────────────────────────────────
   No browser can encode GIF, so this writes one: quantise to 256 colours,
   then LZW-compress the indices. One frame only — turning a still image into
   an animation is not a thing a converter should invent. */
async function toGif(canvas) {
  const {width: w, height: h} = canvas;
  const px = canvas.getContext('2d').getImageData(0, 0, w, h).data;

  /* A 6×6×6 colour cube plus a 40-step grey ramp. A median cut would look
     better on a photograph, but this is deterministic, fast, and good enough
     that the difference only shows on gradients. */
  const palette = [];
  for (let r = 0; r < 6; r++) for (let g = 0; g < 6; g++) for (let b = 0; b < 6; b++) {
    palette.push([r * 51, g * 51, b * 51]);
  }
  for (let i = 0; i < 40; i++) { const v = Math.round(i * 255 / 39); palette.push([v, v, v]); }
  while (palette.length < 256) palette.push([0, 0, 0]);

  const idx = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < px.length; i += 4, p++) {
    const a = px[i + 3] / 255;
    const r = Math.round(px[i] * a + 255 * (1 - a));
    const g = Math.round(px[i + 1] * a + 255 * (1 - a));
    const b = Math.round(px[i + 2] * a + 255 * (1 - a));
    /* Grey pixels go to the ramp, which has far finer steps than the cube. */
    if (Math.max(r, g, b) - Math.min(r, g, b) < 12) {
      idx[p] = 216 + Math.min(39, Math.round((r + g + b) / 3 * 39 / 255));
    } else {
      idx[p] = Math.round(r / 51) * 36 + Math.round(g / 51) * 6 + Math.round(b / 51);
    }
  }

  const out = [];
  const push = (...b) => out.push(...b);
  const str = (s) => { for (const c of s) out.push(c.charCodeAt(0)); };
  str('GIF89a');
  push(w & 255, w >> 8, h & 255, h >> 8, 0xF7, 0, 0);       // logical screen, global table of 256
  for (const [r, g, b] of palette) push(r, g, b);
  push(0x2C, 0, 0, 0, 0, w & 255, w >> 8, h & 255, h >> 8, 0);  // image descriptor
  push(...lzw(idx, 8));
  push(0x3B);                                                    // trailer
  return new Blob([new Uint8Array(out)], {type: 'image/gif'});
}

function lzw(data, minCode) {
  const clear = 1 << minCode, end = clear + 1;
  let size = minCode + 1, next = end + 1;
  let dict = new Map();
  const reset = () => { dict = new Map(); next = end + 1; size = minCode + 1; };

  const bits = [];
  let acc = 0, accLen = 0;
  const emit = (code) => {
    acc |= code << accLen; accLen += size;
    while (accLen >= 8) { bits.push(acc & 255); acc >>= 8; accLen -= 8; }
  };

  emit(clear);
  let prefix = data[0];
  for (let i = 1; i < data.length; i++) {
    const k = data[i];
    const key = prefix * 256 + k;
    if (dict.has(key)) { prefix = dict.get(key); continue; }
    emit(prefix);
    dict.set(key, next++);
    if (next > (1 << size)) {
      if (size < 12) size++;
      else { emit(clear); reset(); }
    }
    prefix = k;
  }
  emit(prefix);
  emit(end);
  if (accLen > 0) bits.push(acc & 255);

  /* GIF stores the stream in sub-blocks of at most 255 bytes, each prefixed
     with its own length. */
  const out = [minCode];
  for (let i = 0; i < bits.length; i += 255) {
    const chunk = bits.slice(i, i + 255);
    out.push(chunk.length, ...chunk);
  }
  out.push(0);
  return out;
}

/* ── SVG ──────────────────────────────────────────────────────────────
   Real vector output: the picture is reduced to a handful of flat colours and
   each region becomes a path. It is a tracer, not a wrapper — an "image to
   SVG" that hides the original bitmap inside an <image> tag is a renamed PNG
   with extra steps, and it does not scale, which is the only reason anyone
   wants an SVG. */
async function toSvg(canvas) {
  const MAX = 220;   // trace small, scale the paths up
  const s = Math.min(1, MAX / Math.max(canvas.width, canvas.height));
  const w = Math.max(1, Math.round(canvas.width * s));
  const h = Math.max(1, Math.round(canvas.height * s));
  const small = document.createElement('canvas');
  small.width = w; small.height = h;
  small.getContext('2d').drawImage(canvas, 0, 0, w, h);
  const px = small.getContext('2d').getImageData(0, 0, w, h).data;

  const LEVELS = 4;                       // per channel — 64 possible colours
  const q = (v) => Math.round(v * (LEVELS - 1) / 255) * Math.round(255 / (LEVELS - 1));
  const key = new Int32Array(w * h);
  const seen = new Map();
  for (let i = 0, p = 0; i < px.length; i += 4, p++) {
    const a = px[i + 3] / 255;
    const r = q(Math.round(px[i] * a + 255 * (1 - a)));
    const g = q(Math.round(px[i + 1] * a + 255 * (1 - a)));
    const b = q(Math.round(px[i + 2] * a + 255 * (1 - a)));
    const k = (r << 16) | (g << 8) | b;
    key[p] = k;
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }

  /* Biggest area first, so the most common colour becomes the background rect
     and everything else is drawn over it. */
  const colours = [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const hex = (k) => '#' + k.toString(16).padStart(6, '0');
  const scale = canvas.width / w;

  let body = `<rect width="${canvas.width}" height="${canvas.height}" fill="${hex(colours[0])}"/>`;
  for (const c of colours.slice(1, 48)) {
    /* Run-length rectangles per row, merged vertically where a run repeats.
       Cruder than a contour tracer and far shorter, and on flat artwork —
       logos, screenshots, icons, which is what people vectorise — the output
       is identical. */
    const used = new Uint8Array(w * h);
    let d = '';
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if (used[p] || key[p] !== c) continue;
        let x2 = x;
        while (x2 + 1 < w && key[y * w + x2 + 1] === c && !used[y * w + x2 + 1]) x2++;
        let y2 = y;
        for (;;) {
          const ny = y2 + 1;
          if (ny >= h) break;
          let ok = true;
          for (let i = x; i <= x2; i++) if (key[ny * w + i] !== c || used[ny * w + i]) { ok = false; break; }
          if (!ok) break;
          y2 = ny;
        }
        for (let yy = y; yy <= y2; yy++) for (let xx = x; xx <= x2; xx++) used[yy * w + xx] = 1;
        const rx = Math.round(x * scale), ry = Math.round(y * scale);
        const rw = Math.round((x2 - x + 1) * scale), rh = Math.round((y2 - y + 1) * scale);
        d += `M${rx} ${ry}h${rw}v${rh}h${-rw}z`;
      }
    }
    if (d) body += `<path fill="${hex(c)}" d="${d}"/>`;
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}" `
    + `viewBox="0 0 ${canvas.width} ${canvas.height}" shape-rendering="crispEdges">${body}</svg>`;
  return new Blob([svg], {type: 'image/svg+xml'});
}

/* ── the front door ───────────────────────────────────────────────────── */

const EXT = {jpg: 'jpg', jpeg: 'jpg', png: 'png', webp: 'webp', gif: 'gif',
             ico: 'ico', eps: 'eps', svg: 'svg', avif: 'avif', bmp: 'bmp',
             pdf: 'pdf', txt: 'txt', image: 'jpg', picture: 'jpg'};

/* The heavy module carries pdf.js, pdf-lib and the HEIC decoder. It is fetched
   the first time a conversion actually needs one and never on a page that
   does not — a PNG-to-JPG page should not pay for a PDF engine. */
let heavy = null;
const engine = async () => (heavy ??= await import('./convert-engine.js'));

/* Anything that is not a picture in and a picture out. */
const TEXTUAL = {txt: 'text', md: 'text', csv: 'csv'};
/* Read as bytes rather than as text, and handed to a parser of their own. */
const BINARY_IN = {excel: 'excel', xls: 'excel', xlsx: 'excel', epub: 'epub'};

export async function convert(file, src, dst, onStep) {
  /* ── the PDF and document routes ── */
  if (src === 'pdf') return fromPdf(file, dst, onStep);
  if (dst === 'pdf') return toPdf(file, src);

  const kind = await sniff(file);
  if (!kind) {
    refuse('That file is not a picture the browser recognises. '
      + 'Check it opens in an image viewer first.');
  }
  const wanted = accepts(src);
  if (!wanted.includes(kind)) {
    /* "A, B, C or D" rather than "A or B or C or D" — the page that accepts
       seven formats reads as a sentence instead of a chant. */
    refuse(`This page converts ${list(wanted)} files, and that one is ${kind.toUpperCase()}.`
      + (CROSS[kind] ? ` Try ${CROSS[kind]} instead.` : ''));
  }

  const canvas = await toCanvas(file, kind);
  guardSize(canvas);

  switch (dst) {
    case 'jpg': case 'jpeg': return blobOf(matte(canvas), 'image/jpeg', 0.92);
    case 'png':  return blobOf(canvas, 'image/png');
    case 'webp': return blobOf(canvas, 'image/webp', 0.92);
    case 'ico':  return toIco(canvas);
    case 'eps':  return toEps(canvas, kind === 'jpg', file);
    case 'gif':  return toGif(canvas);
    case 'svg':  return toSvg(canvas);
    default:
      refuse(`Writing ${dst.toUpperCase()} is not something a browser can do yet.`);
  }
}

/* ── PDF in ───────────────────────────────────────────────────────────── */

async function fromPdf(file, dst, onStep) {
  if (await sniff(file) !== 'pdf') {
    refuse(`This page converts PDF files, and that one is `
      + `${(await sniff(file))?.toUpperCase() ?? 'not a format the browser knows'}.`);
  }
  const eng = await engine();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const base = file.name.replace(/\.[^.]+$/, '');

  if (dst === 'txt') return eng.pdfToText(bytes);
  if (dst === 'html') return eng.pdfToHtml(bytes, base);
  if (dst === 'xls' || dst === 'xlsx') {
    const {blob, rows} = await eng.pdfToSheet(bytes, dst);
    blob.rows = rows;
    return blob;
  }

  /* Three encoders behind one shape. BMP and TIFF have no browser writer so
     they go through ours; JPG and PNG are a canvas.toBlob. All of them hand
     back one file per page and are bundled the same way below. */
  const sheets =
    dst === 'bmp' ? await eng.pdfToBmp(bytes, base, onStep)
    : dst === 'tiff' ? await eng.pdfToTiff(bytes, base, onStep)
    : await eng.pdfToImages(bytes, dst === 'png' ? 'image/png' : 'image/jpeg', base, onStep);

  /* A single page comes back as the picture. Several come back as one zip,
     because thirty save dialogs in a row is not a download. */
  if (sheets.length === 1) return sheets[0].blob;
  const bundle = await eng.zip(sheets);
  bundle.multi = sheets.length;
  return bundle;
}

/* ── PDF out ──────────────────────────────────────────────────────────── */

async function toPdf(file, src) {
  const eng = await engine();
  const {imagesToPdf, textToPdf, csvToPdf, heicToCanvas} = eng;

  if (BINARY_IN[src]) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (BINARY_IN[src] === 'excel') return eng.excelToPdf(bytes);
    return eng.epubToPdf(bytes);
  }

  if (TEXTUAL[src]) {
    const text = await file.text();
    if (!text.trim()) refuse('That file is empty, so there is nothing to put in a PDF.');
    if (src === 'csv') return csvToPdf(text);
    return textToPdf(text, src === 'md');
  }

  const kind = await sniff(file);
  if (!kind) refuse('That file is not a picture the browser recognises.');
  const wanted = accepts(src);
  if (!wanted.includes(kind)) {
    refuse(`This page converts ${list(wanted)} files, and that one is ${kind.toUpperCase()}.`
      + (CROSS[kind] ? ` Try ${CROSS[kind]} instead.` : ''));
  }

  /* pdf-lib embeds JPEG and PNG directly, which keeps the original bytes and
     the original quality. Everything else has to go through a canvas first,
     and is re-encoded as PNG so nothing is thrown away on the way. */
  let bytes, embedAs;
  if (kind === 'jpg') {
    bytes = new Uint8Array(await file.arrayBuffer());
    embedAs = 'jpg';
  } else {
    const canvas = kind === 'heic'
      ? await heicToCanvas(new Uint8Array(await file.arrayBuffer()))
      : await toCanvas(file, kind);
    guardSize(canvas);
    bytes = new Uint8Array(await (await blobOf(canvas, 'image/png')).arrayBuffer());
    embedAs = 'png';
  }
  return imagesToPdf([{bytes, kind: embedAs}]);
}

const list = (names) => {
  const up = names.map(k => k.toUpperCase());
  return up.length > 1 ? `${up.slice(0, -1).join(', ')} or ${up.at(-1)}` : up[0];
};

function guardSize(canvas) {
  if (!canvas.width || !canvas.height) refuse('That image has no size the browser could work out.');
  if (canvas.width * canvas.height > 64e6) {
    refuse(`That image is ${canvas.width}×${canvas.height}, which is larger than the browser `
      + 'can hold in a canvas. Scale it down first.');
  }
}

/* Where to send somebody who brought the wrong file to the right page. */
const CROSS = {
  jpg: 'Image to JPG', png: 'Image to PNG', webp: 'WEBP to JPG',
  avif: 'AVIF to JPG', gif: 'Image to GIF', svg: 'SVG to PNG',
  heic: 'HEIC to JPG', pdf: 'the PDF converters',
};

export const outName = (name, dst) =>
  name.replace(/\.[^.]+$/, '') + '.' + (EXT[dst] ?? dst);

export {Refused};
