/* Generates the ten converter pages.
 *
 * Each one is a real, separate HTML file rather than a single template driven
 * by a query string — Google indexes URLs, so "PDF to Word" has to exist at its
 * own address with its own title, heading and copy.
 *
 *   node tools/build-converters.mjs
 */
import {writeFileSync, mkdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {BANNER, SITE, FMT, PAIRS, CONVERSIONS, CONV_TABS, convSlug, convTitle, fmtNote, isLive, article, head, header, footer} from './shared.mjs';

/* How many of the pages have code behind them. Counted rather than written
   down, so the sentence on the hub cannot drift from the truth the way a
   hand-typed number does. */
const LIVE_COUNT = CONVERSIONS.filter(c => isLive(c.a, c.b)).length;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* The illustration: two sheets, source behind and target in front, with a
   dashed arc showing the direction of travel. Only the two colours and the two
   badge labels differ between pages. */
function art(src, dst){
  const sheet = (x, y, rot, c, label) => `
    <g transform="translate(${x} ${y}) rotate(${rot})">
      <path d="M0 8a8 8 0 0 1 8-8h62l32 32v100a8 8 0 0 1-8 8H8a8 8 0 0 1-8-8z" fill="#fff" stroke="${c}" stroke-width="2.6" stroke-linejoin="round"/>
      <path d="M70 0l32 32H78a8 8 0 0 1-8-8z" fill="${c}" opacity=".2"/>
      <g stroke="${c}" stroke-width="2.6" stroke-linecap="round" opacity=".5">
        <path d="M18 54h52M18 68h66M18 82h40"/>
      </g>
      <rect x="12" y="100" width="60" height="25" rx="6" fill="${c}"/>
      <text x="42" y="117.5" text-anchor="middle" font-size="13" font-weight="700"
            fill="#fff" font-family="Inter, sans-serif" letter-spacing=".3">${label}</text>
    </g>`;

  return `<svg class="up-art" width="300" height="196" viewBox="0 0 300 196" fill="none" role="img"
     aria-label="${FMT[src].short} converted to ${FMT[dst].short}">
  <path d="M60 40C72 6 196 -2 220 26" stroke="${FMT[dst].color}" stroke-width="2.4"
        stroke-dasharray="6 8" stroke-linecap="round" opacity=".55"/>
  <path d="M211 15l10 11-14 5" stroke="${FMT[dst].color}" stroke-width="2.4"
        stroke-linecap="round" stroke-linejoin="round" opacity=".55"/>
${sheet(24, 44, -9, FMT[src].color, FMT[src].badge)}
${sheet(150, 34, 7, FMT[dst].color, FMT[dst].badge)}
  <path d="M12 96l2.9 7.1L22 106l-7.1 2.9L12 116l-2.9-7.1L2 106l7.1-2.9z" fill="#2563EB" opacity=".75"/>
  <path d="M286 124l1.9 4.6 4.6 1.9-4.6 1.9-1.9 4.6-1.9-4.6-4.6-1.9 4.6-1.9z" fill="#2563EB" opacity=".55"/>
  <circle cx="276" cy="52" r="3.4" fill="${FMT[dst].color}" opacity=".7"/>
</svg>`;
}

/* Neighbours, not the whole catalogue. Listing all seventy-three others under
   every page buried the copy above it and made each page a near-duplicate of
   the rest — which is exactly what a search engine treats as thin content. The
   ones in the same tab are the ones somebody on this page might actually want,
   and the hub is one click away for everything else. */
function related(a, b){
  const cat = CONVERSIONS.find(c => c.a === a && c.b === b)?.cat;
  const near = CONVERSIONS.filter(c => c.cat === cat && !(c.a === a && c.b === b));
  const pop = CONVERSIONS.filter(c => c.pop && c.cat !== cat);
  return [...near, ...pop].slice(0, 11).map(({a: x, b: y}) => `
        <a class="conv-card" href="./${convSlug(x,y)}.html">
          <span class="conv-chip" style="background:${FMT[y].color}">${FMT[y].badge}</span>
          ${convTitle(x,y)}
        </a>`).join('');
}

function page(a, b){
  const s = convSlug(a,b), t = convTitle(a,b);
  const src = FMT[a], dst = FMT[b];
  const live = isLive(a, b);
  const url = `${SITE}/convert/${s}.html`;
  /* Composed from what the two formats actually are, so every page describes
     its own conversion. A meta description shared across seventy-four URLs
     tells a search engine they are the same page. */
  const desc = `${src.short} is ${fmtNote(a)}. Turn it into ${dst.short} — ${fmtNote(b)} — `
             + `free and in your browser, with no upload, no account and no watermark.`;
  const why = `${src.short} gives you ${fmtNote(a)}. ${dst.short} gives you ${fmtNote(b)}. `
            + `Converting between them takes a few seconds here, and the file never leaves this tab.`;

  return `<!DOCTYPE html>
${BANNER}
<html lang="en">
<head>
${head({title:`${t} Converter — Free, No Upload | Quire`, desc, url, prefix:'../', extraCss:['convert.css']})}

<script type="application/ld+json">
{
  "@context":"https://schema.org",
  "@type":"BreadcrumbList",
  "itemListElement":[
    {"@type":"ListItem","position":1,"name":"Home","item":"${SITE}/"},
    {"@type":"ListItem","position":2,"name":"Convert ${t}","item":"${url}"}
  ]
}
</script>
<script type="application/ld+json">
{
  "@context":"https://schema.org",
  "@type":"HowTo",
  "name":"How to convert ${t}",
  "totalTime":"PT1M",
  "step":[
    {"@type":"HowToStep","name":"Choose ${article(src.short)} ${src.short} file","text":"Drop a ${src.ext} file onto the card, or click it and pick one from your disk."},
    {"@type":"HowToStep","name":"Let it convert","text":"The file is read and rebuilt as ${dst.short} in your browser, keeping layout, fonts and images."},
    {"@type":"HowToStep","name":"Download the ${dst.short}","text":"The finished ${dst.ext} file is written straight to your machine."}
  ]
}
</script>
</head>
<body>

${header('../', {section:'converter', page:s})}

<main>
  <div class="wrap">
    <nav class="crumbs" aria-label="Breadcrumb">
      <a href="../">Home</a>
      <svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>
      <b>Convert ${t}</b>
    </nav>
  </div>

  <div class="wrap conv-hero">
    <div class="conv-copy">
      <span class="conv-tag"><i></i>Free · no upload · no watermark</span>
      <h1>Convert ${t}</h1>
      <p class="conv-why">${why}</p>
      <ul class="q-ticks">
        <li><span><svg viewBox="0 0 24 24"><path d="M20 6.5 9.5 17 4 11.5"/></svg></span>Works directly in your browser</li>
        <li><span><svg viewBox="0 0 24 24"><path d="M20 6.5 9.5 17 4 11.5"/></svg></span>Keeps the original formatting and quality</li>
        <li><span><svg viewBox="0 0 24 24"><path d="M20 6.5 9.5 17 4 11.5"/></svg></span>Downloads in seconds, with no queue</li>
        <li><span><svg viewBox="0 0 24 24"><path d="M20 6.5 9.5 17 4 11.5"/></svg></span>No account, no watermark, no page limit</li>
      </ul>
    </div>

    <div class="up">
      <label class="up-in"${live ? ` data-convert="${a}>${b}"` : ''}>
        <input type="file" accept="${src.ext}" aria-label="Choose ${article(src.short)} ${src.short} file to convert">
        <h3>${live ? `Choose ${article(src.short)} ${src.short} file` : 'Upload your file'}</h3>
        ${art(a,b)}
        <p class="up-drop">Drop files here</p>
        <div class="up-or">OR</div>
        <span class="btn btn--primary btn--lg">Convert to ${dst.short}</span>
        <p class="up-fine">${live
          ? 'Converted in this tab · nothing is uploaded'
          : 'Read locally, never uploaded'}</p>
      </label>
      ${live
        ? '<div class="conv-out" id="convOut" hidden aria-live="polite"></div>'
        : `<div class="conv-out conv-out--soon">
        <p>The ${t} conversion is not built yet. This one needs work a browser
        cannot do on its own, so it is honest about that rather than accepting your
        file and giving nothing back. <a href="../converter.html">The image converters</a>
        all run for real today.</p>
      </div>`}
    </div>
  </div>

  <section class="q-section">
    <div class="wrap">
      <div class="q-head">
        <h2>How to convert ${t}</h2>
        <p>Three steps, none of which involve handing your document to a stranger's server.</p>
      </div>
      <div class="q-steps">
        <div class="q-step">
          <b>Choose your ${src.short} file</b>
          <p>Drop a ${src.ext} onto the card or click to pick one. It is read in the browser, so there is no upload and no waiting.</p>
        </div>
        <div class="q-step">
          <b>Let it convert</b>
          <p>The file is parsed and rebuilt as ${dst.short}, keeping the layout, fonts and images as close to the original as the format allows.</p>
        </div>
        <div class="q-step">
          <b>Download the ${dst.short}</b>
          <p>The finished ${dst.ext} lands straight in your downloads folder. Open it, or send it back into the editor for more work.</p>
        </div>
      </div>
    </div>
  </section>

  <section class="q-section">
    <div class="wrap">
      <div class="q-head">
        <h2>Related conversions</h2>
        <p>Same engine, same privacy. <a href="../converter.html">See all ${PAIRS.length}</a>.</p>
      </div>
      <div class="conv-tools">${related(a,b)}
      </div>
    </div>
  </section>
</main>

${footer('../')}

<script type="module" src="../assets/site.js"></script>
${live ? '<script type="module" src="../assets/convert-ui.js"></script>' : ''}
</body>
</html>
`;
}

/* ── the hub ──────────────────────────────────────────────────────────────
   Seventy-four pages need a front door. The tabs filter in the browser rather
   than loading five near-identical pages, because the whole list is a few
   kilobytes of markup and a round trip to see nine more cards is a round trip
   nobody asked for. Every conversion still has its own indexed URL — this page
   is the way in, not a replacement for them. */
function hub(){
  const url = `${SITE}/converter.html`;
  const desc = 'Convert PDF, images and documents in your browser — PDF to Word, image to PDF, '
             + 'HEIC to JPG and 70 more. Nothing is uploaded, nothing is watermarked.';

  const cards = CONVERSIONS.map(c => `        <a class="conv-card" href="./convert/${convSlug(c.a,c.b)}.html"
           data-cat="${c.cat}"${c.pop ? ' data-pop' : ''}>
          <span class="conv-chip" style="background:${FMT[c.b].color}">${FMT[c.b].badge}</span>
          ${convTitle(c.a,c.b)}
        </a>`).join('\n');

  return `<!DOCTYPE html>
${BANNER}
<html lang="en">
<head>
${head({title: `Online PDF Converter — ${CONVERSIONS.length} formats, free and private | Quire`, desc, url, prefix:'./', extraCss:['forms.css','convert.css']})}

<script type="application/ld+json">
{
  "@context":"https://schema.org",
  "@type":"CollectionPage",
  "name":"PDF and image converter",
  "url":"${url}",
  "description":"${desc}",
  "isPartOf":{"@type":"WebSite","name":"Quire","url":"${SITE}/"}
}
</script>
</head>
<body>

${header('./', {section:'converter'})}

<main>
  <div class="fhero">
    <div class="wrap">
      <h1>Convert anything to PDF, and back</h1>
      <p class="chero-sub">${LIVE_COUNT === CONVERSIONS.length
        ? `All ${CONVERSIONS.length} conversions run in this tab. There is no page here that
        takes a file and gives nothing back`
        : `${LIVE_COUNT} conversions run in this tab today, out of ${CONVERSIONS.length} the
        site has a page for &mdash; the rest say plainly that they are not built yet`}. Your file
        is read by the browser and never sent anywhere.</p>
      <div class="fsearch">
        <svg viewBox="0 0 24 24"><circle cx="10.6" cy="10.6" r="6.6"/><path d="M20.5 20.5l-5.2-5.2"/></svg>
        <input id="cq" type="search" placeholder="Search a format — HEIC, DOCX, SVG…" aria-label="Search converters">
      </div>
    </div>
  </div>

  <div class="wrap cbody">
    <div class="ctabs" role="tablist">
${CONV_TABS.map((t,i) => `      <button class="ctab" data-tab="${t.id}" role="tab" aria-selected="${i===0}">${t.label}</button>`).join('\n')}
    </div>

    <div class="conv-tools" id="cgrid">
${cards}
    </div>

    <p class="fempty" id="cempty" hidden>No converter matches that. Try just the format — “svg”, “heic”.</p>
  </div>
</main>

${footer('./')}

<script type="module" src="./assets/site.js"></script>
<script type="module" src="./assets/converter.js"></script>
</body>
</html>
`;
}

mkdirSync(join(ROOT, 'convert'), {recursive:true});
for (const [a,b] of PAIRS){
  writeFileSync(join(ROOT, 'convert', `${convSlug(a,b)}.html`), page(a,b), 'utf8');
}
writeFileSync(join(ROOT, 'converter.html'), hub(), 'utf8');
console.log(`converter.html + ${PAIRS.length} converter pages generated.`);
