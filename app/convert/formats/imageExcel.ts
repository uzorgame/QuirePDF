/* A picture placed in a worksheet.
 *
 * SheetJS is already here and reads every spreadsheet Excel has written, but it
 * does not write pictures — its model is cells, and a picture is not a cell. So
 * this assembles the package itself. That is less alarming than it sounds: an
 * .xlsx is a zip of XML, and a workbook holding nothing but one image needs
 * seven small parts and no cell data at all.
 *
 * The picture floats above the grid rather than living in a cell, because that
 * is the only thing OOXML offers — there is no "picture in A1". What the anchor
 * decides is where it starts and how it behaves when the sheet is edited.
 */
import {Refused} from '../heavy.ts';

const refuse = (m: string): never => { throw new Refused(m); };

/* EMUs — English Metric Units, 914400 to the inch, which is how Office measures
   every distance in a drawing. A CSS pixel is 1/96 inch, so a pixel is 9525 of
   them exactly, with no rounding to accumulate. */
const EMU_PER_INCH = 914400;
const EMU_PER_PX = EMU_PER_INCH / 96;

/* A picture at its pixel size is a spreadsheet nobody can navigate: a 4000-pixel
   photograph anchored at A1 spans about sixty columns and four hundred rows, and
   the workbook opens on a corner of it. Fitting it inside one printed page
   instead gives a sheet you can see whole. 6.5 × 9 inches is what survives the
   narrower of A4 and Letter once Excel's default 0.7in side and 0.75in top
   margins are taken off, so the picture also prints without being re-scaled.
   Only ever shrinks — enlarging a small icon to fill the page would be a
   decision nobody asked for. */
const MAX_W = 6.5 * EMU_PER_INCH;
const MAX_H = 9 * EMU_PER_INCH;

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Default Extension="jpeg" ContentType="image/jpeg"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const WORKBOOK = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${R_NS}">
<sheets><sheet name="Image" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="${R_NS}/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="${R_NS}/styles" Target="styles.xml"/>
</Relationships>`;

/* No cell is formatted here, so in principle there is nothing to style. Excel is
   the reason it exists anyway: a workbook with no styles.xml opens with the
   "we found a problem with some content" repair prompt on several builds, and a
   repair prompt on a file that is not broken costs more trust than the four
   hundred bytes save. The empty gray125 fill in second place is not decoration
   either — Excel expects the two built-in fills in that order and renumbers
   everything if they are missing. No <color theme="…"/> anywhere, for the same
   reason in reverse: a theme colour is a pointer into xl/theme/theme1.xml, and
   this package has no theme part for it to point at. */
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="1"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

/* <drawing> has to come after <sheetData>: the worksheet schema is a sequence,
   not a choice, and Excel rejects the part outright if the order is wrong rather
   than ignoring the element it did not expect. */
const SHEET = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${R_NS}">
<sheetData/>
<drawing r:id="rId1"/>
</worksheet>`;

const SHEET_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="${R_NS}/drawing" Target="../drawings/drawing1.xml"/>
</Relationships>`;

/* The label the caller passes comes from a file extension or a MIME type, and
   both of those are claims rather than facts. Excel matches the picture part
   against the content type declared for its extension, so a JPEG stored as
   image1.png is a red placeholder box in an otherwise valid workbook — exactly
   the kind of file that opens broken somewhere else. The first bytes are not a
   claim, so they decide. */
function sniff(bytes: Uint8Array): 'png' | 'jpeg' | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50
      && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d
      && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  return undefined;
}

/**
 * Wraps one picture in a workbook, anchored at the top-left cell of the first
 * sheet and scaled down to fit a printed page.
 *
 * `width` and `height` are the picture's own pixel dimensions — nothing here
 * decodes the image, so they have to come from whoever did.
 */
export async function imageToExcel(
  image: Uint8Array, kind: 'png' | 'jpeg', width: number, height: number,
): Promise<Blob> {
  if (!image.length) {
    refuse('That picture has no bytes in it, so there is nothing to put in the worksheet.');
  }
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    refuse(`That picture reports a size of ${width}×${height} pixels, which cannot be placed on `
      + 'a sheet. Its width and height both have to be above zero.');
  }

  const ext = sniff(image);
  if (!ext) {
    refuse(`That picture was handed over as ${kind === 'png' ? 'PNG' : 'JPEG'}, but its bytes are `
      + 'neither a PNG nor a JPEG. A worksheet can carry only those two, so convert it first.');
  }

  const natW = width * EMU_PER_PX, natH = height * EMU_PER_PX;
  const scale = Math.min(1, MAX_W / natW, MAX_H / natH);
  /* One EMU is a three-thousandth of a millimetre, so a picture that rounds to
     zero was never going to be visible — but a zero extent is what makes Excel
     call the drawing malformed, and the empty box it then draws is worse than a
     hairline. */
  const cx = Math.max(1, Math.round(natW * scale));
  const cy = Math.max(1, Math.round(natH * scale));

  /* oneCellAnchor rather than the twoCellAnchor Excel writes for itself. A
     two-cell anchor stores the picture as a span of rows and columns, so it
     restretches the moment anything resizes them; a one-cell anchor pins the
     top-left corner and keeps the size in EMU. Since no column widths are
     written here, the two-cell form would hand the picture's shape over to
     whatever the reader's default column happens to be. */
  const drawing = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${R_NS}">
<xdr:oneCellAnchor>
<xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
<xdr:ext cx="${cx}" cy="${cy}"/>
<xdr:pic>
<xdr:nvPicPr><xdr:cNvPr id="1" name="Picture 1"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>
<xdr:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>
<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>
</xdr:pic>
<xdr:clientData/>
</xdr:oneCellAnchor>
</xdr:wsDr>`;

  const drawingRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="${R_NS}/image" Target="../media/image1.${ext}"/>
</Relationships>`;

  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  /* createFolders off throughout. Left on, JSZip adds a zero-length member for
     every implied directory — eight of them here — and an OPC package is defined
     as a flat set of named parts, not a directory tree. Readers tolerate the
     extra members, but nothing needs them.
     Order matters as far as [Content_Types].xml goes: a reader that streams the
     archive rather than seeking its central directory expects that part first,
     and JSZip writes members in the order they were added. */
  const parts: Array<[string, string | Uint8Array]> = [
    ['[Content_Types].xml', CONTENT_TYPES],
    ['_rels/.rels', ROOT_RELS],
    ['xl/workbook.xml', WORKBOOK],
    ['xl/_rels/workbook.xml.rels', WORKBOOK_RELS],
    ['xl/styles.xml', STYLES],
    ['xl/worksheets/sheet1.xml', SHEET],
    ['xl/worksheets/_rels/sheet1.xml.rels', SHEET_RELS],
    ['xl/drawings/drawing1.xml', drawing],
    ['xl/drawings/_rels/drawing1.xml.rels', drawingRels],
  ];
  for (const [path, data] of parts) zip.file(path, data, {createFolders: false});
  /* Stored rather than deflated: PNG and JPEG are already compressed, so the
     pass over a large photograph costs real time to make the file bigger. */
  zip.file(`xl/media/image1.${ext}`, image, {createFolders: false, compression: 'STORE'});

  const out = await zip.generateAsync({type: 'uint8array', compression: 'DEFLATE'});
  return new Blob([out.slice() as BlobPart], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}
