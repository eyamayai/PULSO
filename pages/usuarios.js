'use strict';
(() => {
  const $=id=>document.getElementById(id);
  const label={ADMIN:'Administrador',SUPERVISOR:'Supervisor',TECNICO:'Técnico',AUDITOR:'Auditor / Consulta'};
  let items=[],selfId='',editing=null,busy=false;
  const normal=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  const setText=(id,value)=>{$(id).textContent=String(value??'');};
  function formError(message){const e=$('user-form-error');e.textContent=message||'';e.hidden=!message;}
  const messages={
    USUARIO_O_IDENTIFICACION_DUPLICADA:'El correo o la identificación ya están registrados.',
    IDENTIFICACION_DUPLICADA:'La identificación ya pertenece a otra cuenta.',
    NO_MODIFICAR_AUTOPERMISOS:'No puedes cambiar tu propio perfil o desactivar tu cuenta.',
    ULTIMO_ADMINISTRADOR:'Debe permanecer al menos una cuenta administradora activa.',
    CUENTA_SIN_CLAVE:'La cuenta debe aceptar su invitación antes de habilitarla.',
    USUARIO_INACTIVO:'La cuenta está inactiva. Actívala antes de restablecer la contraseña.',
    DATOS_INVALIDOS:'Revisa los campos, el perfil y los formatos ingresados.',
    SIN_PERMISOS:'No tienes permisos para gestionar usuarios.'
  };
  async function api(path,opts={}){
    const r=await fetch(path,{credentials:'same-origin',cache:'no-store',...opts});
    const data=await r.json().catch(()=>({ok:false,error:'RESPUESTA_INVALIDA'}));
    if(r.status===401){location.replace('/main');throw new Error('Sesión caducada');}
    if(r.status===403){location.replace('/inicio');throw new Error('Sin permisos');}
    if(!r.ok||!data.ok)throw new Error(messages[data.error]||'No fue posible realizar la operación ('+(data.error||r.status)+').');
    return data;
  }
  async function reload(){
    try{
      const data=await api('/api/usuarios');
      items=data.items||[];selfId=data.current_user_id||'';
      setText('usuarios-count',items.length);
      render();
    }catch(e){status(e.message,true);}
  }
  function status(msg,error=false){
    const el=$('master-message');
    el.textContent=msg||'';el.hidden=!msg;el.classList.toggle('error',error);
  }
  const td=(r,value,subtitle)=>{
    const cell=document.createElement('td');
    const strong=document.createElement('strong');strong.textContent=String(value??'—');cell.append(strong);
    if(subtitle){const sub=document.createElement('span');sub.className='cell-sub';sub.textContent=subtitle;cell.append(sub);}
    r.append(cell);return cell;
  };
  const btn=(name,cb,opts={})=>{
    const b=document.createElement('button');
    b.type='button';b.textContent=name;
    if(opts.className)b.className=opts.className;
    if(opts.disabled)b.disabled=true;
    b.addEventListener('click',cb);return b;
  };
  const pill=(text,className)=>{
    const el=document.createElement('span');el.className='pill '+(className||'');el.textContent=text;return el;
  };
  function render(){
    const tbody=$('user-table');tbody.replaceChildren();
    const q=normal($('user-search').value);
    const filter=$('user-role-filter').value;
    const visible=items.filter(x=>(!filter||x.role===filter)&&
      (!q||normal([x.email,x.display_name,x.document_number,x.job_title].join(' ')).includes(q)));
    for(const x of visible){
      const r=document.createElement('tr');
      td(r,x.document_number||'—');
      td(r,x.display_name,x.job_title||'');
      td(r,x.email);
      td(r,label[x.role]||x.role);
      const cred=document.createElement('td');
      cred.append(pill(x.credential_status==='CONFIGURADA'?'Contraseña activa':
        x.credential_status==='INVITADO'?'Invitación pendiente':'Sin contraseña',
        x.credential_status==='CONFIGURADA'?'active-user':'pending'));
      r.append(cred);
      const active=document.createElement('td');active.append(pill(x.active===1?'Activo':'Pendiente / Inactivo',
        x.active===1?'active-user':'disabled-user'));r.append(active);
      const actions=document.createElement('div');actions.className='user-action-buttons';
      actions.append(btn('Editar',()=>openEditor(x)));
      actions.append(btn(x.credential_status==='CONFIGURADA'?'Restablecer clave':'Invitar',()=>invite(x)));
      if(x.credential_status==='CONFIGURADA'){
        actions.append(btn(x.active===1?'Desactivar':'Activar',()=>toggle(x),{
          className:'danger',disabled:x.id===selfId
        }));
      }
      const actionCell=document.createElement('td');actionCell.append(actions);r.append(actionCell);
      tbody.append(r);
    }
    $('user-empty').hidden=visible.length>0;
    setText('user-results-count',visible.length+' usuario'+(visible.length===1?'':'s'));
  }
  function openEditor(item=null){
    editing=item;
    $('user-form').reset();formError('');
    setText('user-dialog-label',item?'EDITAR CUENTA':'NUEVA CUENTA');
    setText('user-title',item?'Editar usuario':'Nuevo usuario');
    $('user-id').value=item?.id||'';
    $('user-document').value=item?.document_number||'';
    $('user-document').required=!item;
    $('user-name').value=item?.display_name||'';
    $('user-email').value=item?.email||'';
    $('user-email').readOnly=!!item;
    $('user-role').value=item?.role||'AUDITOR';
    $('user-role').disabled=!!item&&item.id===selfId;
    $('user-title-job').value=item?.job_title||'';
    $('user-phone').value=item?.phone||'';
    $('user-active-wrap').hidden=!item;
    $('user-active').checked=item?.active===1;
    $('user-active').disabled=!!item&&(item.id===selfId||item.credential_status!=='CONFIGURADA');
    $('user-dialog').showModal();
  }
  function showLink(value){
    $('user-invite-link').value=value;
    setText('user-copy-feedback','');
    $('user-invite-dialog').showModal();
  }
  async function save(event){
    event.preventDefault();if(busy)return;
    const isNew=!editing;
    const data={
      display_name:$('user-name').value.trim(),
      document_number:$('user-document').value.trim(),
      role:$('user-role').value,
      job_title:$('user-title-job').value.trim(),
      phone:$('user-phone').value.trim()
    };
    if(isNew)data.email=$('user-email').value.trim();
    else {
      data.id=editing.id;
      if(!($('user-active').disabled))data.active=$('user-active').checked;
    }
    busy=true;$('user-save').disabled=true;formError('');
    try{
      const result=await api('/api/usuarios',{
        method:isNew?'POST':'PATCH',
        headers:{'Content-Type':'application/json'},body:JSON.stringify(data)
      });
      $('user-dialog').close();
      await reload();
      status(isNew?'Usuario registrado. Comparte su enlace de activación.':'Datos de usuario actualizados.');
      if(isNew)showLink(result.link);
    }catch(e){formError(e.message);}
    finally{busy=false;$('user-save').disabled=false;}
  }
  async function invite(x){
    const hasPass=x.credential_status==='CONFIGURADA';
    if(hasPass&&!confirm('Se generará un enlace para restablecer la contraseña de '+x.display_name+'. El enlace anterior dejará de funcionar. ¿Continuar?'))return;
    try{
      const response=await api('/api/usuarios/invitaciones',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({id:x.id})
      });
      await reload();
      showLink(response.link);
    }catch(e){status(e.message,true);}
  }
  async function toggle(x){
    if(x.id===selfId)return;
    const next=x.active!==1;
    if(!confirm('¿Deseas '+(next?'activar':'desactivar')+' el acceso de '+x.display_name+'?'))return;
    try{
      await api('/api/usuarios',{
        method:'PATCH',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({id:x.id,active:next})
      });
      await reload();
      status('Estado del usuario actualizado. Las sesiones anteriores quedaron invalidadas.');
    }catch(e){status(e.message,true);}
  }
  async function copyLink(){
    const value=$('user-invite-link').value;
    try{
      await navigator.clipboard.writeText(value);
      setText('user-copy-feedback','Enlace copiado. Compártelo de manera privada.');
    }catch{
      $('user-invite-link').focus();$('user-invite-link').select();
      setText('user-copy-feedback','Selecciona y copia el enlace con Ctrl + C.');
    }
  }
  const closeLink=()=>{
    $('user-invite-dialog').close();$('user-invite-link').value='';
    setText('user-copy-feedback','');
  };
  window.addEventListener('pulso:tab-changed',event=>{
    if(event.detail.tab==='usuarios'){
      $('master-message').hidden=true;
      void reload();
    }
  });
  $('user-search').addEventListener('input',render);
  $('user-role-filter').addEventListener('change',render);
  $('user-new').addEventListener('click',()=>openEditor());
  $('user-form').addEventListener('submit',save);
  $('user-dialog-x').addEventListener('click',()=>$('user-dialog').close());
  $('user-cancel').addEventListener('click',()=>$('user-dialog').close());
  $('user-invite-x').addEventListener('click',closeLink);
  $('user-invite-close').addEventListener('click',closeLink);
  $('user-copy').addEventListener('click',()=>{void copyLink();});
  $('user-invite-dialog').addEventListener('close',()=>{
    $('user-invite-link').value='';setText('user-copy-feedback','');
  });
})();