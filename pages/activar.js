'use strict';
(() => {
  const token=location.hash.slice(1);
  // El fragmento secreto no debe conservarse en la barra de direcciones.
  history.replaceState(null,'',location.pathname);
  const $=id=>document.getElementById(id);
  const form=$('activation-form'),status=$('activation-status');
  function fail(message){status.textContent=message;status.hidden=false;}
  if(!/^[A-Za-z0-9_-]{43}$/.test(token)){
    fail('El enlace no es válido o está incompleto. Solicita una nueva invitación al administrador.');
    $('activation-submit').disabled=true;
    return;
  }
  form.addEventListener('submit',async event=>{
    event.preventDefault();status.hidden=true;
    const email=$('activation-email').value.trim();
    const password=$('activation-password').value;
    const confirm=$('activation-confirm').value;
    if(password!==confirm){fail('Las contraseñas no coinciden.');return;}
    if(password.length<14||password.length>128||
       !/[A-Z]/.test(password)||!/[a-z]/.test(password)||!/[0-9]/.test(password)||
       !/[^A-Za-z0-9]/.test(password)){
      fail('Usa al menos 14 caracteres, con mayúscula, minúscula, número y símbolo.');return;
    }
    const button=$('activation-submit');button.disabled=true;
    try{
      const res=await fetch('/api/auth/activar',{
        method:'POST',credentials:'same-origin',cache:'no-store',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({token,email,password})
      });
      const body=await res.json().catch(()=>({}));
      if(!res.ok||!body.ok){
        fail(body.error==='INVITACION_NO_VALIDA'
          ?'El enlace ya se utilizó, venció o no corresponde al correo indicado. Solicita una nueva invitación.'
          :'No se pudo activar la cuenta. Revisa tus datos e inténtalo de nuevo.');
        return;
      }
      form.hidden=true;
      $('activation-done').hidden=false;
    }catch{fail('No se pudo conectar. Reintenta cuando tengas conexión.');}
    finally{button.disabled=false;}
  });
})();