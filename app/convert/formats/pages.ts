/* Apple Pages, by way of the preview Pages itself writes.
 *
 * A .pages document is a zip, but what is inside it is IWA — Apple's own
 * Protobuf dialect in a Snappy frame, with a message schema that is not
 * published and that moves between releases. Nothing in a browser lays that
 * out, and a half-read IWA would produce a document that is not the one the
 * person wrote, which is worse than producing nothing: it looks deliberate.
 *
 * It does not have to be read. Pages saves a PDF of the finished document
 * inside the bundle so the Finder and Quick Look have something to show — the
 * pages as Pages itself typeset them, with its own fonts embedded. So this is
 * an extraction and not a conversion, and it is honest about being one: find
 * that PDF, re-save it through pdf-lib, hand it back. When it is not in there,
 * refuse and say which switch in Pages puts it there.
 */
import {PDFDocument} from 'pdf-lib';
import {Refused} from '../heavy.ts';

const refuse = (m: string): never => { throw new Refused(m); };

const NO_PREVIEW =
  'There is no PDF preview inside that Pages file, and the document itself is written in '
  + 'Apple\'s own format, which only Pages can read. Save it again from Pages with '
  + '"Include preview in document" ticked under Advanced Options, or export it straight '
  + 'to PDF with File → Export To → PDF.';

export async function pagesToPdf(bytes: Uint8Array): Promise<Blob> {
  const JSZip = (await import('jszip')).default;
  const zip = await (async () => {
    try { return await JSZip.loadAsync(bytes); }
    catch {
      /* Two arrivals here are common enough to be worth telling apart: a PDF
         somebody renamed, and a .pages package copied off a Mac as the folder
         it really is, which is not a single file until it is compressed. */
      const head = new TextDecoder('latin1').decode(bytes.slice(0, 4));
      return refuse(head === '%PDF'
        ? 'That file is already a PDF — only its name says .pages. Rename it to .pdf and '
          + 'it will open anywhere.'
        : 'That file could not be opened. A .pages document is a zip archive, and this one '
          + 'does not unpack. If it came off a Mac as a folder rather than a single file, '
          + 'compress the folder first, or export to PDF from Pages.');
    }
  })();

  /* JSZip's entry type is only reachable through the callback it hands it to,
     and importing it by name means importing a namespace that is declared with
     `export =`. Reading it back off the object avoids both. */
  type Member = Parameters<Parameters<typeof zip.forEach>[0]>[1];

  const seen: string[] = [];
  const candidates: Array<{path: string; entry: Member; rank: number}> = [];
  let inserted = '';
  let locked = false;

  zip.forEach((path, entry) => {
    if (entry.dir) return;
    /* Every path below is matched a segment at a time, against a copy with a
       leading slash bolted on: a bundle someone compressed by hand in the
       Finder carries all its members behind a folder named after the document,
       so nothing may be anchored to the start of the string. Case is folded
       because the zip came off a filesystem that does not care about it. */
    const p = '/' + path.toLowerCase();
    seen.push(p);
    /* Compressing a package on a Mac writes an AppleDouble sidecar for every
       member under __MACOSX/ — same names, resource forks rather than content.
       The preview is never in one, so scanning them is pure cost. */
    if (/\/__macosx\//.test(p)) return;
    /* A password-protected iWork file has its whole body sealed into a single
       Index.zip instead of the usual Index/*.iwa, and the preview goes in with
       it — which is the point of the password. */
    if (/\/index\.zip$/.test(p)) locked = true;
    /* Data/ is where Pages keeps the pictures and files somebody dropped into
       the document. A PDF in there is content, not the document, and returning
       it would be a wrong answer convincing enough to be believed. */
    if (/\/data\//.test(p)) {
      if (p.endsWith('.pdf')) inserted = path;
      return;
    }
    const rank = /\/quicklook\/preview\.pdf$/.test(p) ? 0
      : /\/quicklook\//.test(p) ? 1
        : p.endsWith('.pdf') ? 2
          : 3;
    candidates.push({path, entry, rank});
  });

  /* Something has to say "this is not a Pages file" before a stray PDF found in
     an ordinary zip gets handed back as though it were somebody's document. */
  const isPages = seen.some(p =>
    /\/index\/[^/]*\.iwa$/.test(p) || /\/index\.xml(\.gz)?$/.test(p)
    || /\/index\.zip$/.test(p) || /\/quicklook\//.test(p)
    || /\/metadata\//.test(p) || /\/preview(-[a-z]+)?\.jpg$/.test(p));
  if (!isPages) {
    return refuse('That zip is not a Pages document — there is no iWork index, metadata or '
      + 'preview anywhere inside it.');
  }

  /* Which member holds the preview has moved between iWork generations, so the
     search is by content and the name only decides the order. Sorting by rank
     is what keeps that cheap: a bundle written the usual way matches at rank 0
     and exactly one member is ever decompressed, and the rest of the index is
     only unpacked on the way to a refusal. */
  const latin1 = new TextDecoder('latin1');
  candidates.sort((a, b) => a.rank - b.rank);
  for (const {path, entry} of candidates) {
    const member = await entry.async('uint8array');
    /* The extension is a claim; these four bytes are the evidence. */
    if (latin1.decode(member.subarray(0, 4)) !== '%PDF') continue;

    const doc = await (async () => {
      try {
        const opened = await PDFDocument.load(member, {ignoreEncryption: true, updateMetadata: false});
        /* pdf-lib parses a truncated or corrupt file without complaining and
           only falls over later, when something walks the catalogue. So the
           page tree is touched here, inside the same try — otherwise a damaged
           preview leaves as a raw TypeError instead of as a refusal, and the
           user is told "cannot read properties of undefined". */
        opened.getPageCount();
        return opened;
      } catch {
        return refuse(`The preview inside that Pages file (${path}) is damaged and will not `
          + 'open as a PDF. Export to PDF from Pages instead.');
      }
    })();
    /* Told to ignore the encryption, pdf-lib opens an encrypted PDF and reports
       its page count quite happily — but it cannot decrypt the streams, so what
       comes back out of save() is a file that opens to blank pages. The load is
       still done with ignoreEncryption on, because throwing at that point would
       only let this report the file as damaged, which is the wrong sentence. */
    if (doc.isEncrypted) {
      return refuse(`The preview inside that Pages file (${path}) is itself password `
        + 'protected, and re-saving it here would produce blank pages. Export to PDF from '
        + 'Pages instead.');
    }
    if (doc.getPageCount() === 0) {
      return refuse(`The preview inside that Pages file (${path}) has no pages in it.`);
    }
    /* This is the document as it stood at the last save, which is the only
       version Pages wrote a preview of. Whether that preview covers every page
       cannot be confirmed from here — the page count of the real document is in
       the IWA, which is the thing this deliberately does not read. */
    return new Blob([(await doc.save()).slice() as BlobPart], {type: 'application/pdf'});
  }

  if (locked) {
    return refuse('That Pages file is password protected — its contents are sealed in an '
      + 'encrypted Index.zip and the preview is sealed with them. Open it in Pages with the '
      + 'password and export to PDF.');
  }
  if (inserted) {
    return refuse(`The only PDF inside that Pages file is ${inserted}, which is a file placed `
      + 'into the document rather than the document itself, so handing it back would be the '
      + `wrong file. ${NO_PREVIEW}`);
  }
  return refuse(NO_PREVIEW);
}
