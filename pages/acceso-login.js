'use strict';
const form=document.querySelector('.login-form');
const email=document.getElementById('login-email');
const password=document.getElementById('login-password');
const button=form?.querySelector('.sign-in');
const message=document.getElementById('login-status');
const update=(text='',error=true)=>{if(message){message.textContent=text;message.dataset.error=error?'true':'false';}};
if(form && email && password && button){
  form.addEventListener('submit',async event=>{
    event.preventDefault();
    update('');
    if(!form.reportValidity())return;
    button.disabled=true;
    button.textContent='Validando acceso…';
    try{
      const response=await fetch('/api/auth/login',{
        method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({email:email.value.trim(),password:password.value})
      });
      const body=await response.json().catch(()=>({}));
      if(response.ok&&body.ok&&body.redirect==='/inicio'){
        password.value='';
        window.location.replace('/inicio');
        return;
      }
      if(response.status===429)update('Demasiados intentos. Inténtalo nuevamente en 15 minutos.');
      else if(response.status===503)update('El servicio de acceso no está disponible.');
      else update('Correo o contraseña incorrectos.');
      password.value='';
      password.focus();
    }catch{
      update('No se pudo establecer conexión. Vuelve a intentarlo.');
    }finally{button.disabled=false;button.textContent='Iniciar sesión';}
  });
}