/* The converter hub: five tabs and a search box over one list.
 *
 * Both narrow the same grid, and they compose — searching inside "Convert
 * image" searches only that tab. Typing switches to every tab, because a
 * search that silently hides the match you were looking for is worse than no
 * search. */

const grid = document.getElementById('cgrid');
const empty = document.getElementById('cempty');
const q = document.getElementById('cq');
const tabs = [...document.querySelectorAll('.ctab')];
const cards = [...grid.querySelectorAll('.conv-card')];

let tab = 'pop';

function apply() {
  const term = q.value.trim().toLowerCase();
  let shown = 0;

  for (const card of cards) {
    /* The first tab is a selection across the others, so it matches on the
       flag rather than on the category. */
    const inTab = term ? true
      : tab === 'pop' ? card.hasAttribute('data-pop')
      : card.dataset['cat'] === tab;
    const hit = !term || card.textContent.toLowerCase().includes(term);
    const on = inTab && hit;
    card.hidden = !on;
    if (on) shown++;
  }

  empty.hidden = shown > 0;
  for (const t of tabs) t.setAttribute('aria-selected', String(!term && t.dataset['tab'] === tab));
}

for (const t of tabs) {
  t.addEventListener('click', () => {
    tab = t.dataset['tab'];
    q.value = '';
    apply();
  });
}

q.addEventListener('input', apply);
apply();
