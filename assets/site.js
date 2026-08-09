import {parkFile, isPdf} from './handoff.js';

/* Header behaviour shared by every content page. */

/* ── converter dropdown ────────────────────────────────
   Opens on click and on hover, because a nav item that only answers to one of
   the two feels broken to whichever half of your users expects the other. The
   close is delayed so the pointer can cross the gap to the panel. */
document.querySelectorAll('[data-drop]').forEach(drop => {
  const btn = drop.querySelector('.drop-btn');
  let leaveTimer;

  const open = () => {
    clearTimeout(leaveTimer);
    drop.setAttribute('data-open', '');
    btn.setAttribute('aria-expanded', 'true');
  };
  const close = () => {
    drop.removeAttribute('data-open');
    btn.setAttribute('aria-expanded', 'false');
  };

  btn.addEventListener('click', e => {
    e.stopPropagation();
    drop.hasAttribute('data-open') ? close() : open();
  });
  drop.addEventListener('mouseenter', open);
  drop.addEventListener('mouseleave', () => { leaveTimer = setTimeout(close, 140); });

  document.addEventListener('click', e => { if (!drop.contains(e.target)) close(); });
  addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
});

/* ── upload cards ──────────────────────────────────────
   Same hand-off on the converter pages as on the home page: validate, remember
   the name, then move on. The conversion itself lands with the PDF engine. */
document.querySelectorAll('.up-in').forEach(zone => {
  const input = zone.querySelector('input[type=file]');
  const accept = (input.getAttribute('accept') || '').toLowerCase();

  ['dragenter','dragover'].forEach(ev => zone.addEventListener(ev, e => {
    e.preventDefault(); zone.classList.add('over');
  }));
  ['dragleave','drop'].forEach(ev => zone.addEventListener(ev, e => {
    e.preventDefault(); zone.classList.remove('over');
  }));
  zone.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) hand(f); });
  input.addEventListener('change', () => { if (input.files[0]) hand(input.files[0]); });

  async function hand(f){
    if (accept && !f.name.toLowerCase().endsWith(accept)){
      alert(`That is not a ${accept} file.`);
      return;
    }
    zone.querySelector('.up-drop').textContent = f.name;
    /* A PDF dropped on a converter page can already be opened for real, so it is
       parked exactly as the home page parks it. The conversion itself still
       waits on the format writers. */
    if (isPdf(f)) { try { await parkFile(f); } catch { /* private mode */ } }
  }
});
