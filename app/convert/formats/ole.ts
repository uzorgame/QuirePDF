/* The OLE2 compound file, on its own.
 *
 * Word, Excel and PowerPoint from before Office Open XML all share one
 * container: not a zip but a little file system inside a file, with a directory
 * of named streams. The .ppt reader wrote this first and had it to itself; the
 * .doc reader needs exactly the same thing, so it lives here rather than being
 * copied — a second copy of a FAT walker is a second place for a hung tab to
 * come from.
 *
 * The layout: a fixed 512-byte header, then the file cut into sectors of a size
 * the header itself declares. A FAT — an array of "next sector" numbers, one per
 * sector in the file — chains those sectors into streams, the same idea as a
 * disk's own file allocation table and the reason the format is named after it.
 * Streams under 4096 bytes are chained a second way instead, through a mini-FAT
 * over 64-byte mini-sectors carved out of one ordinary stream (the root entry's
 * own), because a FAT chain has 512 bytes of overhead for every fragment and
 * most streams in a real document are a paragraph of properties, not a picture.
 */
import {Refused} from '../heavy.ts';

const refuse = (m: string): never => { throw new Refused(m); };

export const OLE_SIG = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

const FREESECT = 0xffffffff, ENDOFCHAIN = 0xfffffffe;
const MINI_CUTOFF = 4096;

/** Чи починається файл підписом OLE2. */
export const isOle2 = (bytes: Uint8Array): boolean => OLE_SIG.every((b, i) => bytes[i] === b);

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
   file, and following one without a bound turns a bad file into a hung tab.
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

/* The 109 sector numbers packed into the header are the FAT for any file whose
   FAT fits in them — every real-world document. Beyond that the header points at
   further "DIFAT" sectors that hold 127 more FAT sector numbers apiece plus a
   pointer to the next one; this reader follows that chain too rather than
   assuming it is always empty, since nothing about the format guarantees a small
   file stays under the 109-sector FAT. */
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

export interface DirEntry {name: string; type: number; start: number; size: number}

/* Directory entries sit in a red-black tree keyed by name, but the tree is only
   there to make a single lookup fast inside one storage — a reader wants every
   stream regardless of which storage owns it, and a flat scan of the directory
   stream visits every entry the tree would too. */
function readDirEntries(dirBytes: Uint8Array): DirEntry[] {
  const dv = new DataView(dirBytes.buffer, dirBytes.byteOffset, dirBytes.byteLength);
  const out: DirEntry[] = [];
  for (let off = 0; off + 128 <= dirBytes.length; off += 128) {
    const nameLen = dv.getUint16(off + 0x40, true);
    const type = dirBytes[off + 0x42]!;
    if (type === 0 || nameLen < 2) continue;   // unused slot
    let name = '';
    /* nameLen counts the trailing UTF-16 NUL, which does not belong in the name
       a lookup compares against. */
    for (let i = 0; i < nameLen - 2; i += 2) name += String.fromCharCode(dv.getUint16(off + i, true));
    out.push({name, type, start: dv.getUint32(off + 0x74, true), size: dv.getUint32(off + 0x78, true)});
  }
  return out;
}

export interface Ole2 {
  entries: DirEntry[];
  read(entry: DirEntry): Uint8Array;
  /** Потік за іменем, або null. Тип 2 — саме потік, а не сховище. */
  stream(name: string): Uint8Array | null;
}

export function openOle2(bytes: Uint8Array): Ole2 {
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

  /* The mini-stream is not a separate area of the file: it is the root entry's
     own stream, read the ordinary way, and then re-sliced into 64-byte
     mini-sectors for anything small enough to live inside it. */
  const miniStream = chain(root.start, root.size);
  const minifat = miniFatStart === ENDOFCHAIN ? [] : u32Table(chain(miniFatStart));
  const miniChain = (start: number, size: number) => followChain(
    n => minifat[n] ?? ENDOFCHAIN, start,
    n => miniStream.subarray(n * miniSectorSize, (n + 1) * miniSectorSize),
    size, minifat.length + 4,
  );

  const read = (entry: DirEntry) => entry.size >= MINI_CUTOFF
    ? chain(entry.start, entry.size)
    : miniChain(entry.start, entry.size);

  return {
    entries,
    read,
    stream: name => {
      const found = entries.find(e => e.type === 2 && e.name === name);
      return found ? read(found) : null;
    },
  };
}
