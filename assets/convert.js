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
   means "any picture", which is exactly what the page promises.
 *
 * A source whose key is not itself a file extension has to be listed here.
 * Without an entry the fallback below hands back the key, and the picker is
 * then built out of it — which is how `word-to-pdf` came to filter for `*.word`
 * and hide every .docx on the machine. Drag and drop was unaffected, because
 * the browser applies `accept` to the dialog only, so one route took the file
 * and the other refused to show it. */
const ACCEPTS = {
  image: ['jpg', 'png', 'webp', 'avif', 'gif', 'bmp', 'svg'],
  jpg: ['jpg'], jpeg: ['jpg'], jfif: ['jpg'],
  png: ['png'], webp: ['webp'], avif: ['avif'], svg: ['svg'],
  heic: ['heic'], gif: ['gif'], bmp: ['bmp'], tiff: ['tiff'],
  /* "Word" is one thing to a reader, so the page keeps that name and the
     picker takes both of the files it can mean. */
  word: ['docx', 'doc'],
  video: ['mp4'],
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
/* An ICO carries several sizes, and Windows picks whichever fits the place it
   is drawing: 16 in a title bar, 32 on the desktop, 48 in a list, 256 for a
   large tile. This used to write only the largest, which is a file Windows
   accepts and then downsamples itself — a 256-pixel logo squeezed into 16
   pixels by a general-purpose filter, which is exactly the smudge people are
   trying to avoid by making an icon in the first place. Each size is now
   drawn from the source at that size instead.

   Sizes larger than the source are skipped rather than upscaled: an icon
   invented out of pixels that were never there is worse than one Windows
   scales up itself, and the entry would only claim detail it does not have. */
const ICO_SIZES = [16, 32, 48, 64, 128, 256];

async function toIco(canvas) {
  const longest = Math.max(canvas.width, canvas.height);
  const wanted = ICO_SIZES.filter(s => s <= longest);
  if (!wanted.length) wanted.push(ICO_SIZES.find(s => s >= longest) ?? 16);

  const images = [];
  for (const side of wanted) {
    const square = document.createElement('canvas');
    square.width = square.height = side;
    const ctx = square.getContext('2d');
    /* Letterboxed rather than stretched: an icon of a squashed logo is worse
       than an icon with a little space around it. */
    const s = Math.min(side / canvas.width, side / canvas.height);
    const w = Math.round(canvas.width * s), h = Math.round(canvas.height * s);
    ctx.drawImage(canvas, Math.round((side - w) / 2), Math.round((side - h) / 2), w, h);
    images.push({side, png: new Uint8Array(await (await blobOf(square, 'image/png')).arrayBuffer())});
  }

  const headSize = 6 + images.length * 16;
  const out = new Uint8Array(headSize + images.reduce((n, i) => n + i.png.length, 0));
  const dv = new DataView(out.buffer);
  dv.setUint16(0, 0, true);              // reserved
  dv.setUint16(2, 1, true);              // type: icon
  dv.setUint16(4, images.length, true);
  let at = headSize;
  images.forEach(({side, png}, n) => {
    const o = 6 + n * 16;
    out[o] = side >= 256 ? 0 : side;     // 0 means 256
    out[o + 1] = side >= 256 ? 0 : side;
    out[o + 2] = 0;                      // palette
    out[o + 3] = 0;                      // reserved
    dv.setUint16(o + 4, 1, true);        // colour planes
    dv.setUint16(o + 6, 32, true);       // bits per pixel
    dv.setUint32(o + 8, png.length, true);
    dv.setUint32(o + 12, at, true);
    out.set(png, at);
    at += png.length;
  });
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
/* A 6×6×6 colour cube plus a 40-step grey ramp. A median cut would look better
   on a photograph, but this is deterministic, fast, and good enough that the
   difference only shows on gradients. Built once: every frame of an animation
   shares one global table, which is also what keeps the file small. */
const GIF_PALETTE = (() => {
  const p = [];
  for (let r = 0; r < 6; r++) for (let g = 0; g < 6; g++) for (let b = 0; b < 6; b++) {
    p.push([r * 51, g * 51, b * 51]);
  }
  for (let i = 0; i < 40; i++) { const v = Math.round(i * 255 / 39); p.push([v, v, v]); }
  while (p.length < 256) p.push([0, 0, 0]);
  return p;
})();

function quantise(canvas) {
  const {width: w, height: h} = canvas;
  const px = canvas.getContext('2d').getImageData(0, 0, w, h).data;
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
  return idx;
}

/* One frame is a still image; several are an animation. The difference in the
   file is two blocks: a Netscape application extension, which is the only way
   a viewer is told to loop at all, and a graphic control extension before each
   frame carrying its delay. */
function gifBytes(frames, delayCs) {
  const {width: w, height: h} = frames[0];
  const out = [];
  /* Appended one at a time rather than spread into push(). The LZW stream for
     a large frame runs to hundreds of thousands of bytes, and spreading an
     array that size into a call overflows the argument stack. */
  const cat = (arr) => { for (let i = 0; i < arr.length; i++) out.push(arr[i]); };
  const push = (...b) => cat(b);
  const str = (s) => { for (const c of s) out.push(c.charCodeAt(0)); };

  str('GIF89a');
  push(w & 255, w >> 8, h & 255, h >> 8, 0xF7, 0, 0);       // logical screen, global table of 256
  for (const [r, g, b] of GIF_PALETTE) push(r, g, b);

  if (frames.length > 1) {
    push(0x21, 0xFF, 11);
    str('NETSCAPE2.0');
    push(3, 1, 0, 0, 0);                                     // sub-block: loop forever
  }
  for (const frame of frames) {
    if (frames.length > 1) {
      push(0x21, 0xF9, 4, 0x04, delayCs & 255, delayCs >> 8, 0, 0);   // dispose to background
    }
    push(0x2C, 0, 0, 0, 0, w & 255, w >> 8, h & 255, h >> 8, 0);      // image descriptor
    cat(lzw(quantise(frame), 8));
  }
  push(0x3B);                                                        // trailer
  return new Uint8Array(out);
}

async function toGif(canvas) {
  return new Blob([gifBytes([canvas], 0)], {type: 'image/gif'});
}

/* ── video to GIF ─────────────────────────────────────────────────────
 * The browser already decodes video; what it will not do is hand over the
 * frames, so they are seeked one at a time and drawn onto a canvas. That is
 * slower than reading the file directly, and it is the only way that works in
 * every engine without shipping a demuxer.
 *
 * The limits below are the point of the feature rather than a compromise in
 * it. A GIF stores every frame as a full 256-colour image with no motion
 * compensation, so a minute of 1080p becomes a file of several hundred
 * megabytes that no chat app will accept and no browser will finish building.
 * Six seconds at 8 frames a second, 480 pixels wide, lands around a megabyte —
 * which is what a GIF is actually for. A longer clip is cut, and the caller
 * is told how much was taken rather than left to wonder. */
const GIF_MAX_SECONDS = 6, GIF_FPS = 8, GIF_MAX_WIDTH = 480;

async function videoToGif(file, onStep) {
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const brand = String.fromCharCode(...head.slice(4, 8));
  const webm = head[0] === 0x1A && head[1] === 0x45 && head[2] === 0xDF && head[3] === 0xA3;
  if (brand !== 'ftyp' && !webm) {
    refuse('That file is not a video the browser recognises. MP4, WEBM and MOV work here.');
  }

  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';

  try {
    await new Promise((ok, no) => {
      video.onloadedmetadata = ok;
      video.onerror = () => no(new Refused('The browser could not decode that video. '
        + 'It may use a codec this browser has no licence for — H.265 and ProRes are the '
        + 'usual ones. Re-encode it as H.264 MP4 first.'));
      video.src = url;
    });

    if (!video.videoWidth || !video.videoHeight) {
      refuse('That file has a sound track but no picture, so there are no frames to put in a GIF.');
    }
    const span = video.duration;
    if (!isFinite(span) || span <= 0) {
      refuse('That video does not say how long it is, which usually means the file is '
        + 'truncated or still being written.');
    }

    const scale = Math.min(1, GIF_MAX_WIDTH / video.videoWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const ctx = canvas.getContext('2d');

    const taken = Math.min(span, GIF_MAX_SECONDS);
    const count = Math.max(1, Math.round(taken * GIF_FPS));
    const frames = [];
    for (let n = 0; n < count; n++) {
      /* Held just inside the end: seeking to exactly duration lands past the
         last frame in several engines and draws nothing. */
      const at = Math.min(taken * (n / count), span - 1e-3);
      await new Promise((ok, no) => {
        video.onseeked = ok;
        video.onerror = () => no(new Refused('The video stopped decoding partway through.'));
        video.currentTime = at;
      });
      const shot = document.createElement('canvas');
      shot.width = canvas.width;
      shot.height = canvas.height;
      shot.getContext('2d').drawImage(video, 0, 0, shot.width, shot.height);
      frames.push(shot);
      onStep?.(n + 1, count);
      /* Yields between frames so the page can paint its progress. */
      await new Promise(r => setTimeout(r, 0));
    }

    const blob = new Blob([gifBytes(frames, Math.round(100 / GIF_FPS))], {type: 'image/gif'});
    if (span > GIF_MAX_SECONDS) blob.note = `First ${GIF_MAX_SECONDS} seconds of ${span.toFixed(1)}.`;
    return blob;
  } finally {
    video.src = '';
    URL.revokeObjectURL(url);
  }
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
             pdf: 'pdf', txt: 'txt', rtf: 'rtf', word: 'docx', docx: 'docx',
             /* The friendly names people search for are not file extensions:
                nobody's operating system opens a file called "report.excel". */
             excel: 'xlsx', powerpoint: 'pptx', pptx: 'pptx', epub: 'epub',
             image: 'jpg', picture: 'jpg'};

/* The heavy module carries pdf.js, pdf-lib and the HEIC decoder. It is fetched
   the first time a conversion actually needs one and never on a page that
   does not — a PNG-to-JPG page should not pay for a PDF engine. */
let heavy = null;
const engine = async () => (heavy ??= await import('./convert-engine.js'));

/* Anything that is not a picture in and a picture out. */
const TEXTUAL = {txt: 'text', csv: 'csv'};
/* Read as bytes rather than as text, and handed to a parser of their own.
   TIFF and AI are here because no browser will put either in an <img>: one
   needs a decoder of its own, and the other is a PDF wearing another suffix. */
/* `PK\x03\x04` — the local file header a zip begins with. Used to tell the two
   Word formats apart, which is the one place a source key covers both a zipped
   and an unzipped format. */
const looksZipped = (bytes) =>
  bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;

const BINARY_IN = {excel: 'excel', xls: 'excel', xlsx: 'excel', epub: 'epub',
                   tiff: 'tiff', ai: 'ai',
                   /* A .docx is a zip of XML; WPS Office writes the same thing
                      under its own extension, so it reads through the same door.
                      So do .pptx, .odt and .pages — four office formats, four
                      parsers, one shape of file underneath all of them.

                      `ppt` is the 1997 binary format and shares none of that:
                      an OLE compound file with its own record stream, read by
                      a parser written for it alone. */
                   word: 'docx', docx: 'docx', doc: 'docx', wps: 'docx',
                   pptx: 'pptx', powerpoint: 'pptx', ppt: 'ppt',
                   odt: 'odt', pages: 'pages',
                   rtf: 'rtf', html: 'html', dxf: 'dxf'};

/* Documents that become pictures. There is no second renderer for these: the
   document is laid out as a PDF by the reader it already has, and the PDF is
   rasterised by the one that already draws pages on screen. Going straight
   from Word to a JPEG would mean a third text layout engine agreeing with the
   other two, which is how two of them end up disagreeing. */
const VIA_PDF = {docx: 'docx', word: 'docx', html: 'html'};

export async function convert(file, src, dst, onStep) {
  /* ── the PDF and document routes ── */
  if (src === 'pdf') return fromPdf(file, dst, onStep);
  if (dst === 'pdf') return toPdf(file, src);
  if (src === 'video' || src === 'mp4') return videoToGif(file, onStep);
  if (VIA_PDF[src] && PICTURE_OUT.has(dst)) return viaPdf(file, src, dst, onStep);

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

  /* Vector out of vector, so this one must not touch a canvas: rasterising an
     SVG to trace it back into CAD geometry would throw away the exact curves
     the file already has. */
  if (dst === 'dxf') {
    const {svgToDxf} = await engine();
    return svgToDxf(await file.text());
  }

  const canvas = await toCanvas(file, kind);
  guardSize(canvas);

  /* A picture into an Office document. These go through the engine rather than
     the switch below, because the output is a zip of XML and not a re-encode
     of the canvas — and because the engine is where JSZip already lives. */
  if (dst === 'word' || dst === 'excel') {
    const eng = await engine();
    const png = new Uint8Array(await (await blobOf(canvas, 'image/png')).arrayBuffer());
    return dst === 'word'
      ? eng.imageToWord(png, 'png', canvas.width, canvas.height)
      : eng.imageToExcel(png, 'png', canvas.width, canvas.height);
  }

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

const PICTURE_OUT = new Set(['jpg', 'jpeg', 'png', 'image', 'picture']);

async function viaPdf(file, src, dst, onStep) {
  const eng = await engine();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const base = file.name.replace(/\.[^.]+$/, '');
  const laid = VIA_PDF[src] === 'docx' ? await eng.docxToPdf(bytes) : await eng.htmlToPdf(bytes);
  return bundleSheets(eng, await eng.pdfToImages(
    new Uint8Array(await laid.arrayBuffer()),
    dst === 'png' ? 'image/png' : 'image/jpeg', base, onStep));
}

/* ── PDF in ───────────────────────────────────────────────────────────── */

/* A single page comes back as the picture. Several come back as one zip,
   because thirty save dialogs in a row is not a download. */
async function bundleSheets(eng, sheets) {
  if (sheets.length === 1) return sheets[0].blob;
  const bundle = await eng.zip(sheets);
  bundle.multi = sheets.length;
  return bundle;
}

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
  if (dst === 'rtf') return eng.pdfToRtf(bytes);
  if (dst === 'word') return eng.pdfToWord(bytes);
  if (dst === 'pptx') return eng.pdfToPptx(bytes, base);
  if (dst === 'epub') return eng.pdfToEpub(bytes, base, onStep);
  if (dst === 'dxf') return bundleSheets(eng, await eng.pdfToDxfSheets(bytes, base));
  if (dst === 'svg') return bundleSheets(eng, await eng.pdfToSvgSheets(bytes, base));
  /* 'excel' as well as the two extensions. The page called "PDF to Excel" was
     reaching the picture branch below and handing back JPEGs of the pages,
     because the only names checked here were the ones ending in .xls. */
  if (dst === 'xls' || dst === 'xlsx' || dst === 'excel') {
    /* SheetJS is given a workbook type, not a page name, and "excel" is not
       one — it threw rather than writing a file. */
    const {blob, rows} = await eng.pdfToSheet(bytes, dst === 'xls' ? 'xls' : 'xlsx');
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
  return bundleSheets(eng, sheets);
}

/* ── PDF out ──────────────────────────────────────────────────────────── */

async function toPdf(file, src) {
  const eng = await engine();
  const {imagesToPdf, textToPdf, csvToPdf, heicToCanvas} = eng;

  if (BINARY_IN[src]) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    switch (BINARY_IN[src]) {
      case 'excel': return eng.excelToPdf(bytes);
      /* "Word" is one name over two formats that share nothing: a .docx is a zip
         of XML, a .doc is an OLE compound file. The extension is not evidence —
         a .doc renamed to .docx is a thing people do, and the file itself says
         which it is in its first two bytes. So the reader is chosen by looking. */
      case 'docx':  return looksZipped(bytes) ? eng.docxToPdf(bytes) : eng.docToPdf(bytes);
      case 'pptx':  return eng.pptxToPdf(bytes);
      case 'ppt':   return eng.pptToPdf(bytes);
      case 'odt':   return eng.odtToPdf(bytes);
      case 'pages': return eng.pagesToPdf(bytes);
      case 'rtf':   return eng.rtfToPdf(bytes);
      case 'html':  return eng.htmlToPdf(bytes);
      case 'dxf':   return eng.dxfToPdf(bytes);
      case 'tiff':  return eng.tiffToPdf(bytes);
      case 'ai':    return eng.aiToPdf(bytes);
      default:      return eng.epubToPdf(bytes);
    }
  }

  if (TEXTUAL[src]) {
    const text = await file.text();
    if (!text.trim()) refuse('That file is empty, so there is nothing to put in a PDF.');
    if (src === 'csv') return csvToPdf(text);
    return textToPdf(text);
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
