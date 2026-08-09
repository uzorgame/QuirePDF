/* RTF into a PDF.
 *
 * RTF is plain ASCII with backslash control words, which makes it look like a
 * format you can clean up with a regular expression. You cannot: most of a real
 * RTF file is not the document. The font table, the colour table, the
 * stylesheet, the list and revision tables and every embedded picture are all
 * groups that sit ahead of the body, and a parser that only strips control
 * words opens its PDF with "Times New Roman;Symbol;Arial;" as the first
 * paragraph. That is the classic way this conversion is got wrong, and the only
 * thing that avoids it is walking the braces with a stack and dropping whole
 * destinations — which is what this does.
 *
 * What comes across is what textToPdf can honestly draw: paragraphs, line
 * breaks, tabs, and table rows flattened to tab-separated lines. Bold, colour,
 * point size, headers, footers and embedded pictures do not. There is no page
 * model on the other side to put them in, and a converter that invented one
 * would be lying about what it had recovered.
 */
import {textToPdf, Refused} from '../heavy.ts';

/* The engine defines its own; an instanceof check across the two is false even
   when both mean the same thing, so the name is what the caller matches on. */
const refuse = (m: string): never => { throw new Refused(m); };

/* Destinations whose contents are markup rather than the document.
 *
 * `\*\name` already says "skip this if you do not understand it" and is handled
 * on its own, but the tables that matter most here predate that convention and
 * are written bare: a Word file puts \fonttbl, \colortbl and \stylesheet in
 * front of every document without marking any of them ignorable. `pict` and
 * `object` are worse than noise — their contents are hex, by the megabyte.
 *
 * Headers and footers are dropped rather than kept because a stream of text has
 * no page corners to hang them on, and repeating the running head between every
 * paragraph is not what the author wrote. */
const SKIP = new Set([
  'filetbl', 'colortbl', 'stylesheet', 'listtable', 'listoverridetable',
  'revtbl', 'rsidtbl', 'generator', 'info', 'pict', 'shppict', 'nonshppict',
  'object', 'objdata', 'result',
  'header', 'headerl', 'headerr', 'headerf',
  'footer', 'footerl', 'footerr', 'footerf',
  'footnote', 'annotation', 'atnauthor', 'atndate', 'atnid', 'atnparent',
  'atnref', 'atntime', 'bkmkstart', 'bkmkend', 'fldinst',
  'datafield', 'docvar', 'falt', 'fname', 'ffname', 'keycode', 'mhtmltag',
  'nextfile', 'panose', 'pntxta', 'pntxtb', 'private', 'template',
  'themedata', 'colorschememapping', 'latentstyles', 'datastore',
  'xe', 'tc', 'txe', 'xmlopen', 'wgrffmtfilter',
]);

/* The punctuation RTF spells out instead of writing. Everything here is a
/* The punctuation RTF spells out instead of writing. Everything here is a
 * character the author typed, so it belongs in the text; the rest of the
 * thousand-odd control words are formatting and produce nothing.
 *
 * A Map rather than an object literal because the key is a control word taken
 * out of the file, and \constructor is a spelling a file is allowed to contain.
 * On an object literal that lookup reaches Object.prototype and comes back with
 * a function, whose source would then be printed into the document. */
const GLYPH = new Map<string, string>([
  ['emdash', '—'], ['endash', '–'], ['bullet', '•'],
  ['lquote', '‘'], ['rquote', '’'],
  ['ldblquote', '“'], ['rdblquote', '”'],
  ['emspace', ' '], ['enspace', ' '], ['qmspace', ' '],
]);

/* \fcharsetN, per font, to the code page its \'xx bytes are written in.
 *
 * This is the trap that ruins non-English RTF. A Word file declares
 * \ansicpg1252 once in its header and then switches charset per font, so a
 * Russian document is a cp1252 document containing runs tagged \f3\fcharset204
 * whose bytes are cp1251. Reading every byte with the header's code page turns
 * those runs into Latin-1 gibberish, and the file looks corrupt rather than
 * mistranslated. Charset 1 means "whatever the default is", which is why it
 * maps to zero and falls through to the document's own. */
const CHARSET: Record<number, number> = {
  0: 1252, 1: 0, 2: 1252, 77: 10000, 128: 932, 129: 949, 130: 1361,
  134: 936, 136: 950, 161: 1253, 162: 1254, 163: 1258, 177: 1255,
  178: 1256, 186: 1257, 204: 1251, 222: 874, 238: 1250, 255: 850,
};

/* What the 0x80–0x9F band of windows-1252 stands for, as code points.
 *
 * That band is decoded here rather than handed to TextDecoder, and it is worth
 * the thirty-two numbers: 1252 is the code page almost every RTF declares, and
 * this is the part of it that holds the curly quotes, the two dashes, the
 * ellipsis and the bullet — which is to say the characters that are actually in
 * a document somebody wrote. Above 0x9F the page is Latin-1 and needs no table.
 *
 * The reason not to delegate is that the delegates disagree. A browser follows
 * the WHATWG index and gets this right; Node's TextDecoder treats the whole of
 * windows-1252 as Latin-1, so every quotation mark comes back as a C1 control
 * code and the file looks corrupt. The table itself has not moved since 1998,
 * so the safe thing is to own it and be the same everywhere. The five slots the
 * page leaves undefined stay in the C1 range and are dropped downstream. */
const ANSI_HIGH = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021,
  0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x017d, 0x008f,
  0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
];

/* A code page number to the name TextDecoder knows it by. The browser ships
   decoders for every legacy encoding the WHATWG standard lists, which covers
   everything Word has written this century — but not the DOS code pages, and
   not Johab. Those come back null and are refused by name if, and only if, a
   byte actually turns up that needs one. */
function label(cp: number): string | null {
  if (cp >= 1250 && cp <= 1258) return `windows-${cp}`;
  switch (cp) {
    case 874: return 'windows-874';
    case 932: return 'shift_jis';
    case 936: return 'gbk';
    case 949: return 'euc-kr';
    case 950: return 'big5';
    case 10000: return 'macintosh';
    case 20866: return 'koi8-r';
    case 21866: return 'koi8-u';
    case 65001: return 'utf-8';
    default: return null;
  }
}

const BACKSLASH = 0x5c, OPEN = 0x7b, CLOSE = 0x7d, QUOTE = 0x27, STAR = 0x2a;
const CR = 0x0d, LF = 0x0a, SPACE = 0x20, MINUS = 0x2d;

const alpha = (b: number) => (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a);
const digit = (b: number) => b >= 0x30 && b <= 0x39;

function hex(b: number | undefined): number {
  if (b === undefined) return -1;
  if (b >= 0x30 && b <= 0x39) return b - 0x30;
  if (b >= 0x61 && b <= 0x66) return b - 0x57;
  if (b >= 0x41 && b <= 0x46) return b - 0x37;
  return -1;
}

function ascii(data: Uint8Array, from: number, to: number): string {
  let s = '';
  for (let k = from; k < to; k++) s += String.fromCharCode(data[k]!);
  return s;
}

/* Where the document starts, and a sentence naming the format if it is not one.
 *
 * The check is worth making before anything else because RTF's own error mode
 * is silence: hand this parser a .doc and it walks eight megabytes of binary
 * looking for braces and produces half a page of accidental letters, which is a
 * far worse answer than saying what the file is. */
function start(data: Uint8Array): number {
  /* A byte-order mark in front of a format defined as seven-bit ASCII is wrong,
     and editors write one anyway. Left in, it would come out as "ï»¿" at the
     head of the first paragraph. */
  let at = data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf ? 3 : 0;
  while (at < data.length && (data[at] === SPACE || data[at] === CR || data[at] === LF)) at++;

  if (ascii(data, at, Math.min(data.length, at + 5)) === '{\\rtf') return at;

  const head = ascii(data, 0, Math.min(data.length, 8));
  if (head.startsWith('%PDF')) refuse('That file is already a PDF.');
  if (head.startsWith('PK\x03\x04')) {
    refuse('That file is a zip archive rather than an RTF — a .docx renamed, most likely. '
      + 'Use Word to PDF for it.');
  }
  if (head.startsWith('\xd0\xcf\x11\xe0')) {
    refuse('That is a binary Word document from before Word 2007, not an RTF. Open it and '
      + 'save it again as RTF or DOCX first.');
  }
  return refuse('That file is not an RTF document. Every RTF begins with {\\rtf and this one '
    + 'does not — check the extension matches what the file actually is.');
}

interface Frame {
  /* Inside a destination that is markup, not body text. */
  skip: boolean;
  /* Inside {\fonttbl…}, where no text is wanted but \f and \fcharset are. */
  fonts: boolean;
  /* How many stand-in characters follow each \u, from \ucN. */
  uc: number;
  /* The code page this run's \'xx bytes are in; 0 means the document's own. */
  cp: number;
}

interface Reading {text: string; pictures: boolean}

/* The whole parser. Bytes rather than a string on purpose: \'xx is a byte in a
   legacy code page, and decoding the file to text first — with UTF-8, which is
   what File.text() does — turns every one of those bytes into U+FFFD before the
   parser ever sees it. */
function extract(data: Uint8Array, from: number): Reading {
  const n = data.length;
  const out: string[] = [];

  /* Text bytes accumulate rather than being decoded one at a time, because
     Shift-JIS, GBK and Big5 spend two bytes on a character and decoding either
     half alone gives nothing. The buffer is flushed whenever something that is
     not a byte comes along — a break, a \u escape, a change of code page — so a
     multi-byte character is always decoded whole. */
  let pend: number[] = [];
  let pendCp = 0;
  let docCp = 1252;

  const decoders = new Map<number, TextDecoder>();
  const utf8 = new TextDecoder();

  function decode(bytes: Uint8Array, cp: number): string {
    /* Every code page below is ASCII-transparent, so a document that never
       leaves ASCII never needs a decoder — and, more usefully, never has to be
       refused for naming a code page nobody ships one for. */
    let high = false;
    for (const b of bytes) if (b > 0x7f) { high = true; break; }
    if (!high) return utf8.decode(bytes);

    if (cp === 1252) {
      let s = '';
      for (const b of bytes) {
        s += String.fromCharCode(b >= 0x80 && b <= 0x9f ? ANSI_HIGH[b - 0x80]! : b);
      }
      return s;
    }

    const cached = decoders.get(cp);
    if (cached) return cached.decode(bytes);

    const name = label(cp);
    if (!name) {
      return refuse(`That RTF says its text is in code page ${cp}, which no browser carries a `
        + 'decoder for. Open it in a word processor and save it as RTF again — anything current '
        + 'writes Unicode escapes instead.');
    }
    let dec: TextDecoder;
    try {
      dec = new TextDecoder(name);
    } catch {
      return refuse(`This browser has no decoder for code page ${cp}, which is what that RTF `
        + 'says its text is written in.');
    }
    decoders.set(cp, dec);
    return dec.decode(bytes);
  }

  let cur: Frame = {skip: false, fonts: false, uc: 1, cp: 0};
  const stack: Frame[] = [];
  const fontCp = new Map<number, number>();
  let namedFont = -1;
  let pictures = false;
  let i = from;

  const live = () => !cur.skip && !cur.fonts;

  function flush(): void {
    if (!pend.length) return;
    out.push(decode(new Uint8Array(pend), pendCp || 1252));
    pend = [];
  }

  function byte(b: number): void {
    if (!live()) return;
    const cp = cur.cp || docCp;
    if (!pend.length) pendCp = cp;
    else if (pendCp !== cp) { flush(); pendCp = cp; }
    pend.push(b);
  }

  function emit(s: string): void {
    if (!live()) return;
    flush();
    out.push(s);
  }

  /* A control word is letters, then an optional signed integer, then a single
     space that belongs to the word rather than to the document. Shared with the
     \u stand-in skipper below, which has to be able to step over one too. */
  function scanWord(at: number): {name: string; param: number | null; end: number} {
    let j = at;
    while (j < n && alpha(data[j]!)) j++;
    const name = ascii(data, at, j);
    let param: number | null = null;
    const neg = data[j] === MINUS;
    const numAt = neg ? j + 1 : j;
    if (numAt < n && digit(data[numAt]!)) {
      let v = 0, k = numAt;
      while (k < n && digit(data[k]!)) { v = v * 10 + (data[k]! - 0x30); k++; }
      param = neg ? -v : v;
      j = k;
    }
    if (j < n && data[j] === SPACE) j++;
    return {name, param, end: j};
  }

  /* \binN is followed by exactly N raw bytes, and those bytes are arbitrary:
     they routinely contain braces and backslashes. Counting them out is the
     difference between a parser that survives an embedded picture and one whose
     group stack comes apart in the middle of one. */
  function skipBin(count: number | null): void {
    if (count && count > 0) i = Math.min(n, i + count);
  }

  function unicode(param: number | null): void {
    if (param !== null) {
      /* The value is a signed 16-bit number, so anything above U+7FFF arrives
         negative. Characters outside the basic plane arrive as two of them, the
         halves of a surrogate pair — appending both is all that is needed,
         because a JavaScript string is UTF-16 already. */
      const code = param < 0 ? param + 0x10000 : param;
      if (code >= 0 && code <= 0xffff) emit(String.fromCharCode(code));
    }
    /* Every \u carries a plain stand-in behind it for readers that predate
       Unicode, and \ucN says how many characters that stand-in is. Not stepping
       over them is how "Кіт" comes out as "К?і?т?". */
    let left = cur.uc;
    while (left > 0 && i < n) {
      const b = data[i]!;
      /* The stand-in cannot cross a group boundary, and stopping at one matters
         more than the count does: eating a closing brace unbalances everything
         after it. */
      if (b === OPEN || b === CLOSE) break;
      if (b === CR || b === LF) { i++; continue; }
      if (b === BACKSLASH) {
        const next = data[i + 1];
        if (next === QUOTE) i += 4;
        else if (next !== undefined && alpha(next)) i = scanWord(i + 1).end;
        else i += 2;
      } else i++;
      left--;
    }
  }

  function control(name: string, param: number | null): void {
    switch (name) {
      /* \bin and \u move the cursor themselves and have to run even inside a
         destination being skipped, or the skip ends in the wrong place. */
      case 'bin': skipBin(param); return;
      case 'u': unicode(param); return;

      case 'par': case 'line': case 'sect': case 'page':
      case 'row': case 'nestrow': case 'column': case 'softline':
        emit('\n'); return;
      /* A cell boundary becomes a tab and a row becomes a line, which is as far
         as a table can honestly be carried into a stream of text. */
      case 'tab': case 'cell': case 'nestcell': emit('\t'); return;

      case 'uc': if (param !== null && param >= 0) cur.uc = param; return;
      case 'ansicpg': if (param) docCp = param; return;
      case 'ansi': docCp = 1252; return;
      case 'mac': docCp = 10000; return;
      case 'pc': docCp = 437; return;
      case 'pca': docCp = 850; return;

      case 'fonttbl': cur.fonts = true; return;
      case 'f':
        if (param === null) return;
        if (cur.fonts) namedFont = param;
        else cur.cp = fontCp.get(param) ?? 0;
        return;
      case 'fcharset':
        if (cur.fonts && param !== null && namedFont >= 0) {
          fontCp.set(namedFont, CHARSET[param] ?? 0);
        }
        return;
      default: break;
    }

    if (SKIP.has(name)) {
      if (name === 'pict') pictures = true;
      cur.skip = true;
      return;
    }
    const glyph = GLYPH.get(name);
    if (glyph) emit(glyph);
  }

  function symbol(b: number): void {
    switch (b) {
      case BACKSLASH: case OPEN: case CLOSE: byte(b); return;
      case QUOTE: {
        const hi = hex(data[i]), lo = hex(data[i + 1]);
        if (hi >= 0 && lo >= 0) { i += 2; byte(hi * 16 + lo); }
        return;
      }
      /* \* marks the group it opens as ignorable — the format's own way of
         saying "skip this whole thing if you do not implement it", which covers
         comments, bookmarks, field instructions and generator stamps. */
      case STAR: cur.skip = true; return;
      case 0x7e: emit(' '); return;      // \~ non-breaking space
      case 0x5f: emit('‑'); return;      // \_ non-breaking hyphen
      /* \- is an optional hyphen: it marks where a word may break, and prints
         nothing unless it does. */
      case MINUS: return;
      /* A backslash immediately before the end of a source line is how older
         writers spell \par. */
      case CR: case LF: emit('\n'); return;
      default: return;
    }
  }

  while (i < n) {
    const b = data[i]!;
    if (b === BACKSLASH) {
      i++;
      const next = i < n ? data[i]! : -1;
      if (alpha(next)) {
        const w = scanWord(i);
        i = w.end;
        control(w.name, w.param);
      } else {
        i++;
        symbol(next);
      }
    } else if (b === OPEN) {
      stack.push(cur);
      cur = {...cur};
      i++;
    } else if (b === CLOSE) {
      cur = stack.pop() ?? cur;
      i++;
    } else if (b === CR || b === LF) {
      /* Line breaks in the source are how the writer kept its own lines short.
         They are not breaks in the document — \par is. */
      i++;
    } else {
      byte(b);
      i++;
    }
  }
  flush();
  return {text: out.join(''), pictures};
}

/* Control characters out; the tabs and breaks this parser put in stay.
 *
 * A loop rather than a regular expression, for the same reason the engine's own
 * cleaner is one: the ranges are control characters, and writing them as source
 * literals is how a file ends up with a NUL in it. Both bands go — a C0 byte is
 * a file that was never text, and a C1 code point means the source byte landed
 * in one of the slots its code page leaves undefined. Neither is printable, and
 * pdf-lib throws on the second sort rather than passing it over. */
function printable(text: string): string {
  let out = '';
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c === 0x0a || c === 0x09) { out += ch; continue; }
    if (c < 0x20 || c === 0x7f || (c >= 0x80 && c <= 0x9f)) continue;
    out += ch;
  }
  return out;
}

/* The scripts the embedded face has no glyphs for, and what to call them.
 *
 * Reading the characters is the easy half. The font on the other side is
 * DejaVu, which covers Latin, Cyrillic and Greek and stops there on purpose —
 * a face that also covers CJK is twenty megabytes, and unicodeFont.ts is
 * explicit that it is out of scope. Nothing complains on the way through:
 * pdf-lib embeds .notdef for every one of those characters and writes a
 * perfectly valid PDF full of blank boxes, which is precisely the kind of file
 * this converter exists not to hand back. So a document written in one of them
 * is refused by name instead.
 *
 * The share matters, not the presence. One kanji in a citation should not cost
 * an English report its conversion; a page of Japanese has nothing left at all
 * once the Japanese has gone. */
const UNDRAWABLE: Array<[number, number, string]> = [
  [0x0e00, 0x0e7f, 'Thai'],
  [0x1100, 0x11ff, 'Korean'],
  [0x3040, 0x30ff, 'Japanese'],
  [0x3400, 0x9fff, 'Chinese or Japanese'],
  [0xac00, 0xd7af, 'Korean'],
  [0xf900, 0xfaff, 'Chinese or Japanese'],
];

function unreadable(text: string): string | null {
  let letters = 0, missing = 0, script = '';
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c <= 0x20) continue;
    letters++;
    const band = UNDRAWABLE.find(([lo, hi]) => c >= lo && c <= hi);
    if (band) { missing++; if (!script) script = band[2]; }
  }
  return letters > 0 && missing * 20 > letters ? script : null;
}

export async function rtfToPdf(bytes: Uint8Array): Promise<Blob> {
  const reading = extract(bytes, start(bytes));

  const text = printable(reading.text)
    .replace(/[\t ]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!text) {
    refuse(reading.pictures
      ? 'That RTF has no words in it — its content is an embedded picture, and pictures are '
        + 'not carried across.'
      : 'That RTF has no text in it.');
  }

  const script = unreadable(text);
  if (script) {
    refuse(`That RTF is written in ${script}, and the font this embeds covers Latin, Cyrillic `
      + 'and Greek only — every one of those characters would come out as an empty box. Print '
      + 'it to PDF from the word processor that opens it instead.');
  }
  return textToPdf(text);
}
