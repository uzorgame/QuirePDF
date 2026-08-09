/* What every dialog in the editor does, done once.
 *
 * There are four of them and they are opened from four different places — the
 * start dialog builds its own previews, the signature pad owns a canvas, export
 * is assembled from the document, and the discard prompt is raised from three
 * separate paths. What they have in common is not their contents but their
 * behaviour: while one is open it should be the only thing you can reach.
 *
 * That behaviour is attached here by watching for the `on` class rather than by
 * routing every opener through a function. The class is already the switch —
 * asking each caller to also announce itself would be a second switch that
 * could fall out of step with the first, and a dialog that is visible but not
 * trapped is worse than one that was never wired up, because it looks right.
 *
 * What it adds:
 *   · focus moves into the dialog and cannot leave it while it is open
 *   · focus returns to whatever opened it on the way out
 *   · the page behind stops scrolling
 *   · screen readers are told it is a dialog, and which one
 *   · Escape belongs to the topmost dialog and to nothing else */

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type=hidden])',
  'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',');

const openers = new WeakMap<HTMLElement, HTMLElement>();
let scrollLocks = 0;

function inside(ovl: HTMLElement): HTMLElement[] {
  return [...ovl.querySelectorAll<HTMLElement>(FOCUSABLE)]
    /* offsetParent is null for anything display:none — a tab panel that is not
       the open one, for instance — and tabbing into an invisible control is
       one of the more disorienting things a dialog can do. */
    .filter(el => el.offsetParent !== null || el === document.activeElement);
}

function opened(ovl: HTMLElement): void {
  const active = document.activeElement;
  if (active instanceof HTMLElement && !ovl.contains(active)) openers.set(ovl, active);

  if (scrollLocks++ === 0) document.body.style.overflow = 'hidden';

  /* The close button is a poor first stop — it reads as "the way out" before
     the reader has heard what they are being asked. Anything else comes
     first; the dialog itself is the fallback. */
  const stops = inside(ovl);
  const first = stops.find(el => !el.hasAttribute('data-close') && !el.classList.contains('close'));
  (first ?? stops[0] ?? ovl).focus({preventScroll: true});
}

function closed(ovl: HTMLElement): void {
  if (scrollLocks > 0 && --scrollLocks === 0) document.body.style.overflow = '';

  const back = openers.get(ovl);
  openers.delete(ovl);
  /* Only if it is still on the page and still focusable — the button that
     opened the start dialog may well have been replaced by the document it
     produced. */
  if (back?.isConnected) back.focus({preventScroll: true});
}

/** True if a dialog is on screen, so other Escape handlers can stand down. */
export function anyModalOpen(): boolean {
  return !!document.querySelector('.ovl.on');
}

export function wireModals(): void {
  const all = [...document.querySelectorAll<HTMLElement>('.ovl')];

  for (const ovl of all) {
    const modal = ovl.querySelector<HTMLElement>('.modal');
    if (!modal) continue;

    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.tabIndex = -1;

    /* The close button is the character ×, which is announced as "times" —
       a multiplication sign where a way out was meant. */
    for (const x of modal.querySelectorAll<HTMLElement>('.close')) {
      if (!x.getAttribute('aria-label')) x.setAttribute('aria-label', 'Close');
    }

    /* Labelled by its own heading where there is one, so a screen reader
       announces "Export, dialog" rather than just "dialog". */
    const head = modal.querySelector('h3');
    if (head) {
      if (!head.id) head.id = `${ovl.id || 'ovl'}-title`;
      modal.setAttribute('aria-labelledby', head.id);
    }

    new MutationObserver(records => {
      for (const r of records) {
        const was = (r.oldValue ?? '').split(/\s+/).includes('on');
        const now = ovl.classList.contains('on');
        if (was === now) continue;
        if (now) opened(ovl); else closed(ovl);
      }
    }).observe(ovl, {attributes: true, attributeFilter: ['class'], attributeOldValue: true});
  }

  /* Tab is kept inside the topmost dialog. Without this the first Tab lands on
     the toolbar behind the backdrop, which is both unreachable with the mouse
     and, for anyone navigating by keyboard, indistinguishable from the dialog
     having vanished. */
  document.addEventListener('keydown', e => {
    if (e.key !== 'Tab') return;
    const ovl = [...document.querySelectorAll<HTMLElement>('.ovl.on')].at(-1);
    if (!ovl) return;

    const stops = inside(ovl);
    if (!stops.length) { e.preventDefault(); return; }

    const first = stops[0]!;
    const last = stops[stops.length - 1]!;
    const active = document.activeElement;

    if (!ovl.contains(active)) { e.preventDefault(); first.focus(); return; }
    if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
  }, true);
}
