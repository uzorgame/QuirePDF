/* The upload card on a converter page that can actually convert.
 *
 * Three states and no others: waiting, working, done. A card that says "Drop
 * files here" and then quietly does nothing is worse than one that refuses,
 * because the reader assumes it worked.
 *
 * Errors are shown in the card rather than in an alert(). An alert is a modal
 * that steals focus, cannot be read alongside the thing it is about, and is
 * blocked outright in some embedded browsers. */

import {convert, accepts, outName, Refused} from './convert.js';

const card = document.querySelector('[data-convert]');
if (card) setUp(card);

function setUp(zone) {
  const [src, dst] = zone.dataset.convert.split('>');
  const input = zone.querySelector('input[type=file]');
  const drop = zone.querySelector('.up-drop');
  const out = document.getElementById('convOut');
  let url = null;

  const reset = () => {
    if (url) { URL.revokeObjectURL(url); url = null; }
    out.replaceChildren();
    out.hidden = true;
    zone.classList.remove('busy');
  };

  const fail = (message) => {
    zone.classList.remove('busy');
    out.hidden = false;
    out.className = 'conv-out conv-out--bad';
    out.replaceChildren(Object.assign(document.createElement('p'), {textContent: message}));
  };

  const done = (blob, name) => {
    /* A PDF of thirty pages becomes thirty pictures, and thirty save prompts
       is not a download — so those arrive as one zip, and the label says which
       it is rather than leaving a .zip to be discovered. */
    if (blob.multi) name = name.replace(/\.[^.]+$/, '') + '.zip';
    zone.classList.remove('busy');
    url = URL.createObjectURL(blob);
    out.hidden = false;
    out.className = 'conv-out conv-out--ok';

    const a = document.createElement('a');
    a.className = 'btn btn--primary';
    a.href = url;
    a.download = name;
    a.textContent = `Download ${name}`;

    const size = blob.size < 1024 * 1024
      ? `${Math.max(1, Math.round(blob.size / 1024))} KB`
      : `${(blob.size / 1048576).toFixed(1)} MB`;

    const note = document.createElement('p');
    /* A conversion that could not take the whole file says so here. A GIF is
       cut to a few seconds because the format has no motion compensation and
       a long clip becomes hundreds of megabytes — but a file that quietly
       came back shorter than it went in is the kind of surprise somebody
       finds out about after sending it on. */
    note.textContent = blob.multi
      ? `${blob.multi} pages · ${size} zipped. Nothing was uploaded.`
      : `Converted · ${size}${blob.note ? ` · ${blob.note}` : ''}. Nothing was uploaded.`;

    out.replaceChildren(note, a);
    /* The link is only alive while this page is. Saying so beats a reader
       coming back to a dead download an hour later. */
  };

  async function run(file) {
    reset();
    if (!file) return;
    if (file.size > 40 * 1024 * 1024) {
      fail(`That file is ${(file.size / 1048576).toFixed(0)} MB. Anything past 40 MB has to be `
        + 'held in memory twice over to convert, which most browsers will not survive.');
      return;
    }
    zone.classList.add('busy');
    drop.textContent = file.name;
    /* Yields once so the busy state paints before a large decode blocks the
       main thread — otherwise the spinner appears only after the work is done. */
    await new Promise(r => setTimeout(r, 0));
    try {
      /* A thirty-page PDF takes a while, and a card that says nothing for
         twenty seconds is indistinguishable from one that has hung. The
         callback is named `n` rather than `done` because `done` is the function
         that finishes this off, three lines below. */
      const blob = await convert(file, src, dst, (n, total) => {
        if (total > 1) drop.textContent = `${file.name} — page ${n} of ${total}`;
      });
      done(blob, outName(file.name, dst));
    } catch (err) {
      /* Matched on the name rather than the class: the message may have come
         from the dynamically-imported engine, whose Refused is a different
         constructor. Getting this wrong replaced every careful explanation with
         "failed unexpectedly". */
      fail(err?.name === 'Refused' ? err.message
        : 'That conversion failed unexpectedly. The file may be damaged.');
    }
  }

  /* A PDF page should not offer to pick a picture, and a CSV page should not
     offer either. The wildcard is only there so a phone's photo picker opens
     on the pages where a photo is the point. */
  const exts = accepts(src).map(k => '.' + k);
  const picture = accepts(src).some(k => ['jpg','png','webp','avif','gif','bmp','heic','svg'].includes(k));
  input.accept = exts.join(',') + (picture ? ',image/*' : '');
  input.addEventListener('change', () => run(input.files[0]));

  ['dragenter', 'dragover'].forEach(ev => zone.addEventListener(ev, e => {
    e.preventDefault(); zone.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach(ev => zone.addEventListener(ev, e => {
    e.preventDefault(); zone.classList.remove('over');
  }));
  zone.addEventListener('drop', e => run(e.dataTransfer.files[0]));
}
