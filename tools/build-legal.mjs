/* Generates privacy.html and terms.html.
 *
 * Deliberately short. These pages describe a static site with no backend, no
 * accounts and no analytics, and a policy that claims more machinery than the
 * site actually has is worse than no policy at all.
 *
 *   node tools/build-legal.mjs
 */
import {writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {BANNER, SITE, head, header, footer} from './shared.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UPDATED = '7 August 2026';
const CONTACT = 'https://uz-or.com/#contact';

function shell({file, title, desc, body}){
  const url = `${SITE}/${file}`;
  return `<!DOCTYPE html>
${BANNER}
<html lang="en">
<head>
${head({title, desc, url, prefix:'./', extraCss:['legal.css']})}
<meta name="robots" content="index, follow">
</head>
<body>

${header('./', {})}

<main class="legal">
${body}
</main>

${footer('./')}

<script type="module" src="./assets/site.js"></script>
</body>
</html>
`;
}

/* ── privacy ──────────────────────────────────────────────────────────── */

const privacy = shell({
  file: 'privacy.html',
  title: 'Privacy Policy | Quire',
  desc: 'Quire runs entirely in your browser. Your documents are never uploaded, and we do not use accounts, analytics or tracking cookies.',
  body: `<h1>Privacy Policy</h1>
<p class="updated">Last updated ${UPDATED}</p>

<div class="summary">
  <b>The short version</b>
  <p>Your documents never leave your device. There are no accounts, no tracking cookies and no analytics. We could not read your files even if we wanted to, because they are never sent to us.</p>
</div>

<h2>1. Who this covers</h2>
<p>
  This policy applies to the Quire website and the tools on it — the PDF editor,
  the converters and the form library. Quire is a free, personal project by
  Mykhailo Nahreba. There is no company behind it and nothing on it is sold.
</p>

<h2>2. Your documents</h2>
<p>
  Every file you open here is read, changed and saved by code running inside your
  own browser tab. <b>No document, page, image or signature is ever transmitted to
  us or to any third party.</b> There is no upload step, no processing queue and no
  server-side copy — which also means there is nothing for us to retain, disclose
  or delete on request.
</p>
<p>
  Close the tab and the document is gone from memory. If you want to keep your
  work, export it before you leave.
</p>

<h2>3. What is stored on your device</h2>
<p>
  Some things are saved locally so the tools remember them between visits. They
  live in your browser's own storage and are never sent anywhere:
</p>
<ul>
  <li>signatures you create, so you do not have to redraw them each time;</li>
  <li>small interface preferences, such as the last tool you used.</li>
</ul>
<p>
  You can wipe all of it at any time by clearing site data for this domain in your
  browser settings.
</p>

<h2>4. Cookies and analytics</h2>
<p>
  This site sets <b>no tracking cookies</b> and runs <b>no analytics</b>. We do not
  know how many people visit, which pages they read, or where they came from.
  If that ever changes, this section will be updated before the change goes live.
</p>

<h2>5. Third parties we do rely on</h2>
<p>Two things are worth naming plainly, because they are the only points at which
   any data leaves your browser at all:</p>
<ul>
  <li>
    <b>Fonts.</b> Typefaces are loaded from Google Fonts. Your browser therefore
    makes a request to Google's servers, which sees your IP address and user agent
    as part of any ordinary web request.
  </li>
  <li>
    <b>Hosting.</b> The site is served as static files by our hosting provider,
    which keeps standard server access logs (IP address, time, requested file) for
    operational and security purposes.
  </li>
</ul>
<p>
  Neither of these ever receives the contents of a document, because the document
  is never part of a network request.
</p>

<h2>6. Links to other sites</h2>
<p>
  Pages in the form library link to the agencies that actually issue those forms —
  the IRS, USCIS, the Social Security Administration, the U.S. Department of State
  and others. Once you follow such a link you are on their site, under their
  privacy policy, not ours.
</p>

<h2>7. Children</h2>
<p>
  This is a general-purpose document tool and is not directed at children. We do
  not knowingly collect information from anyone, of any age, because we do not
  collect information at all.
</p>

<h2>8. Your rights</h2>
<p>
  Rights such as access, correction, deletion and portability apply to personal
  data held by an operator. We hold none. Anything the tools store is already in
  your own browser and entirely under your control.
</p>

<h2>9. Changes</h2>
<p>
  If this policy changes, the date at the top changes with it. Material changes —
  particularly anything that would start collecting data — will be stated plainly
  rather than folded into the wording.
</p>

<h2>10. Contact</h2>
<p>
  Questions about this policy can go through the contact section of the author's
  site: <a href="${CONTACT}" target="_blank" rel="noopener">uz-or.com</a>.
</p>

<hr>
<p>See also the <a href="./terms.html">Terms of Use</a>.</p>`,
});

/* ── terms ────────────────────────────────────────────────────────────── */

const terms = shell({
  file: 'terms.html',
  title: 'Terms of Use | Quire',
  desc: 'The terms under which the free Quire PDF editor, converters and form library are provided — supplied as-is, with no warranty.',
  body: `<h1>Terms of Use</h1>
<p class="updated">Last updated ${UPDATED}</p>

<div class="summary">
  <b>The short version</b>
  <p>Free to use, for anything lawful. Provided as-is with no guarantees. The form pages are not legal or tax advice. Your documents stay yours.</p>
</div>

<h2>1. Agreement</h2>
<p>
  By using this site you accept these terms. If you do not accept them, please do
  not use it. Quire is a free personal project by Mykhailo Nahreba.
</p>

<h2>2. What the service is</h2>
<p>
  Quire is a set of browser-based document tools: a PDF editor, file converters and
  a library of form pages. Everything runs locally in your browser. There is no
  account, no subscription and no charge.
</p>

<h2>3. Use of the service</h2>
<p>You may use Quire for personal or commercial work. You may not:</p>
<ul>
  <li>use it to process material you have no right to process;</li>
  <li>use it to produce forged, fraudulent or deliberately misleading documents;</li>
  <li>attempt to interfere with the site, or with other people's use of it;</li>
  <li>republish the site as your own service.</li>
</ul>

<h2>4. Your documents and your content</h2>
<p>
  You keep all rights to everything you open, create or export here. We claim no
  licence over it and, as explained in the <a href="./privacy.html">Privacy
  Policy</a>, we never receive it in the first place.
</p>
<p>
  You are responsible for keeping your own copies. Because nothing is stored on a
  server, work lost by closing a tab before exporting cannot be recovered — by you
  or by us.
</p>

<h2>5. Forms are not advice</h2>
<p>
  The form pages exist to explain a document and help you fill it in. They are
  <b>not legal, tax, immigration or medical advice</b>, and Quire is not affiliated
  with, endorsed by or acting for any government agency.
</p>
<ul>
  <li>
    Where a page describes an <b>official form</b>, the button links to the issuing
    agency. Always take the current version from the agency itself — revisions,
    fees and filing addresses change.
  </li>
  <li>
    Where a page offers a <b>template</b>, it is a starting point that people
    prepare themselves. Requirements differ by jurisdiction. If a document matters,
    have a qualified professional look at it.
  </li>
</ul>

<h2>6. No warranty</h2>
<p>
  The service is provided <b>as-is and as-available</b>, without warranty of any
  kind, express or implied, including fitness for a particular purpose. Conversion
  between document formats is inherently lossy: layout, fonts and images may not
  survive intact, and you should check any output before relying on it.
</p>

<h2>7. Limitation of liability</h2>
<p>
  To the fullest extent permitted by law, the author is not liable for any loss of
  data, profit, time or opportunity arising from use of this site, nor for any
  indirect or consequential damage. This is a free tool offered in good faith, and
  it is used at your own risk.
</p>

<h2>8. Third-party links</h2>
<p>
  External links are provided for convenience. We do not control those sites and
  are not responsible for their content, availability or practices.
</p>

<h2>9. Intellectual property</h2>
<p>
  The Quire name, interface and source code belong to their author. Names of
  formats, agencies and third-party products mentioned on the site belong to their
  respective owners and are used only to describe what the tools do.
</p>

<h2>10. Availability and changes</h2>
<p>
  The service may be changed, interrupted or discontinued at any time, without
  notice. These terms may also change; the date at the top will reflect it, and
  continued use after a change means you accept the revised version.
</p>

<h2>11. Contact</h2>
<p>
  Questions can go through the contact section of the author's site:
  <a href="${CONTACT}" target="_blank" rel="noopener">uz-or.com</a>.
</p>

<hr>
<p>See also the <a href="./privacy.html">Privacy Policy</a>.</p>`,
});

writeFileSync(join(ROOT, 'privacy.html'), privacy, 'utf8');
writeFileSync(join(ROOT, 'terms.html'), terms, 'utf8');
console.log('privacy.html + terms.html generated.');
