'use strict';
(() => {
  const dropdowns = [...document.querySelectorAll('.nav-drop')];
  const alertButton = document.getElementById('notifications-button');
  let highlighted = null;
  document.querySelectorAll('[data-target]').forEach(control => {
    control.addEventListener('click', () => {
      const target = document.getElementById(control.dataset.target);
      if (!target) return;
      highlighted?.classList.remove('focused');
      highlighted = target;
      highlighted.classList.add('focused');
      dropdowns.forEach(d => { d.open = false; });
      target.focus({preventScroll:true});
      target.scrollIntoView({block:'nearest',inline:'nearest',behavior:'smooth'});
    });
  });
  dropdowns.forEach(dropdown => dropdown.addEventListener('toggle', () => {
    if (dropdown.open) dropdowns.forEach(other => {if (other !== dropdown) other.open = false;});
  }));
  document.addEventListener('click', event => {
    if (!event.target.closest('.nav-drop')) dropdowns.forEach(d => { d.open = false; });
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      dropdowns.forEach(d => { d.open = false; });
      highlighted?.classList.remove('focused');
      highlighted = null;
    }
  });
  alertButton?.addEventListener('click', () => {
    document.getElementById('alertas-recientes')?.scrollIntoView({block:'nearest',behavior:'smooth'});
  });
})();
