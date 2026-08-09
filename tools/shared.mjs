/* Everything that must be identical on every page lives here and nowhere else.
 * The nav in particular: it drifted once already (the converter pages were
 * missing "How it works"), and the only durable fix is a single source. */

import {readFileSync as _read} from 'node:fs';
import {dirname as _dir, join as _join} from 'node:path';
import {fileURLToPath as _url} from 'node:url';

export const SITE = 'https://uz-or.com/quirePDF';

/* Which official forms we actually host, written by tools/fetch-forms.mjs.
   A form is only in here if it downloaded, parsed and re-saved cleanly — so
   anything listed can genuinely be opened and exported, and anything missing
   falls back to sending people to the agency. */
const MANIFEST = JSON.parse(
  _read(_join(_dir(_url(import.meta.url)), 'forms-manifest.json'), 'utf8'),
);
export const HOSTED = MANIFEST.forms;

/* Generated pages sit next to hand-written ones in the same tree, so they say so
   out loud. Without this it is a matter of time before someone fixes a typo in
   convert/pdf-to-word.html and loses it on the next build. */
export const BANNER =
`<!--
  GENERATED FILE — do not edit by hand.
  Source: tools/  ·  Rebuild: node tools/build.mjs
  Any change made here is lost on the next build.
-->`;

export const LOGO = (px) => `<svg width="${px}" height="${px}" viewBox="0 0 32 32" fill="none">
        <path d="M3 4a3 3 0 0 1 3-3h13.5L29 10.5V28a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V4z" fill="#2563EB"/>
        <path d="M19.5 1 29 10.5h-6.5a3 3 0 0 1-3-3V1z" fill="#1D4ED8"/>
        <path d="M16 15.5v9M11.5 20h9" stroke="#fff" stroke-width="3.2" stroke-linecap="round"/>
      </svg>`;

/* ── converters ───────────────────────────────────────────────────────── */

/* Colour by family rather than per format, so a wall of seventy cards reads as
   five groups instead of seventy unrelated chips: red is PDF, blue is a word
   processor, green a spreadsheet, orange a deck, purple an image, teal markup
   and plain text, slate CAD, amber an ebook. */
const F = (short, badge, color, ext) => ({short, badge, color, ext});

/* One clause per format, describing what it actually is and who runs into it.
   The converter pages compose their own titles and descriptions out of these
   rather than sharing one sentence with a word swapped — seventy-four pages
   with the same meta description are seventy-three pages a search engine has
   no reason to index. */
const NOTE = {
  "pdf": "a fixed layout that looks the same everywhere and is awkward to edit",
  "word": "an editable document Microsoft Word and Google Docs both open",
  "docx": "the modern Word format, editable in Word, Pages and Google Docs",
  "odt": "the OpenDocument text format used by LibreOffice",
  "rtf": "a plain rich-text format almost every word processor can open",
  "hwp": "the Hancom Office format used across South Korea",
  "wps": "the WPS Office document format",
  "pages": "Apple's word processor format, which only opens on a Mac or iCloud",
  "pub": "a Microsoft Publisher layout file",
  "excel": "a spreadsheet with live formulas and sortable columns",
  "xls": "the older binary Excel workbook format",
  "xlsx": "the modern Excel workbook format",
  "csv": "plain comma-separated rows that any spreadsheet can import",
  "pptx": "an editable slide deck",
  "ppt": "the older binary PowerPoint format",
  "powerpoint": "an editable PowerPoint deck",
  "jpg": "a small photographic image every device can open",
  "jpeg": "the same format as JPG, under its longer name",
  "jfif": "a JPEG variant Windows sometimes saves instead of .jpg",
  "png": "a lossless image with transparency, right for screenshots and logos",
  "webp": "Google's web image format, smaller than JPEG but not accepted everywhere",
  "avif": "a newer, smaller web image format older software cannot read",
  "heic": "the format an iPhone shoots in, which Windows often refuses to open",
  "gif": "a short looping animation or a simple flat image",
  "bmp": "an uncompressed Windows bitmap",
  "tiff": "a high-fidelity image format used in printing and archiving",
  "ico": "the icon format Windows and browser favicons need",
  "psd": "a layered Photoshop document",
  "image": "a picture in any common format",
  "picture": "a picture in any common format",
  "svg": "a vector image that stays sharp at any size",
  "eps": "a vector format print shops and older design software expect",
  "ai": "an Adobe Illustrator vector drawing",
  "cdr": "a CorelDRAW vector drawing",
  "html": "a web page with its markup and styling",
  "md": "plain Markdown, the format READMEs and notes are written in",
  "txt": "unformatted plain text",
  "dxf": "a CAD drawing exchange format AutoCAD and its rivals share",
  "dwg": "AutoCAD's native drawing format",
  "epub": "a reflowable ebook that adapts to any screen size",
  "mobi": "the older Kindle ebook format",
  "azw3": "the Kindle ebook format",
  "video": "a video file",
  "mp4": "the most common video format"
};
const RED='#E5252A', BLU='#2B579A', GRN='#217346', ORG='#D24726',
      PUR='#7C3AED', PNK='#DB2777', TEA='#0F766E', SLA='#475569', AMB='#B45309';

export const FMT = {
  pdf:F('PDF','PDF',RED,'.pdf'),
  word:F('Word','DOC',BLU,'.docx'), docx:F('DOCX','DOCX',BLU,'.docx'),
  odt:F('ODT','ODT',BLU,'.odt'), rtf:F('RTF','RTF',BLU,'.rtf'),
  hwp:F('HWP','HWP',BLU,'.hwp'), wps:F('WPS','WPS',BLU,'.wps'),
  pages:F('Pages','PAGE',BLU,'.pages'), pub:F('PUB','PUB',BLU,'.pub'),
  excel:F('Excel','XLS',GRN,'.xlsx'), xls:F('XLS','XLS',GRN,'.xls'),
  xlsx:F('XLSX','XLSX',GRN,'.xlsx'), csv:F('CSV','CSV',GRN,'.csv'),
  pptx:F('PPTX','PPT',ORG,'.pptx'), ppt:F('PPT','PPT',ORG,'.ppt'),
  powerpoint:F('PowerPoint','PPT',ORG,'.pptx'),
  jpg:F('JPG','JPG',PUR,'.jpg'), jpeg:F('JPEG','JPEG',PUR,'.jpeg'),
  jfif:F('JFIF','JFIF',PUR,'.jfif'), png:F('PNG','PNG',PNK,'.png'),
  webp:F('WEBP','WEBP',PNK,'.webp'), avif:F('AVIF','AVIF',PNK,'.avif'),
  heic:F('HEIC','HEIC',PUR,'.heic'), gif:F('GIF','GIF',PNK,'.gif'),
  bmp:F('BMP','BMP',PUR,'.bmp'), tiff:F('TIFF','TIFF',PUR,'.tiff'),
  ico:F('ICO','ICO',PNK,'.ico'), psd:F('PSD','PSD',PUR,'.psd'),
  image:F('Image','IMG',PUR,'.jpg'), picture:F('Picture','IMG',PUR,'.jpg'),
  svg:F('SVG','SVG',TEA,'.svg'), eps:F('EPS','EPS',TEA,'.eps'),
  ai:F('AI','AI',TEA,'.ai'), cdr:F('CDR','CDR',TEA,'.cdr'),
  html:F('HTML','HTML',TEA,'.html'), md:F('MD','MD',TEA,'.md'),
  txt:F('TXT','TXT',TEA,'.txt'),
  dxf:F('DXF','DXF',SLA,'.dxf'), dwg:F('DWG','DWG',SLA,'.dwg'),
  epub:F('EPUB','EPUB',AMB,'.epub'), mobi:F('MOBI','MOBI',AMB,'.mobi'),
  azw3:F('AZW3','AZW3',AMB,'.azw3'),
  video:F('Video','VID',SLA,'.mp4'), mp4:F('MP4','MP4',SLA,'.mp4'),
};

/* Every conversion the site offers a page for, each in exactly one tab.
 *
 *   from   the source is a PDF          to     the target is a PDF
 *   img    picture in, picture out      other  everything that crosses families
 *
 * `pop` is orthogonal — it decides what appears on the first tab and in the
 * header dropdown, not where a conversion lives. */
const P = (a, b, cat, pop = false) => ({a, b, cat, pop});

/* Which conversions the browser can genuinely perform today. The rest have
   pages, because the pages are what people search for, but their card says
   plainly that the conversion is not built yet rather than accepting a file
   and doing nothing with it. */
const LIVE = new Set([
  /* picture in, picture out — pure canvas, no library at all */
  'image-to-jpg','png-to-jpg','webp-to-jpg','jfif-to-jpg','avif-to-jpg',
  'jpg-to-png','image-to-png','jpeg-to-png','svg-to-png',
  'jpeg-to-eps','png-to-eps','png-to-ico','image-to-svg','image-to-gif',
  /* libheif */
  'heic-to-jpg','heic-to-pdf',
  /* pdf.js */
  'pdf-to-jpg','pdf-to-jpeg','pdf-to-png','pdf-to-image','pdf-to-picture',
  'pdf-to-txt','pdf-to-html','pdf-to-bmp','pdf-to-tiff',
  /* pdf.js + SheetJS */
  'pdf-to-xls','pdf-to-xlsx','pdf-to-excel',
  /* pdf-lib */
  'image-to-pdf','jpg-to-pdf','png-to-pdf','svg-to-pdf',
  'txt-to-pdf','md-to-pdf','csv-to-pdf',
  /* SheetJS */
  'excel-to-pdf',
  /* JSZip */
  'epub-to-pdf',
  /* UTIF from the reading end — no engine but Safari's decodes TIFF, so the
     picture route cannot touch it and it needs a decoder of its own */
  'tiff-to-pdf',
  /* Not a conversion at all: an Illustrator file has been a PDF since v9 */
  'ai-to-pdf',
  /* JSZip again — a .docx is a zip of XML, read and written the same way an
     EPUB is, and WPS Office writes the same package under its own extension */
  'pdf-to-word', 'word-to-pdf', 'wps-to-pdf', 'image-to-word',
  /* pdf.js out, our own writer in — the words and their line breaks are what
     a PDF can honestly give, and every processor since 1987 opens an RTF */
  'pdf-to-rtf', 'rtf-to-pdf',
  /* The rest of the zip-of-XML family. `powerpoint` is the same .pptx package
     under the name people search for; `ppt` is not here, because the
     three-letter extension means the 1997 binary format and reading that is a
     different job we have not done. */
  'pptx-to-pdf', 'powerpoint-to-pdf', 'odt-to-pdf', 'pdf-to-pptx',
  'pdf-to-epub', 'image-to-excel',
  /* Pages keeps a PDF of itself inside the bundle for Quick Look, so this is a
     lookup rather than a parse — Apple's own format is not readable here and
     is not attempted. */
  'pages-to-pdf',
  /* Plain-text formats with a grammar of their own */
  'html-to-pdf', 'dxf-to-pdf', 'svg-to-dxf',
  /* Deliberately absent: everything that needs a format with no browser reader
     at all — DWG, CDR, PSD, PUB, HWP and the binary PPT — and PDF to Pages,
     whose target format Apple has never documented. Those keep their pages and
     say plainly that the conversion is not built.

     html-to-pdf is here now, but on narrower terms than the name suggests: it
     lays out the document's readable content, and does not run CSS. Rendering
     a web page as designed needs a browser engine, and the one we are inside
     will not lend it out. The page says so. */
]);
export const isLive = (a, b) => LIVE.has(`${a}-to-${b}`);

export const CONVERSIONS = [
  /* ── from PDF ── */
  P('pdf','word','from',true), P('pdf','excel','from',true), P('pdf','pptx','from',true),
  P('pdf','jpg','from',true), P('pdf','png','from',true), P('pdf','dxf','from',true),
  P('pdf','epub','from'), P('pdf','svg','from'), P('pdf','txt','from'),
  P('pdf','jpeg','from'), P('pdf','html','from'), P('pdf','image','from'),
  P('pdf','pages','from'), P('pdf','picture','from'), P('pdf','tiff','from'),
  P('pdf','psd','from'), P('pdf','xls','from'),
  P('pdf','xlsx','from'), P('pdf','mobi','from'), P('pdf','bmp','from'),
  P('pdf','rtf','from'), P('pdf','azw3','from'),

  /* ── to PDF ── */
  P('image','pdf','to',true), P('word','pdf','to',true), P('jpg','pdf','to',true),
  P('png','pdf','to',true), P('excel','pdf','to',true), P('pptx','pdf','to',true),
  P('dwg','pdf','to'), P('html','pdf','to'), P('powerpoint','pdf','to'),
  P('odt','pdf','to'), P('epub','pdf','to'), P('pages','pdf','to'),
  P('hwp','pdf','to'), P('heic','pdf','to'), P('wps','pdf','to'),
  P('csv','pdf','to'), P('txt','pdf','to'), P('ppt','pdf','to'),
  P('tiff','pdf','to'), P('ai','pdf','to'), P('rtf','pdf','to'),
  P('md','pdf','to'), P('svg','pdf','to'), P('pub','pdf','to'),
  P('dxf','pdf','to'), P('cdr','pdf','to'),

  /* ── picture to picture ── */
  P('image','jpg','img',true), P('heic','jpg','img',true), P('png','jpg','img',true),
  P('webp','jpg','img'), P('jpg','png','img'), P('image','png','img'),
  P('jpeg','png','img'), P('jpeg','eps','img'), P('png','eps','img'),
  P('png','ico','img'), P('image','svg','img'), P('image','gif','img'),
  P('svg','png','img'), P('jfif','jpg','img'), P('avif','jpg','img'),

  /* ── across families ── */
  P('image','word','other'), P('image','excel','other'), P('video','gif','other'),
  P('mp4','gif','other'), P('docx','jpg','other'), P('word','jpg','other'),
  P('html','jpg','other'), P('svg','dxf','other'), P('eps','svg','other'),
];

export const CONV_TABS = [
  {id:'pop',   label:'Popular formats'},
  {id:'from',  label:'From PDF'},
  {id:'to',    label:'To PDF'},
  {id:'img',   label:'Convert image'},
  {id:'other', label:'Other formats'},
];

/* The generator and the older call sites both want plain tuples. */
export const PAIRS = CONVERSIONS.map(c => [c.a, c.b]);
export const POPULAR_PAIRS = CONVERSIONS.filter(c => c.pop).map(c => [c.a, c.b]);

export const fmtNote = (id) => NOTE[id] ?? 'a common file format';
/* "an EPS", "a JPG". Acronyms go by how the first letter is said, not by how
   it is spelled: F, H, L, M, N, R, S and X all start with a vowel sound when
   read aloud, which is why it is "an SVG" but "a PDF". Written out because
   these strings appear on seventy-four pages and "a Image file" is the kind of
   thing that makes a site look machine-made. */
/* Read as words rather than spelled out, so the letter rule does not apply:
   nobody says "an aitch-ee-eye-see", they say "a heek". */
const SAID_AS_WORD = {HEIC: 'a', JFIF: 'a', WEBP: 'a', GIF: 'a', PUB: 'a', AVIF: 'an'};

export function article(short){
  if (SAID_AS_WORD[short]) return SAID_AS_WORD[short];
  const acronym = short === short.toUpperCase() && short.length > 1;
  const first = short[0].toUpperCase();
  const vowelSound = acronym ? 'AEFHILMNORSX'.includes(first) : 'AEIOU'.includes(first);
  return vowelSound ? 'an' : 'a';
}

export const convSlug  = (a,b) => `${a}-to-${b}`;
export const convTitle = (a,b) => `${FMT[a].short} to ${FMT[b].short}`;

/* ── forms ────────────────────────────────────────────────────────────────
 * Two kinds, deliberately kept apart:
 *
 *   official — a real form issued by a named agency. We do not host the file;
 *              the button goes to the agency, because a tax form served from a
 *              third party is exactly the thing people should not trust.
 *   template — a document people fill in themselves. No agency, no authority
 *              claimed, and the page says so.
 *
 * Nothing here invents an official form that does not exist. */

const T = (slug, code, name, category, tags) =>
  ({slug, code, name, category, tags, kind:'template'});

const HOSTED_FORMS = Object.entries(HOSTED).map(([slug, f]) => ({
  slug, code: f.code, name: f.name, agency: f.agency,
  category: f.category, tags: f.tags, source: f.source,
  pages: f.pages, fields: f.fields, bytes: f.bytes,
  writable: f.writable !== false,
  kind: 'official', hosted: true,
}));

const TEMPLATE_FORMS = [
  /* templates */
  T('residential-lease-agreement','Lease','Residential Lease Agreement','Real Estate',['Lease Agreements']),
  T('month-to-month-rental-agreement','Rental','Month-to-Month Rental Agreement','Real Estate',['Rental Agreements']),
  T('eviction-notice','Notice','Notice to Quit and Eviction Notice','Real Estate',['Notices']),
  T('quitclaim-deed','Deed','Quitclaim Deed for Transfer of Property','Real Estate',['Deeds']),
  T('residential-property-sale-agreement','Sale','Residential Property Sale Agreement','Real Estate',['Purchase Agreements']),
  T('vehicle-bill-of-sale','Bill','Vehicle Bill of Sale with Odometer Disclosure','Business & Finance',['Bills of Sale']),
  T('general-bill-of-sale','Bill','General Bill of Sale for Personal Property','Business & Finance',['Bills of Sale']),
  T('non-disclosure-agreement','NDA','Mutual Non-Disclosure Agreement','Business & Finance',['Contracts']),
  T('promissory-note','Note','Promissory Note for a Personal Loan','Business & Finance',['Contracts']),
  T('independent-contractor-agreement','Contract','Independent Contractor Services Agreement','Business & Finance',['Contracts']),
  T('commercial-invoice','Invoice','Commercial Invoice for International Shipping','Business & Finance',['Invoices']),
  T('general-power-of-attorney','POA','General Power of Attorney','Legal',['Power of Attorney']),
  T('durable-power-of-attorney','POA','Durable Power of Attorney for Finances','Legal',['Power of Attorney']),
  T('last-will-and-testament','Will','Last Will and Testament','Legal',['Estate']),
  T('affidavit-of-identity','Affidavit','Affidavit of Identity','Legal',['Affidavits']),
  T('notary-acknowledgment-individual','Notary','Notary Acknowledgment for an Individual','Legal',['Notary Forms']),
  T('notary-acknowledgment-cash-receipt','Notary','Notary Acknowledgment for Cash Receipt Verification','Legal',['Notary Forms']),
  T('notarial-certificate-child-travel','Notary','Notarial Certificate for Child Travel Consent Verification','Legal',['Notary Forms','Child Authorizations']),
  T('parental-consent-minor-travel','Consent',"Parental Consent for a Minor's International Travel",'Legal',['Child Authorizations']),
  T('parental-consent-both-parents','Consent','Parental Consent for Minor Children Travelling Without Both Parents','Legal',['Child Authorizations']),
  T('hipaa-release','HIPAA','HIPAA Medical Records Release Authorization','Medical',['Records']),
  T('medical-consent-for-minor','Consent','Medical Treatment Consent for a Minor','Medical',['Child Authorizations']),
  T('immunization-record','Record','Immunization and Vaccination Record','Medical',['Records']),
  T('living-will','Directive','Living Will and Advance Healthcare Directive','Medical',['Estate']),
  T('rental-application','Application','Rental Application for a Tenancy','Real Estate',['Rental Agreements']),
  T('rental-ledger','Ledger','Rent Payment Ledger','Real Estate',['Misc']),
  T('transfer-on-death-deed','Deed','Transfer on Death Deed','Real Estate',['Deeds']),
  T('marital-settlement-agreement','Agreement','Marital Settlement Agreement','Legal',['Divorce & Family']),
  T('receipt','Receipt','Payment Receipt','Business & Finance',['Payments & Receipts']),
  T('bill-of-lading','Lading','Bill of Lading','Business & Finance',['Shipping & Logistics']),
  T('employment-separation-certificate','Certificate','Employment Separation Certificate','Business & Finance',['Employment & HR']),
  T('credit-dispute-letter','Letter','Credit Report Dispute Letter','Business & Finance',['Misc']),
  T('profit-and-loss-statement','P&L','Profit and Loss Statement','Business & Finance',['Reports']),
  T('esa-letter','ESA','Emotional Support Animal Letter','Medical',['Misc']),
];

/* What people actually reach for, most-wanted first.
 *
 * The library used to come out in whatever order the catalogue happened to be
 * written in, which put three obscure employer returns at the top and the W-9 —
 * the single most requested document on the site — somewhere down the middle.
 * This is demand order, taken from the usage counts published across the busiest
 * PDF form libraries: a W-9 is asked for roughly twice as often as a lease and
 * more than thirty times as often as a quitclaim deed, and the shelf should say
 * so. Anything not on the list keeps its catalogue order behind those that are. */
const POPULAR = [
  'w-9', 'residential-lease-agreement', 'ds-11', 'vehicle-bill-of-sale',
  'eviction-notice', 'month-to-month-rental-agreement', '1095-a',
  'marital-settlement-agreement', 'i-9', 'receipt', 'ds-82',
  'rental-application', 'parental-consent-minor-travel', 'ssa-561', '1099-nec',
  'general-bill-of-sale', 'rental-ledger', 'affidavit-of-identity',
  'bill-of-lading', '8962', 'w-2', '1040', 'general-power-of-attorney',
  'employment-separation-certificate', 'credit-dispute-letter', '1099-misc',
  'promissory-note', 'cms-l564', '8862', 'transfer-on-death-deed', '8822',
  'profit-and-loss-statement', 'esa-letter', 'cms-40b', 'quitclaim-deed', '1096',
  'w-4', 'ss-5', 'ss-4', 'i-765', 'n-400', 'i-130', 'i-90', '4506-t', 'w-7',
];
const rank = (slug) => {
  const i = POPULAR.indexOf(slug);
  return i === -1 ? POPULAR.length : i;
};

export const FORMS = [...HOSTED_FORMS, ...TEMPLATE_FORMS]
  .map((f, i) => ({f, i}))
  .sort((a, b) => rank(a.f.slug) - rank(b.f.slug) || a.i - b.i)
  .map(({f}) => f);

/* The shelf at the top of the library: the top of the popularity list, so it
   and the grid below it can never disagree about what is most wanted. */
export const FEATURED = FORMS.slice(0, 3).map(f => f.slug);

/* The three in the header menu, which is a different question from the shelf.
 *
 * The shelf ranks everything by demand, and a lease agreement comes second. But
 * a menu is for jumping to a form you already have a name for, and nobody types
 * "lease" into a menu the way they type W-9 or 1099-MISC — a shortlist of forms
 * with numbers is worth more there than the raw ranking.
 *
 * Filtered against what is actually hosted, so the menu can never offer a form
 * that failed verification and is not on disk. */
export const NAV_FORMS = ['w-9', 'ds-11', '1099-misc'].filter(s => HOSTED[s]);
export const CATEGORIES = ['Tax & IRS','Government','Legal','Real Estate','Business & Finance','Medical'];

export const formBy = (slug) => FORMS.find(f => f.slug === slug);

/* ── chrome ───────────────────────────────────────────────────────────── */

/* `section` is one of: 'converter' | 'forms' | '', plus an optional page slug so
   the open panel can mark the page you are already on.
 *
 * `app` switches to the editor's variant: full-bleed instead of centred on the
 * content column, and static instead of sticky, because in the editor the header
 * is a row of the application grid rather than something floating over a page.
 * `middle` and `actions` let the editor put its document title and its own
 * buttons in without forking the whole component — the nav itself stays byte
 * for byte the same, which is the entire point. */
export function header(prefix, {section = '', page = '', app = false, middle = '', actions = ''} = {}){
  /* `all` puts the way out of the shortlist at the foot of the second column,
     where the Forms menu already keeps it — the dropdown shows what most people
     want, and everything else is one click away rather than absent. */
  const convCol = (heading, pairs, all) => `
        <div class="drop-col">
          <h4>${heading}</h4>
${pairs.map(([a,b]) => {
  const s = convSlug(a,b);
  return `          <a href="${prefix}convert/${s}.html"${s===page?' aria-current="page"':''}>${convTitle(a,b)}</a>`;
}).join('\n')}${all ? `\n          <a class="drop-all" href="${all}">View all converters</a>` : ''}
        </div>`;

  const featured = NAV_FORMS.map(s => formBy(s));

  return `<header class="head${app ? ' head--app' : ''}">
  <div class="wrap">
    <a class="logo" href="${prefix}" aria-label="Quire home">
      ${LOGO(24)}
      <b>Quire</b>
    </a>

    <nav class="nav">
      <div class="drop" data-drop>
        <button class="drop-btn"${section==='converter'?' data-section':''} aria-expanded="false" aria-haspopup="true">
          PDF Converter
          <svg viewBox="0 0 24 24"><path d="M6 9.5l6 6 6-6"/></svg>
        </button>
        <div class="drop-panel">${convCol('Convert from PDF', POPULAR_PAIRS.filter(([a]) => a === 'pdf'))}${convCol('Convert to PDF', POPULAR_PAIRS.filter(([, b]) => b === 'pdf'), `${prefix}converter.html`)}
        </div>
      </div>

      <div class="drop" data-drop>
        <button class="drop-btn"${section==='forms'?' data-section':''} aria-expanded="false" aria-haspopup="true">
          Forms
          <svg viewBox="0 0 24 24"><path d="M6 9.5l6 6 6-6"/></svg>
        </button>
        <div class="drop-panel drop-panel--one">
          <div class="drop-col">
${featured.map(f => `            <a href="${prefix}forms/${f.slug}.html"${f.slug===page?' aria-current="page"':''}>${f.code}</a>`).join('\n')}
            <a class="drop-all" href="${prefix}forms.html">View all forms</a>
          </div>
        </div>
      </div>

      <!-- A nav item named after a thing should open that thing. "PDF Editor"
           used to scroll the home page to a list of features, and "Privacy" to
           a paragraph about privacy while the actual policy sat unreachable in
           the footer — both are now the page they name. Only the two that
           genuinely are sections of the home page still jump to anchors. -->
      <a href="${prefix}editor.html"${section==='editor'?' data-section':''}>PDF Editor</a>
      <a href="${prefix}#how">How it works</a>
      <a href="${prefix}#faq">FAQ</a>
      <a href="${prefix}privacy.html"${section==='privacy'?' data-section':''}>Privacy</a>
    </nav>
${middle ? `\n    ${middle}\n` : ''}
    <div class="head-actions">${actions
      || `<a class="btn btn--primary" href="${prefix}editor.html">Open the editor</a>`}</div>
  </div>
</header>`;
}

const AUTHOR = (indent) => `${indent}<a class="sf-author" href="https://uz-or.com/" target="_blank" rel="noopener">
${indent}  <span class="sf-ico">
${indent}    <svg viewBox="0 0 64 64"><rect width="64" height="64" fill="#0a0a0a"/><polygon fill="#fff" points="12,52 12,12 24,12 40,36 40,12 52,12 52,52 40,52 24,28 24,52"/></svg>
${indent}  </span>
${indent}  <span class="sf-txt">
${indent}    <b>Mykhailo Nahreba</b>
${indent}    <em>Author · see the portfolio</em>
${indent}  </span>
${indent}  <svg class="sf-arrow" viewBox="0 0 24 24"><path d="M7 17 17 7M8.5 7H17v8.5"/></svg>
${indent}</a>`;

/* The slim variant is the same component with the rows the editor has no height
   for removed — not a second footer. Same author card, same legal links, same
   destination for every one of them. */
export function footer(prefix, {slim = false} = {}){
  if (slim) return `<footer class="site-foot site-foot--slim">
  <div class="sf-in">
    <div class="sf-brand"><div><b>Quire · free PDF editor</b></div></div>
    <span class="sf-mini">
      <a href="${prefix}privacy.html">Privacy Policy</a>
      <a href="${prefix}terms.html">Terms of Use</a>
    </span>
    <span class="sf-spacer"></span>
${AUTHOR('    ')}
  </div>
</footer>`;

  return `<footer class="site-foot">
  <div class="sf-in">
    <div class="sf-brand">
      ${LOGO(26)}
      <div>
        <b>Quire</b>
        <span>A free PDF editor, converter and form library that runs in your browser.</span>
      </div>
    </div>

    <nav class="sf-nav">
      <a href="${prefix}">Home</a>
      <a href="${prefix}editor.html">Editor</a>
      <a href="${prefix}#converter">Converter</a>
      <a href="${prefix}forms.html">Forms</a>
    </nav>

${AUTHOR('    ')}
  </div>
  <div class="sf-legal">
    <span>© 2026 Quire · Built by Mykhailo Nahreba · Nothing you open here is uploaded anywhere.</span>
    <span class="sf-links">
      <a href="${prefix}privacy.html">Privacy Policy</a>
      <a href="${prefix}terms.html">Terms of Use</a>
    </span>
  </div>
</footer>`;
}

export function head({title, desc, url, prefix, extraCss = []}){
  return `<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">

<title>${title}</title>
<meta name="description" content="${desc}">
<link rel="canonical" href="${url}">
<meta name="theme-color" content="#2563eb">
<link rel="icon" type="image/svg+xml" href="${prefix}favicon.svg">

<meta property="og:type" content="website">
<meta property="og:url" content="${url}">
<meta property="og:site_name" content="Quire">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<!-- One card for the whole site, and an absolute URL because a link preview is
     fetched by a crawler that has no page to resolve a relative path against. -->
<meta property="og:image" content="${SITE}/og-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${desc}">
<meta name="twitter:image" content="${SITE}/og-image.png">

<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;450;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="${prefix}assets/tokens.css">
<link rel="stylesheet" href="${prefix}assets/site.css">
${extraCss.map(c => `<link rel="stylesheet" href="${prefix}assets/${c}">`).join('\n')}
<link rel="stylesheet" href="${prefix}assets/footer.css">`;
}

/* A stylised page preview. We cannot ship the real government PDF, and drawing
   a convincing fake of one would be worse than drawing an obvious placeholder,
   so this is plainly a diagram of a form rather than an imitation of it. */
/* The shapes only, with no <svg> wrapper, so the same artwork can be emitted
   either standalone (one card, one drawing) or once as a <symbol> that a page
   references many times. The banner used to inline six identical copies —
   216 of a form page's 466 lines — which is fine at 39 forms and absurd at 400. */

/* Standalone — one drawing, drawn once. Used by the library cards, where every
   card carries a different form code. */
