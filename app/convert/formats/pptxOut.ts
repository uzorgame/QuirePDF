/* A PDF's words, one slide per page.
 *
 * A .pptx is a zip of XML, the same trick that makes .docx possible here — but
 * PowerPoint is far less forgiving than Word about the package around the
 * markup. Word will open a document that is nothing but [Content_Types].xml,
 * _rels/.rels and document.xml; PowerPoint wants a presentation, a master, a
 * layout and a theme, every one of them declared in [Content_Types].xml and
 * reachable by a relationship id, and it reports "the file is corrupt" rather
 * than opening what it can. So the parts below are not decoration: each one is
 * there because leaving it out is a file that does not open.
 *
 * What goes on the slides is what a PDF can honestly give — the words, and
 * where the lines broke. A PDF has no slides, no titles and no bullet lists to
 * recover; it has glyphs at coordinates. Promoting the first line of a page to
 * <p:title> because it happened to be short would be inventing structure, and a
 * deck that looks deliberately organised while being organised at random is
 * worse than a plain one. So: one text frame per slide, the page's lines in
 * order, no bullets, nothing claimed that was not there.
 *
 * The pictures on the page do not come across, and neither does the layout. If
 * the look of the page is what matters, PDF to JPG is the honest route.
 */
import {Refused} from '../heavy.ts';
import {pdfjs} from '../../core/pdfjs.ts';

const refuse = (m: string): never => { throw new Refused(m); };

/* ── the shape of a slide ──────────────────────────────────────────────── */

/* EMU — English Metric Units, 914400 to the inch, which is how Office measures
   everything. 12192000 × 6858000 is 13.333 × 7.5 inches: the 16:9 slide
   PowerPoint has created by default since 2013. */
const EMU_INCH = 914400;
const EMU_POINT = 12700;
const SLIDE_W = 12192000, SLIDE_H = 6858000;

/* Half an inch of air around the text frame, and the frame's own padding
   inside that — PowerPoint applies both, so both have to come off before the
   text is measured against what is left. */
const MARGIN = EMU_INCH / 2;
const INSET_X = 91440, INSET_Y = 45720;
const FRAME_W = SLIDE_W - MARGIN * 2, FRAME_H = SLIDE_H - MARGIN * 2;
const TEXT_W = (FRAME_W - INSET_X * 2) / EMU_POINT;
const TEXT_H = (FRAME_H - INSET_Y * 2) / EMU_POINT;

/* A4 holds more text than a slide does. A full page of prose is around fifty
   lines, and fifty lines only fit across seven and a half inches if they are
   small — so the size is searched downwards rather than fixed. */
const MAX_PT = 24, MIN_PT = 8;
/* Arial's ascent and descent come to 1.117 em; 1.2 is the single-spaced line
   PowerPoint actually sets, with the leading it adds. */
const LEADING = 1.2;

/* ── measuring ─────────────────────────────────────────────────────────── */

/* Helvetica's advance widths for printable ASCII, in thousandths of an em,
   from the metrics Adobe published. Arial's are identical — that is the whole
   reason the theme below asks for Arial rather than the Calibri PowerPoint
   would otherwise supply: it means the wrapping estimated here is the wrapping
   the reader will draw, so the chosen size actually fits instead of nearly
   fitting. (On Linux the substitute is Liberation Sans, which was drawn to the
   same metrics for exactly this reason.) */
const ASCII_W = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

/* Han, kana, Hangul and the fullwidth forms are drawn on a square body whatever
   face renders them, so one of them is worth nearly two Latin letters. Getting
   this wrong is the difference between a page of Japanese sized as if it were
   half as long and a page that fits. */
function isFullWidth(code: number): boolean {
  return (code >= 0x1100 && code <= 0x11ff)      // Hangul Jamo
    || (code >= 0x2e80 && code <= 0xa4cf)        // radicals through Yi
    || (code >= 0xac00 && code <= 0xd7af)        // Hangul syllables
    || (code >= 0xf900 && code <= 0xfaff)        // compatibility ideographs
    || (code >= 0xfe30 && code <= 0xfe4f)
    || (code >= 0xff00 && code <= 0xff60)        // fullwidth forms
    || code >= 0x20000;                          // the supplementary planes
}

/* Everything outside ASCII that is not square gets the width of a lowercase
   letter, which is what most of Latin-1, Greek and Cyrillic actually are. */
function emWidth(code: number): number {
  if (code >= 0x20 && code <= 0x7e) return ASCII_W[code - 0x20]!;
  return isFullWidth(code) ? 1000 : 556;
}

function textWidth(text: string, size: number): number {
  let em = 0;
  for (const ch of text) em += emWidth(ch.codePointAt(0)!);
  return (em / 1000) * size;
}

/* How many rows a line of text will occupy once the reader has wrapped it. */
function rowsFor(line: string, size: number): number {
  if (!line) return 1;
  let rows = 1, used = 0;
  /* Split keeping the runs of spaces, so a break lands between words and the
     space that caused it is not carried onto the next row. */
  for (const word of line.split(/(\s+)/)) {
    const w = textWidth(word, size);
    if (used > 0 && used + w > TEXT_W) {
      rows++;
      used = /^\s/.test(word) ? 0 : w;
    } else {
      used += w;
    }
    /* A single word wider than the frame is not wrapped but broken, as many
       times as it takes. */
    while (used > TEXT_W) { rows++; used -= TEXT_W; }
  }
  return rows;
}

function heightAt(lines: string[], size: number): number {
  let rows = 0;
  for (const line of lines) rows += rowsFor(line, size);
  return rows * size * LEADING;
}

/* The largest size at which the page still fits the frame, and the extra shrink
 * to ask for when even the smallest readable size does not.
 *
 * Sized per slide rather than per deck: a title page set in the same 8pt as the
 * densest page in the document would be unreadable for no reason, and per-shape
 * is what PowerPoint's own autofit does anyway.
 *
 * Below the floor the run keeps its readable size and the shrink goes into
 * <a:normAutofit fontScale="…">, which is exactly how PowerPoint records a box
 * it has had to squeeze — delete a few lines later and the text springs back to
 * the size stored on the runs. Letting it overflow instead is the one outcome
 * worth ruling out: text past the bottom edge is merely untidy in the editor,
 * but in a slideshow it is off the screen and gone. */
function fitSize(lines: string[]): {size: number; percent: number} {
  for (let size = MAX_PT; size >= MIN_PT; size--) {
    if (heightAt(lines, size) <= TEXT_H) return {size, percent: 100};
  }
  /* Five per cent at a time, counted in whole percent so the value written into
     the file is exact, and never below a quarter: a page needing less than that
     holds several hundred lines, and no arithmetic makes those readable on a
     slide. Such a page comes out complete and very small, which is the truth
     about what was asked for. */
  let percent = 100;
  while (percent > 25 && heightAt(lines, MIN_PT * (percent / 100)) > TEXT_H) percent -= 5;
  return {size: MIN_PT, percent};
}

/* ── reading the PDF ───────────────────────────────────────────────────── */

/* pdfToText in the engine would give the same words, but it joins the whole
   document into one string — and one slide per page needs the page boundaries,
   which are exactly what that join throws away. The line rule is its rule
   though: pdf.js records where the source broke a line in `hasEOL`, and that is
   the only honest place to break one. Reconstructing lines from coordinates
   instead turns a two-column page into nonsense. */
async function pagesOfLines(bytes: Uint8Array): Promise<string[][]> {
  const task = pdfjs.getDocument({data: bytes.slice()});
  let doc;
  try {
    doc = await task.promise;
  } catch (err) {
    await task.destroy().catch(() => {});
    return refuse(/password/i.test(String((err as Error)?.message))
      ? 'That PDF is password protected, so its pages cannot be read.'
      : 'That file could not be opened as a PDF. It may be damaged.');
  }

  const pages: string[][] = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const content = await (await doc.getPage(n)).getTextContent();
      const lines: string[] = [];
      let line = '';
      for (const item of content.items) {
        if (!('str' in item)) continue;
        line += item.str;
        if (item.hasEOL) { lines.push(line); line = ''; }
      }
      if (line) lines.push(line);
      pages.push(tidyPage(lines));
    }
  } finally {
    await task.destroy().catch(() => {});
  }
  return pages;
}

/* One blank line between paragraphs is information. Six of them are the
   original's page furniture, and on a slide they cost the space the words
   needed. */
function tidyPage(lines: string[]): string[] {
  const out: string[] = [];
  for (const raw of lines) {
    const line = tidyLine(raw);
    if (!line && (!out.length || !out[out.length - 1])) continue;
    out.push(line);
  }
  while (out.length && !out[out.length - 1]) out.pop();
  return out;
}

/* XML 1.0 has no escape for a control byte, and PowerPoint rejects the whole
   package rather than the one character — a stray 0x0C out of a PDF would
   otherwise cost the entire conversion. Lone surrogates and the two permanently
   unassigned code points are illegal for the same reason. A tab is dropped to a
   space because inside <a:t> it is not a tab stop, it is a character the reader
   has no width for. */
function tidyLine(text: string): string {
  let out = '';
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c === 0x09) { out += ' '; continue; }
    if (c < 0x20 || c === 0x7f) continue;
    if (c >= 0xd800 && c <= 0xdfff) continue;
    if (c === 0xfffe || c === 0xffff) continue;
    out += ch;
  }
  return out.replace(/\s+$/, '');
}

const esc = (s: string) => s
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/* ── the parts ─────────────────────────────────────────────────────────── */

const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const NS_P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const NS_A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const NS_R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const PML = 'application/vnd.openxmlformats-officedocument.presentationml';

const rels = (items: Array<{id: string; type: string; target: string}>) =>
  HEAD + `<Relationships xmlns="${PKG}">`
  + items.map(i => `<Relationship Id="${i.id}" Type="${i.type}" Target="${i.target}"/>`).join('')
  + '</Relationships>';

/* Every part that is not covered by a Default extension has to be named here,
   with the content type PowerPoint expects for it. A missing Override is the
   single most common reason a hand-built deck opens as "repair?" — the part is
   in the zip, the relationship points at it, and the reader still refuses it
   because it does not know what it is. */
function contentTypes(slides: number): string {
  const override = (part: string, type: string) =>
    `<Override PartName="${part}" ContentType="${type}"/>`;
  let out = HEAD
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + override('/ppt/presentation.xml', `${PML}.presentation.main+xml`)
    + override('/ppt/slideMasters/slideMaster1.xml', `${PML}.slideMaster+xml`)
    + override('/ppt/slideLayouts/slideLayout1.xml', `${PML}.slideLayout+xml`)
    + override('/ppt/theme/theme1.xml',
      'application/vnd.openxmlformats-officedocument.theme+xml');
  for (let n = 1; n <= slides; n++) {
    out += override(`/ppt/slides/slide${n}.xml`, `${PML}.slide+xml`);
  }
  return out
    + override('/docProps/core.xml',
      'application/vnd.openxmlformats-package.core-properties+xml')
    + override('/docProps/app.xml',
      'application/vnd.openxmlformats-officedocument.extended-properties+xml')
    + '</Types>';
}

/* The slide ids in <p:sldIdLst> are the deck's own numbering and have nothing
   to do with the relationship ids beside them; PowerPoint requires them to be
   at least 256 and unique. The order of this list, not the file names, is the
   order the deck plays in. */
function presentation(slides: number): string {
  let ids = '';
  for (let n = 1; n <= slides; n++) {
    ids += `<p:sldId id="${255 + n}" r:id="rId${n + 1}"/>`;
  }
  return HEAD + `<p:presentation ${NS_A} ${NS_R} ${NS_P}>`
    + '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>'
    + `<p:sldIdLst>${ids}</p:sldIdLst>`
    + `<p:sldSz cx="${SLIDE_W}" cy="${SLIDE_H}"/>`
    /* Required by the schema even though this deck has no notes master and no
       notes pages: leave it out and the presentation part is invalid. */
    + '<p:notesSz cx="6858000" cy="9144000"/>'
    + '</p:presentation>';
}

function presentationRels(slides: number): string {
  const items = [{id: 'rId1', type: `${REL}/slideMaster`,
                  target: 'slideMasters/slideMaster1.xml'}];
  for (let n = 1; n <= slides; n++) {
    items.push({id: `rId${n + 1}`, type: `${REL}/slide`, target: `slides/slide${n}.xml`});
  }
  items.push({id: `rId${slides + 2}`, type: `${REL}/theme`, target: 'theme/theme1.xml'});
  return rels(items);
}

/* The empty shape tree every part that can hold shapes has to open with, even
   when it holds none. The group's id of 1 is conventional and the rest of the
   shapes on a slide count up from 2. */
const EMPTY_TREE = '<p:spTree>'
  + '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
  + '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>'
  + '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
  + '</p:spTree>';

/* <p:clrMap> is what makes "bg1" on a slide mean the theme's lt1. It is
   required on the master, and every slide and layout inherits it through
   <a:masterClrMapping/>. */
const CLR_MAP = '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1"'
  + ' accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5"'
  + ' accent6="accent6" hlink="hlink" folHlink="folHlink"/>';

const SLIDE_MASTER = HEAD + `<p:sldMaster ${NS_A} ${NS_R} ${NS_P}>`
  + '<p:cSld><p:bg><p:bgPr><a:solidFill><a:schemeClr val="lt1"/></a:solidFill>'
  + `<a:effectLst/></p:bgPr></p:bg>${EMPTY_TREE}</p:cSld>`
  + CLR_MAP
  + '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>'
  /* The default paragraph styles a slide falls back to. Bullets are switched
     off here as well as on the shape, because a reader that ignores one still
     honours the other. */
  + '<p:txStyles>'
  + '<p:titleStyle><a:lvl1pPr algn="l"><a:defRPr sz="3200"/></a:lvl1pPr></p:titleStyle>'
  + '<p:bodyStyle><a:lvl1pPr marL="0" indent="0"><a:buNone/>'
  + '<a:defRPr sz="1800"/></a:lvl1pPr></p:bodyStyle>'
  + '<p:otherStyle><a:lvl1pPr marL="0" indent="0"><a:buNone/>'
  + '<a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle>'
  + '</p:txStyles></p:sldMaster>';

const SLIDE_MASTER_RELS = rels([
  {id: 'rId1', type: `${REL}/slideLayout`, target: '../slideLayouts/slideLayout1.xml'},
  {id: 'rId2', type: `${REL}/theme`, target: '../theme/theme1.xml'},
]);

/* One layout, and it is the blank one. Every other layout in a real template
   exists to position placeholders this deck does not use, and a layout whose
   placeholders never appear on the slides is a layout that only shows up as
   phantom "click to add title" boxes the moment someone edits a slide. */
const SLIDE_LAYOUT = HEAD + `<p:sldLayout ${NS_A} ${NS_R} ${NS_P} type="blank" preserve="1">`
  + `<p:cSld name="Blank">${EMPTY_TREE}</p:cSld>`
  + '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>';

const SLIDE_LAYOUT_RELS = rels([
  {id: 'rId1', type: `${REL}/slideMaster`, target: '../slideMasters/slideMaster1.xml'},
]);

const SLIDE_RELS = rels([
  {id: 'rId1', type: `${REL}/slideLayout`, target: '../slideLayouts/slideLayout1.xml'},
]);

/* The theme is not optional and it is not nearly optional: a master with no
   theme relationship is a deck PowerPoint refuses. The schema also insists each
   of the four format lists carries at least three entries — one for each of the
   subtle/moderate/intense levels a shape style can ask for — so the plain fills
   below are repeated rather than written once. */
const THEME = HEAD
  + '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Quire">'
  + '<a:themeElements>'
  + '<a:clrScheme name="Quire">'
  + '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>'
  + '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>'
  + '<a:dk2><a:srgbClr val="17202E"/></a:dk2>'
  + '<a:lt2><a:srgbClr val="E7EAEF"/></a:lt2>'
  + '<a:accent1><a:srgbClr val="2B579A"/></a:accent1>'
  + '<a:accent2><a:srgbClr val="D24726"/></a:accent2>'
  + '<a:accent3><a:srgbClr val="217346"/></a:accent3>'
  + '<a:accent4><a:srgbClr val="7C3AED"/></a:accent4>'
  + '<a:accent5><a:srgbClr val="0F766E"/></a:accent5>'
  + '<a:accent6><a:srgbClr val="B45309"/></a:accent6>'
  + '<a:hlink><a:srgbClr val="0563C1"/></a:hlink>'
  + '<a:folHlink><a:srgbClr val="954F72"/></a:folHlink>'
  + '</a:clrScheme>'
  + '<a:fontScheme name="Quire">'
  + '<a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>'
  + '<a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>'
  + '</a:fontScheme>'
  + '<a:fmtScheme name="Quire">'
  + '<a:fillStyleLst>'
  + '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'.repeat(3)
  + '</a:fillStyleLst>'
  + '<a:lnStyleLst>'
  + ('<a:ln w="9525" cap="flat" cmpd="sng" algn="ctr"><a:solidFill>'
    + '<a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>').repeat(3)
  + '</a:lnStyleLst>'
  + '<a:effectStyleLst>'
  + '<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3)
  + '</a:effectStyleLst>'
  + '<a:bgFillStyleLst>'
  + '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'.repeat(3)
  + '</a:bgFillStyleLst>'
  + '</a:fmtScheme></a:themeElements></a:theme>';

/* One page's lines in one text box. */
function slide(lines: string[]): string {
  const {size, percent} = fitSize(lines);
  const sz = Math.round(size * 100);
  /* fontScale is a percentage in thousandths, so 85% is written 85000. Bare
     <a:normAutofit/> still means "shrink this if more text is typed in". */
  const autofit = percent < 100
    ? `<a:normAutofit fontScale="${percent * 1000}"/>`
    : '<a:normAutofit/>';
  const para = (line: string) =>
    '<a:p><a:pPr marL="0" indent="0"><a:buNone/></a:pPr>'
    + (line
      ? `<a:r><a:rPr sz="${sz}"/><a:t>${esc(line)}</a:t></a:r>`
      : `<a:endParaRPr sz="${sz}"/>`)
    + '</a:p>';

  const body = (lines.length ? lines : ['']).map(para).join('');

  return HEAD + `<p:sld ${NS_A} ${NS_R} ${NS_P}><p:cSld><p:spTree>`
    + '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
    + '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>'
    + '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
    + '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Page text"/>'
    + '<p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
    + `<p:spPr><a:xfrm><a:off x="${MARGIN}" y="${MARGIN}"/>`
    + `<a:ext cx="${FRAME_W}" cy="${FRAME_H}"/></a:xfrm>`
    + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>'
    + '<p:txBody><a:bodyPr wrap="square" anchor="t"'
    + ` lIns="${INSET_X}" tIns="${INSET_Y}" rIns="${INSET_X}" bIns="${INSET_Y}">`
    + `${autofit}</a:bodyPr><a:lstStyle/>`
    + body
    + '</p:txBody></p:sp></p:spTree></p:cSld>'
    + '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>';
}

/* The producer is named as what it is. Writing "Microsoft Office PowerPoint"
   here is what most generators do and it is a small lie in a file that claims
   not to tell any. */
function appProps(slides: number): string {
  return HEAD
    + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"'
    + ' xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
    + '<PresentationFormat>Widescreen</PresentationFormat>'
    + `<Slides>${slides}</Slides>`
    + '<Application>Quire</Application>'
    + '</Properties>';
}

function coreProps(title: string | undefined, stamp: string): string {
  return HEAD
    + '<cp:coreProperties'
    + ' xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"'
    + ' xmlns:dc="http://purl.org/dc/elements/1.1/"'
    + ' xmlns:dcterms="http://purl.org/dc/terms/"'
    + ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
    + (title ? `<dc:title>${esc(tidyLine(title))}</dc:title>` : '')
    + `<dcterms:created xsi:type="dcterms:W3CDTF">${stamp}</dcterms:created>`
    + `<dcterms:modified xsi:type="dcterms:W3CDTF">${stamp}</dcterms:modified>`
    + '</cp:coreProperties>';
}

/* ── the conversion ────────────────────────────────────────────────────── */

/** A PDF's text as a deck: one slide per page, in a real .pptx package. */
export async function pdfToPptx(bytes: Uint8Array, title?: string): Promise<Blob> {
  const pages = await pagesOfLines(bytes);
  if (!pages.length) refuse('That PDF has no pages in it.');
  if (!pages.some(lines => lines.some(line => line.trim()))) {
    refuse('That PDF has no text in it — its pages are images, so there are no words to '
      + 'put on slides. Try PDF to JPG instead, which keeps the pages as pictures.');
  }

  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();

  /* [Content_Types].xml first. The package spec allows any order and every
     reader in practice looks it up by name, but a zip whose first entry is the
     part list is the one every Office tool writes, and matching that costs
     nothing. */
  zip.file('[Content_Types].xml', contentTypes(pages.length));
  zip.file('_rels/.rels', rels([
    {id: 'rId1', type: `${REL}/officeDocument`, target: 'ppt/presentation.xml'},
    {id: 'rId2', type: `${PKG}/metadata/core-properties`, target: 'docProps/core.xml'},
    {id: 'rId3', type: `${REL}/extended-properties`, target: 'docProps/app.xml'},
  ]));

  zip.file('docProps/core.xml', coreProps(title, new Date().toISOString().replace(/\.\d+Z$/, 'Z')));
  zip.file('docProps/app.xml', appProps(pages.length));

  zip.file('ppt/presentation.xml', presentation(pages.length));
  zip.file('ppt/_rels/presentation.xml.rels', presentationRels(pages.length));
  zip.file('ppt/slideMasters/slideMaster1.xml', SLIDE_MASTER);
  zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels', SLIDE_MASTER_RELS);
  zip.file('ppt/slideLayouts/slideLayout1.xml', SLIDE_LAYOUT);
  zip.file('ppt/slideLayouts/_rels/slideLayout1.xml.rels', SLIDE_LAYOUT_RELS);
  zip.file('ppt/theme/theme1.xml', THEME);

  pages.forEach((lines, i) => {
    zip.file(`ppt/slides/slide${i + 1}.xml`, slide(lines));
    zip.file(`ppt/slides/_rels/slide${i + 1}.xml.rels`, SLIDE_RELS);
  });

  const out = await zip.generateAsync({type: 'uint8array', compression: 'DEFLATE'});
  return new Blob([out.slice() as BlobPart], {
    type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  });
}
