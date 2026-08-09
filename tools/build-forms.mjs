/* Generates forms.html (the library) and one page per form.
 *
 *   node tools/build-forms.mjs
 */
import {writeFileSync, mkdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {BANNER, SITE, FORMS, FEATURED, CATEGORIES, formBy, head, header, footer} from './shared.mjs';
import {noteFor} from './form-notes.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');

const TOPICS = ['IRS','Passports & Visas','Lease Agreements','Rental Agreements','Bills of Sale','Notary Forms','Child Authorizations'];

/* ── the library ──────────────────────────────────────────────────────── */

function card(f){
  return `        <a class="fcard" href="./forms/${f.slug}.html"
           data-name="${esc((f.code + ' ' + f.name).toLowerCase())}"
           data-cat="${esc(f.category)}"
           data-tags="${esc(f.tags.join(' ').toLowerCase())}">
          <span class="fcard-art">
            <img src="./forms/previews/${f.slug}.webp" alt="" loading="lazy" decoding="async" width="400">
          </span>
          <span class="fcard-tags">
            <span class="fchip fchip--cat">${esc(f.category)}</span>
            <span class="fchip">${esc(f.tags[0])}</span>
          </span>
          <b>${esc(f.name)}</b>
          <em>${f.kind === 'official' ? esc(f.agency) : 'Fill-in template'}</em>
        </a>`;
}

function library(){
  const url = `${SITE}/forms.html`;
  const desc = 'Free library of PDF forms — IRS, passport, immigration, lease, notary and '
             + 'medical documents. Open any of them in the editor and fill it in your browser.';

  return `<!DOCTYPE html>
${BANNER}
<html lang="en">
<head>
${head({title:'All PDF Forms — IRS, Passport, Legal and Medical | Quire', desc, url, prefix:'./', extraCss:['forms.css']})}

<script type="application/ld+json">
{
  "@context":"https://schema.org",
  "@type":"CollectionPage",
  "name":"PDF form library",
  "url":"${url}",
  "description":"${desc}",
  "isPartOf":{"@type":"WebSite","name":"Quire","url":"${SITE}/"}
}
</script>
</head>
<body>

${header('./', {section:'forms'})}

<main>
  <div class="fhero">
    <div class="wrap">
      <h1>Find the form you need</h1>
      <div class="fsearch">
        <svg viewBox="0 0 24 24"><circle cx="10.6" cy="10.6" r="6.6"/><path d="M20.5 20.5l-5.2-5.2"/></svg>
        <input id="q" type="search" placeholder="Search by form name, number or purpose" aria-label="Search forms">
      </div>
      <div class="ftopics">
        <span>Popular topics:</span>
${TOPICS.map(t => `        <button class="ftopic" data-topic="${esc(t)}">${esc(t)}</button>`).join('\n')}
      </div>
    </div>
  </div>

  <div class="wrap fbody">
    <aside class="fside">
      <h2>Category</h2>
      <button class="fcat" data-cat="" aria-pressed="true">All forms</button>
${CATEGORIES.map(c => `      <button class="fcat" data-cat="${esc(c)}" aria-pressed="false">${esc(c)}</button>`).join('\n')}
    </aside>

    <div class="fmain">
      <div class="fpinned">
        <h2>Most requested</h2>
        <div class="fpin-grid">
${FEATURED.map(s => formBy(s)).map(f => `          <a class="fpin" href="./forms/${f.slug}.html">
            <span class="fpin-code">${esc(f.code)}</span>
            <span class="fpin-txt"><b>${esc(f.name)}</b><em>${esc(f.agency ?? 'Fill-in template')}</em></span>
            <svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>
          </a>`).join('\n')}
        </div>
      </div>

      <div class="fhead">
        <h2>All forms</h2>
        <span class="fcount" id="count">${FORMS.length} forms</span>
      </div>

      <div class="fgrid" id="grid">
${FORMS.map(card).join('\n')}
      </div>

      <p class="fempty" id="empty" hidden>Nothing matches that. Try a shorter search.</p>
    </div>
  </div>
</main>

${footer('./')}

<script type="module" src="./assets/site.js"></script>
<script type="module" src="./assets/forms.js"></script>
</body>
</html>
`;
}

/* ── a single form ────────────────────────────────────────────────────── */

const GUIDE = {
  'Tax & IRS': {
    what: 'is used to report or certify tax information to the Internal Revenue Service. It is filed on a schedule set by the IRS, and the deadline depends on your filing status and the tax year in question.',
    who : 'Anyone the IRS instructions name as a filer. In practice that usually means employers, payers of non-employee compensation, and the individuals or businesses receiving that income.',
    send: 'Follow the address or e-file route printed in the current IRS instructions for this form. Those change between tax years, so check the instructions rather than reusing last year’s envelope.',
  },
  'Government': {
    what: 'is an application submitted to a federal agency. Processing times, fees and supporting documents are set by that agency and are revised regularly.',
    who : 'Applicants who meet the eligibility conditions published by the issuing agency, and in some cases a sponsor or employer filing on their behalf.',
    send: 'Submit it to the address or online portal named in the agency’s current instructions. Sending an application to a superseded address is one of the most common causes of delay.',
  },
  'Legal': {
    what: 'is a document people prepare themselves, usually witnessed or notarised. It records an agreement, an authorisation or a sworn statement between private parties.',
    who : 'The parties to the agreement. Where a notary block appears, it is completed by the notary public and not by you.',
    send: 'Keep the signed original and give each party a copy. Some documents also have to be recorded with a county office to take effect.',
  },
  'Real Estate': {
    what: 'records the terms of a property arrangement between private parties — who occupies or owns what, on what terms, and for how long.',
    who : 'Landlords and tenants, or buyers and sellers. Requirements differ by state, so check the rules where the property sits.',
    send: 'Each party keeps a signed copy. Deeds and some notices must additionally be filed with the county recorder to be effective.',
  },
  'Business & Finance': {
    what: 'sets out commercial terms between two parties — what is being sold, lent, or agreed, and on what conditions.',
    who : 'Both sides of the transaction. Where money changes hands, keep the signed copy with your accounting records.',
    send: 'No filing is required. Exchange signed copies and keep them for as long as the obligation runs, plus your usual retention period.',
  },
  'Medical': {
    what: 'authorises the release of medical information or the treatment of a patient, and is held by the provider rather than filed with an agency.',
    who : 'The patient, or a parent, guardian or healthcare agent acting for them.',
    send: 'Give the signed form to the provider or records department named on it, and keep a copy for yourself.',
  },
};

function formPage(f){
  const url = `${SITE}/forms/${f.slug}.html`;
  const official = f.kind === 'official';
  const g = GUIDE[f.category];
  /* Specific beats generic: where we have something worth saying about this
     particular form, it replaces the category boilerplate. */
  const n = noteFor(f.slug);
  const desc = official
    ? `Get the current ${f.code} form — ${f.name}, issued by the ${f.agency}. Fill it in your browser with the free Quire PDF editor.`
    : `Free ${f.name} template. Open it in the browser, fill it in and export a signed PDF — no upload and no account.`;
  const related = FORMS.filter(x => x.category === f.category && x.slug !== f.slug).slice(0, 6);

  return `<!DOCTYPE html>
${BANNER}
<html lang="en">
<head>
${head({title:`${f.code} — ${f.name} | Quire`, desc, url, prefix:'../', extraCss:['forms.css']})}

<script type="application/ld+json">
{
  "@context":"https://schema.org",
  "@type":"BreadcrumbList",
  "itemListElement":[
    {"@type":"ListItem","position":1,"name":"Home","item":"${SITE}/"},
    {"@type":"ListItem","position":2,"name":"Forms","item":"${SITE}/forms.html"},
    {"@type":"ListItem","position":3,"name":"${esc(f.code)}","item":"${url}"}
  ]
}
</script>
</head>
<body>

${header('../', {section:'forms', page:f.slug})}

<main>
  <div class="wrap">
    <nav class="crumbs" aria-label="Breadcrumb">
      <a href="../">Home</a>
      <svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>
      <a href="../forms.html">Forms</a>
      <svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>
      <b>${esc(f.code)}</b>
    </nav>
  </div>

  <div class="wrap">
    <div class="fbanner">
      <div class="fbanner-in">
        <span class="fbanner-eyebrow">${official ? esc(f.agency) : 'Fill-in template'}${
          f.pages ? ` · ${f.pages} page${f.pages === 1 ? '' : 's'}` : ''}${
          f.fields ? ` · ${f.fields} fillable field${f.fields === 1 ? '' : 's'}` : ''}</span>
        <h1>${esc(f.name)}</h1>
        ${f.hosted
          ? `<a class="btn btn--primary btn--lg" href="../editor.html#form=${f.slug}">
          Open the form
          <svg viewBox="0 0 24 24"><path d="M4 20.2l.9-4 11-11a2 2 0 0 1 2.8 0l1.1 1.1a2 2 0 0 1 0 2.8l-11 11z"/><path d="M14.8 6.2l3 3"/></svg>
        </a>
        <p class="fbanner-note">
          Opens the real ${esc(f.code)} in the editor — ${f.pages} page${f.pages === 1 ? '' : 's'}${f.fields ? `, ${f.fields} fillable field${f.fields === 1 ? '' : 's'}` : ''}. It is read in your browser and never uploaded.
          Published by the ${esc(f.agency)}; forms are revised, so check the
          <a href="${f.source}" target="_blank" rel="noopener">official page</a> if you must be certain you have the current one.
        </p>${f.writable ? '' : `
        <p class="fbanner-flag">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8.5v4.5"/><path d="M12 16.5h.01"/><circle cx="12" cy="12" r="8.5"/></svg>
          The ${esc(f.agency)} builds this one in a way our writer cannot rewrite, so
          your download is produced by drawing the answers onto the page. It fills
          in, prints and reads correctly — it just stops being fillable afterwards,
          so keep the copy you send rather than editing it again later.
        </p>`}`
          : `<a class="btn btn--primary btn--lg" href="../editor.html#form=${f.slug}">
          Fill this form in the editor
          <svg viewBox="0 0 24 24"><path d="M4 20.2l.9-4 11-11a2 2 0 0 1 2.8 0l1.1 1.1a2 2 0 0 1 0 2.8l-11 11z"/><path d="M14.8 6.2l3 3"/></svg>
        </a>
        <p class="fbanner-note">Opens as a real fillable PDF with proper form fields — click a box and type, sign the signature lines, then download. It is built in your browser and never uploaded. A template, not a government form, so check the rules where you are before relying on it.</p>`}
      </div>

      <!-- The form itself, not a drawing of one. A picture of the real first
           page tells you at a glance whether this is the document you meant,
           which no illustration can do. -->
      <figure class="fsheet">
        <img src="./previews/${f.slug}@lg.webp" width="760"
             alt="First page of the ${esc(f.code)} form" decoding="async">
        <figcaption>Page 1 of ${f.pages || 1}</figcaption>
      </figure>
    </div>

    <div class="fmeta">
      <div><span>Form</span><b>${esc(f.code)}</b></div>
      <div><span>${official ? 'Issued by' : 'Type'}</span><b>${official ? esc(f.agency) : 'Fill-in template'}</b></div>
      <div><span>Category</span><b>${esc(f.category)}</b></div>
      <div><span>Fill it in</span><b>In your browser</b></div>
    </div>
  </div>

  <div class="wrap fguide">
    <nav class="ftoc" aria-label="Table of contents">
      <h2>Table of contents</h2>
      <a href="#about">What this form is for</a>
      <a href="#who">Who needs it</a>
${n?.skip ? '      <a href="#skip">When you do not need it</a>\n' : ''}${n?.ready ? '      <a href="#ready">Before you start</a>\n' : ''}      <a href="#fill">How to fill it in</a>
${n?.watch ? '      <a href="#watch">What goes wrong</a>\n' : ''}      <a href="#submit">Where it goes</a>
      <a href="#related">Related forms</a>
    </nav>

    <article class="fprose">
      <h2 id="about">What this form is for</h2>
      <p>${n?.about
        ? `<b>${esc(f.name)}</b>${official ? ` (${esc(f.code)})` : ''}. ${n.about}`
        : `<b>${esc(f.name)}</b>${official ? ` (${esc(f.code)}, issued by the ${esc(f.agency)})` : ''} ${g.what}`}</p>
${n?.due ? `
      <p class="fdue">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 1.8"/></svg>
        <span><b>Deadline.</b> ${n.due}</span>
      </p>` : ''}

      <h2 id="who">Who needs it</h2>
      <p>${n?.who ?? g.who}</p>
${n?.skip ? `
      <h2 id="skip">When you do not need it</h2>
      <p>${n.skip}</p>` : ''}
${n?.ready ? `
      <h2 id="ready">Before you start</h2>
      <p>Have these to hand — stopping halfway to look one of them up is how a ten-minute job becomes an evening.</p>
      <ul class="fready">
${n.ready.map(r => `        <li>${r}</li>`).join('\n')}
      </ul>` : ''}

      <h2 id="fill">How to fill it in</h2>
      <p>
        Open the file in the Quire editor. Existing form fields become editable
        straight away; on a flat scan you can drop your own text boxes, checkboxes
        and dates exactly where they belong. Sign it with the Sign tool — draw,
        type or upload your signature — then export.
      </p>
      <p>
        Everything happens in your browser. ${official ? 'A tax or immigration form' : 'A signed agreement'}
        carries enough personal information that it has no business sitting on
        somebody else's server, and here it never does.
      </p>

${n?.watch ? `
      <h2 id="watch">What goes wrong</h2>
      <ol class="fwatch">
${n.watch.map(w => `        <li>${w}</li>`).join('\n')}
      </ol>` : ''}

      <h2 id="submit">Where it goes</h2>
      <p>${g.send}</p>

      <div class="fnote">
        <svg viewBox="0 0 24 24"><path d="M12 8.5v5M12 17h.01"/><path d="M10.3 3.9 2.6 17.2a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>
        <p>This page explains the document and helps you fill it in. It is not legal or tax advice, and it is not affiliated with any government agency.</p>
      </div>

      <h2 id="related">Related forms</h2>
      <div class="frelated">
${related.map(r => `        <a class="frel" href="./${r.slug}.html">
          <span class="fpin-code">${esc(r.code)}</span>
          ${esc(r.name)}
        </a>`).join('\n')}
      </div>
    </article>
  </div>
</main>

${footer('../')}

<script type="module" src="../assets/site.js"></script>
</body>
</html>
`;
}

/* ── write ────────────────────────────────────────────────────────────── */

writeFileSync(join(ROOT, 'forms.html'), library(), 'utf8');
mkdirSync(join(ROOT, 'forms'), {recursive:true});
for (const f of FORMS) writeFileSync(join(ROOT, 'forms', `${f.slug}.html`), formPage(f), 'utf8');
console.log(`forms.html + ${FORMS.length} form pages generated.`);
