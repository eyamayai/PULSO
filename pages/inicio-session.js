'use strict';
const userLabel=document.getElementById('session-user');
const logoutButton=document.getElementById('logout-btn');
async function session(){
  try{
    const r=await fetch('/api/auth/me',{cache:'no-store',credentials:'same-origin'});
    if(!r.ok){window.location.replace('/main');return;}
    const result=await r.json();
    if(!result.ok || !result.user){window.location.replace('/main');return;}
    if(userLabel)userLabel.textContent=result.user.name || result.user.email;
    if(logoutButton)logoutButton.hidden=false;
  }catch{window.location.replace('/main');}
}
logoutButton?.addEventListener('click',async()=>{
  logoutButton.disabled=true;
  try{await fetch('/api/auth/logout',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:'{}'});}finally{window.location.replace('/main');}
});
void session();


// Determina el único módulo activo a partir de la URL real de cada pantalla.
(() => {
  const route = pathname => pathname.replace(/\/+$/, '').replace(/\.html$/, '') || '/inicio';
  const activePath = route(window.location.pathname);
  document.querySelectorAll('.side-nav a.side-link').forEach(link => {
    const selected = route(new URL(link.href, window.location.href).pathname) === activePath;
    link.classList.toggle('current', selected);
    if (selected) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
})();
