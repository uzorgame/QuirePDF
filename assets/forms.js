/* Library filtering. Everything is already in the DOM, so search and category
   are pure show/hide — no fetch, no re-render, and it keeps working if the
   scripts are cached and the network is not there. */
(() => {
  const grid  = document.getElementById('grid');
  if (!grid) return;
  const cards = [...grid.querySelectorAll('.fcard')];
  const q     = document.getElementById('q');
  const count = document.getElementById('count');
  const empty = document.getElementById('empty');
  const cats  = [...document.querySelectorAll('.fcat')];

  let category = '';
  let term = '';

  function apply(){
    let shown = 0;
    for (const c of cards){
      const hit =
        (!category || c.dataset.cat === category) &&
        (!term || c.dataset.name.includes(term) || c.dataset.tags.includes(term));
      c.hidden = !hit;
      if (hit) shown++;
    }
    count.textContent = `${shown} form${shown === 1 ? '' : 's'}`;
    empty.hidden = shown > 0;
  }

  q.addEventListener('input', () => { term = q.value.trim().toLowerCase(); apply(); });

  cats.forEach(b => b.addEventListener('click', () => {
    category = b.dataset.cat;
    cats.forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    apply();
  }));

  /* A topic chip is just a search with the words filled in for you. */
  document.querySelectorAll('.ftopic').forEach(b => b.addEventListener('click', () => {
    q.value = b.dataset.topic;
    term = b.dataset.topic.toLowerCase();
    category = '';
    cats.forEach(x => x.setAttribute('aria-pressed', String(x.dataset.cat === '')));
    apply();
    document.querySelector('.fbody').scrollIntoView({block:'start'});
  }));
})();
