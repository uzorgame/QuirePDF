/* PowerPoint 97-2003 in, pages out — the words, not the design.
 *
 * A .ppt from before Office Open XML is not a zip: it is an OLE2 compound
 * file, the same container Word and Excel used, with the presentation itself
 * stored as one stream inside it named "PowerPoint Document". That stream is
 * in turn a tree of binary records — length-prefixed, arbitrarily nested, no
 * relation to XML at all — and the only two record types this reader cares
 * about are the ones that hold literal text: TextCharsAtom (UTF-16LE) and
 * TextBytesAtom (one byte per character, Latin-1). Everything else in the
 * tree — shape geometry, colours, the Escher drawing layer, master slides,
 * OLE-embedded objects — is walked past rather than understood, because none
 * of it can be turned into anything textToPdf can honestly lay out.
 *
 * Grouping is by top-level record rather than by slide number: a freshly
 * saved file writes one persisted object — normally one slide, in order — as
 * one sibling at the root of the stream, so treating each root sibling as a
 * paragraph group and joining groups with a blank line reads as "one slide,
 * one block" for the common case without needing the persist-object
 * directory (Current User + UserEditAtom + PersistPtrIncrementalBlock) that
 * a fully spec-compliant reader would resolve to tell a slide from a notes
 * page or a master. A file that has been incrementally saved many times, or
 * whose notes pages carry their own text, will not group as cleanly; the
 * words themselves are still exactly what the file contains.
 */
import {Refused, textToPdf, looksLike} from '../heavy.ts';

const refuse = (m: string): never => { throw new Refused(m); };

/* ── OLE2 compound file ───────────────────────────────────────────────────
 *
 * The layout: a fixed 512-byte header, then the file cut into sectors of a
 * size the header itself declares. A FAT — an array of "next sector" numbers,
 * one per sector in the file — chains those sectors into streams, the same
 * idea as a disk's own file allocation table and the reason the format is
 * named after it. Streams under 4096 bytes are chained a second way instead,
 * through a mini-FAT over 64-byte mini-sectors carved out of one ordinary
 * stream (the root entry's own), because a FAT chain has 512 bytes of
 * overhead for every fragment and most streams in a real document are a
 * paragraph of properties, not a picture. */
const SIG = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const FREESECT = 0xffffffff, ENDOFCHAIN = 0xfffffffe;
const MINI_CUTOFF = 4096;

function sectorAt(data: Uint8Array, n: number, sectorSize: number): Uint8Array {
  const off = (n + 1) * sectorSize;
  return data.subarray(off, off + sectorSize);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/* Every FAT-like chain in this format can cycle back on itself in a damaged
   file, and following one without a bound turns a bad .ppt into a hung tab.
   The chain cannot legitimately be longer than the table it walks, so that
   length is the honest bound rather than an arbitrary round number. */
function followChain(
  next: (n: number) => number, start: number, read: (n: number) => Uint8Array,
  size: number | undefined, limit: number,
): Uint8Array {
  const chunks: Uint8Array[] = [];
  let n = start, guard = 0;
  while (n !== ENDOFCHAIN && n >= 0 && guard++ < limit) {
    chunks.push(read(n));
    n = next(n);
  }
  const all = concat(chunks);
  return size === undefined ? all : all.subarray(0, size);
}

function u32Table(bytes: Uint8Array): number[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: number[] = [];
  for (let i = 0; i + 4 <= bytes.length; i += 4) out.push(dv.getUint32(i, true));
  return out;
}

/* The 109 sector numbers packed into the header are the FAT for any file
   whose FAT fits in them — every real-world .ppt. Beyond that the header
   points at further "DIFAT" sectors that hold 127 more FAT sector numbers
   apiece plus a pointer to the next one; this reader follows that chain too
   rather than assuming it is always empty, since nothing about the format
   guarantees a small file stays under the 109-sector FAT. */
function buildFat(header: DataView, data: Uint8Array, sectorSize: number): number[] {
  const fat: number[] = [];
  const perSector = sectorSize / 4;
  const append = (sec: number) => {
    if (sec === FREESECT) return;
    fat.push(...u32Table(sectorAt(data, sec, sectorSize)));
  };
  for (let i = 0; i < 109; i++) append(header.getUint32(0x4c + i * 4, true));

  let difat = header.getUint32(0x44, true);
  let guard = 0;
  while (difat !== ENDOFCHAIN && difat !== FREESECT && guard++ < 100000) {
    const table = u32Table(sectorAt(data, difat, sectorSize));
    for (let i = 0; i < perSector - 1; i++) append(table[i]!);
    difat = table[perSector - 1]!;
  }
  return fat;
}

interface DirEntry {name: string; type: number; start: number; size: number}

/* Directory entries sit in a red-black tree keyed by name, but the tree is
   only there to make a single lookup fast inside one storage — this reader
   wants every stream regardless of which storage owns it, and a flat scan of
   the directory stream visits every entry the tree would too. */
function readDirEntries(dirBytes: Uint8Array): DirEntry[] {
  const dv = new DataView(dirBytes.buffer, dirBytes.byteOffset, dirBytes.byteLength);
  const out: DirEntry[] = [];
  for (let off = 0; off + 128 <= dirBytes.length; off += 128) {
    const nameLen = dv.getUint16(off + 0x40, true);
    const type = dirBytes[off + 0x42]!;
    if (type === 0 || nameLen < 2) continue;   // unused slot
    let name = '';
    /* nameLen counts the trailing UTF-16 NUL, which does not belong in the
       name a lookup compares against. */
    for (let i = 0; i < nameLen - 2; i += 2) name += String.fromCharCode(dv.getUint16(off + i, true));
    out.push({name, type, start: dv.getUint32(off + 0x74, true), size: dv.getUint32(off + 0x78, true)});
  }
  return out;
}

interface Ole2 {entries: DirEntry[]; read(entry: DirEntry): Uint8Array}

function openOle2(bytes: Uint8Array): Ole2 {
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sectorSize = 1 << header.getUint16(0x1e, true);
  const miniSectorSize = 1 << header.getUint16(0x20, true);
  const dirStart = header.getUint32(0x30, true);
  const miniFatStart = header.getUint32(0x3c, true);

  const fat = buildFat(header, bytes, sectorSize);
  const readSector = (n: number) => sectorAt(bytes, n, sectorSize);
  const chain = (start: number, size?: number) =>
    followChain(n => fat[n] ?? ENDOFCHAIN, start, readSector, size, fat.length + 4);

  const entries = readDirEntries(chain(dirStart));
  const root = entries.find(e => e.type === 5) ?? refuse('That file is an OLE2 compound '
    + 'document but has no root entry in its directory — its structure is not one this reader '
    + 'recognises, so it is likely damaged.');

  /* The mini-stream is not a separate area of the file: it is the root
     entry's own stream, read the ordinary way, and then re-sliced into
     64-byte mini-sectors for anything small enough to live inside it. */
  const miniStream = chain(root.start, root.size);
  const minifat = miniFatStart === ENDOFCHAIN ? [] : u32Table(chain(miniFatStart));
  const miniChain = (start: number, size: number) => followChain(
    n => minifat[n] ?? ENDOFCHAIN, start,
    n => miniStream.subarray(n * miniSectorSize, (n + 1) * miniSectorSize),
    size, minifat.length + 4,
  );

  return {
    entries,
    read: entry => entry.size >= MINI_CUTOFF
      ? chain(entry.start, entry.size)
      : miniChain(entry.start, entry.size),
  };
}

/* ── the record tree ───────────────────────────────────────────────────── */

const REC_HEADER = 8;
const TEXT_CHARS = 4000, TEXT_BYTES = 4008;

/* A record too long for the space it is declared inside of means either a
   corrupt file or, more often for this format, a stream this reader's plain
   walk cannot make sense of because it is compressed — pptToPdf below tries
   inflating the stream and re-parsing before it gives up and says so. */
class RecordParseFailure extends Error {}

function decodeUtf16(raw: Uint8Array, from: number, to: number): string {
  let s = '';
  for (let i = from; i + 1 < to; i += 2) s += String.fromCharCode(raw[i]! | (raw[i + 1]! << 8));
  return s;
}

function decodeLatin1(raw: Uint8Array, from: number, to: number): string {
  let s = '';
  for (let i = from; i < to; i++) s += String.fromCharCode(raw[i]!);
  return s;
}

/* A TextCharsAtom or TextBytesAtom holds every paragraph of one shape as a
   single run, with \r between paragraphs and \v where the author pressed a
   soft line break inside one — both are breaks a reader sees as a new line,
   neither is a character anybody typed. */
function splitParagraphs(s: string): string[] {
  return s.split(/[\r\v]/).map(l => l.trimEnd());
}

/* Depth-first over one record's declared span. A record's low nibble marking
   it a container (0xF) rather than an atom is the one piece of framing that
   holds across the whole format regardless of which specific record type it
   is, which is what lets this walk go looking for text without a table of
   every container type PowerPoint has ever defined. */
function walk(dv: DataView, raw: Uint8Array, start: number, end: number, into: string[]): void {
  let off = start;
  while (off + REC_HEADER <= end) {
    const verInstance = dv.getUint16(off, true);
    const type = dv.getUint16(off + 2, true);
    const len = dv.getUint32(off + 4, true);
    const bodyStart = off + REC_HEADER, bodyEnd = bodyStart + len;
    if (bodyEnd > end) throw new RecordParseFailure('a record runs past the space that holds it');

    if ((verInstance & 0xf) === 0xf) {
      walk(dv, raw, bodyStart, bodyEnd, into);
    } else if (type === TEXT_CHARS) {
      into.push(...splitParagraphs(decodeUtf16(raw, bodyStart, bodyEnd)));
    } else if (type === TEXT_BYTES) {
      into.push(...splitParagraphs(decodeLatin1(raw, bodyStart, bodyEnd)));
    }
    off = bodyEnd;
  }
}

/* One entry per top-level record in the stream — see the file header for why
   that is the grouping used in place of resolving which persisted object is
   actually a slide. */
function readSlideGroups(streamBytes: Uint8Array): string[][] {
  const dv = new DataView(streamBytes.buffer, streamBytes.byteOffset, streamBytes.byteLength);
  const groups: string[][] = [];
  let off = 0;
  while (off + REC_HEADER <= streamBytes.length) {
    const len = dv.getUint32(off + 4, true);
    const bodyEnd = off + REC_HEADER + len;
    if (bodyEnd > streamBytes.length) throw new RecordParseFailure('the stream ends mid-record');
    const lines: string[] = [];
    walk(dv, streamBytes, off, bodyEnd, lines);
    if (lines.some(l => l.trim())) groups.push(lines);
    off = bodyEnd;
  }
  return groups;
}

/* Most .ppt files are not compressed at all — this branch exists for the
   ones that are. Two container formats are tried because "zlib-deflated"
   covers both a raw deflate stream and one wrapped in zlib's own two-byte
   header, and nothing short of trying tells them apart. */
async function inflate(bytes: Uint8Array, format: 'deflate' | 'deflate-raw'): Promise<Uint8Array | null> {
  try {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream(format));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

async function slideGroupsOf(streamBytes: Uint8Array): Promise<string[][]> {
  try {
    return readSlideGroups(streamBytes);
  } catch {
    for (const format of ['deflate', 'deflate-raw'] as const) {
      const inflated = await inflate(streamBytes, format);
      if (!inflated) continue;
      try { return readSlideGroups(inflated); } catch { /* not this one either */ }
    }
    return refuse('The "PowerPoint Document" stream in that file could not be read as records. '
      + 'It may use a compression or protection scheme this reader does not handle, or the file '
      + 'may simply be damaged.');
  }
}

/* ── script coverage ───────────────────────────────────────────────────────
 *
 * textToPdf reaches for a real Unicode face the moment the text needs one,
 * but that face is DejaVu subsetted for Latin, Cyrillic and Greek — CJK and
 * the other large scripts are not in it, and pdf-lib does not fail on a
 * character with no glyph, it silently draws .notdef and hands back a page
 * of empty boxes. A share-based check rather than a single-character one, so
 * one Korean product name in an otherwise English deck does not cost the
 * whole file its conversion. */
const UNDRAWABLE: Array<[number, number, string]> = [
  [0x0e00, 0x0e7f, 'Thai'],
  [0x1100, 0x11ff, 'Korean'],
  [0x3040, 0x30ff, 'Japanese'],
  [0x3400, 0x9fff, 'Chinese or Japanese'],
  [0xac00, 0xd7af, 'Korean'],
  [0xf900, 0xfaff, 'Chinese or Japanese'],
];

function unreadableScript(text: string): string | null {
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

/* ── the conversion ───────────────────────────────────────────────────── */

function checkSignature(bytes: Uint8Array): void {
  if (SIG.every((b, i) => bytes[i] === b)) return;
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    refuse('That file is a zip archive, not a 97-2003 .ppt — it is a modern .pptx, quite possibly '
      + 'just renamed. Use the PowerPoint (.pptx) to PDF conversion for it instead.');
  }
  const what = looksLike(bytes);
  refuse(what
    ? `That file is ${what}, not a PowerPoint 97-2003 presentation — renaming it does not change `
      + 'what is inside.'
    : 'That file is not a PowerPoint 97-2003 (.ppt) file. Its first eight bytes are not the OLE2 '
      + 'compound-file signature every .ppt begins with, so it may be a newer .pptx, or not a '
      + 'presentation at all.');
}

export async function pptToPdf(bytes: Uint8Array): Promise<Blob> {
  checkSignature(bytes);
  if (bytes.length < 512) {
    refuse('That file is too small to be a real .ppt — an OLE2 compound document is at least '
      + '512 bytes before it holds anything at all.');
  }

  const ole = openOle2(bytes);

  /* CryptoAPI RC4, the encryption PowerPoint has written since Office XP,
     stores its key material in a stream of exactly this name; a file
     protected the older, 40-bit-XOR way is not caught here; that scheme has
     not been the default for two decades and this reader does not chase it
     into the document properties where its own flag lives. */
  if (ole.entries.some(e => e.name === 'EncryptedSummary')) {
    refuse('That presentation is password protected, so its slides cannot be read here. Open it '
      + 'in PowerPoint, remove the password, and save it again.');
  }

  const docEntry = ole.entries.find(e => e.type === 2 && e.name === 'PowerPoint Document');
  if (!docEntry) {
    refuse('That file has the shape of an old Office document but no "PowerPoint Document" '
      + 'stream inside it — it may be a Word or Excel file from the same era rather than a '
      + 'presentation.');
  }

  const groups = await slideGroupsOf(ole.read(docEntry));
  const text = groups
    .map(lines => lines.join('\n').trim())
    .filter(Boolean)
    .join('\n\n');

  if (!text) {
    refuse('There is no text this reader could find in that presentation. Its slides may hold '
      + 'only pictures or drawn shapes, which a binary .ppt reader cannot turn into words — or '
      + 'the deck may genuinely be empty.');
  }

  const script = unreadableScript(text);
  if (script) {
    refuse(`That presentation is written in ${script}, and the font this converter embeds covers `
      + 'Latin, Cyrillic and Greek only — every one of those characters would come out as an '
      + 'empty box. Open it in PowerPoint and print it to PDF instead.');
  }

  return textToPdf(text);
}
