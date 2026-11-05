'use strict';
(() => {
  const input = document.getElementById('module-search');
  const cards = [...document.querySelectorAll('.module-tile')];
  const buttons = [...document.querySelectorAll('[data-target]')];
  const empty = document.getElementById('no-matches');
  const bell = document.getElementById('notifications-button');
  let selected = null;
  const normalize = text => text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim();
  const clearSelected = () => {selected?.classList.remove('highlight');selected=null;};
  function applyFilter() {
    const query = normalize(input?.value || '');
    let matches = 0;
    for (const tile of cards) {
      const show = !query || normalize(tile.dataset.title || '').includes(query);
      tile.hidden = !show;
      if (show) matches++;
    }
    if (empty) empty.hidden = matches > 0;
    clearSelected();
  }
  function focusCard(id) {
    if (input) {input.value='';applyFilter();}
    const tile=document.getElementById(id);
    if (!tile) return;
    clearSelected();
    selected=tile;
    tile.classList.add('highlight');
    tile.focus({preventScroll:true});
    tile.scrollIntoView({block:'nearest',inline:'nearest',behavior:'smooth'});
  }
  input?.addEventListener('input', applyFilter);
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      input?.focus();input?.select();
    } else if(event.key === 'Escape') {
      if(input && document.activeElement===input){input.value='';applyFilter();input.blur();}
      clearSelected();
    }
  });
  buttons.forEach(button => button.addEventListener('click', () => focusCard(button.dataset.target)));
  bell?.addEventListener('click', () => focusCard('mod-alertas'));
})();