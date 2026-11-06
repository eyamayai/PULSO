'use strict';
(() => {
  const $=id=>document.getElementById(id);
  let people=new Map(),selected=new Set(),editor=null,validated=false,pending=[],links=[];
  const roleNames={ADMIN:'Administrador',SUPERVISOR:'Supervisor',TECNICO:'Técnico',AUDITOR:'Auditor / Consulta'};
  const errorNames={
    YA_TIENE_ACCESO:'Ya dispone de cuenta vinculada.',
    PERSONAL_INACTIVO:'La ficha de Personal está inactiva.',
    CORREO_REQUERIDO:'Falta un correo válido en Personal.',
    IDENTIFICACION_INVALIDA:'La identificación es inválida.',
    CORREO_REPETIDO_EN_SELECCION:'Correo duplicado entre las fichas seleccionadas.',
    CORREO_YA_TIENE_USUARIO:'El correo ya pertenece a Usuarios y permisos; revisa esa cuenta antes de vincular.',
    DOCUMENTO_YA_TIENE_USUARIO:'La identificación ya pertenece a Usuarios y permisos; revisa esa cuenta antes de vincular.',
    PERSONAL_NO_EXISTE:'La ficha ya no existe.',
    CONFLICTO_VINCULACION:'Otra operación modificó alguno de los registros. Actualiza la página e inténtalo nuevamente.',
    SELECCION_INVALIDA:'La selección contiene identificadores o perfiles inválidos.'
  };
  const eligible=p=>p&&p.is_active===1&&!p.access_user_id&&Boolean(p.email);
  const invalidReasons=p=>!p?.is_active?'Registro inactivo':p.access_user_id?'Ya vinculado':!p.email?'Sin correo':'';
  function updateCount(){
    for(const id of [...selected])if(!eligible(people.get(id)))selected.delete(id);
    const boxes=[...document.querySelectorAll('input[data-person-select]')];
    for(const box of boxes)box.checked=selected.has(box.dataset.personSelect);
    const enabledBoxes=boxes.filter(box=>!box.disabled);
    const all=$('personnel-select-all');
    if(all){
      all.checked=enabledBoxes.length>0&&enabledBoxes.every(box=>box.checked);
      all.indeterminate=enabledBoxes.some(box=>box.checked)&&!all.checked;
      all.disabled=enabledBoxes.length===0;
    }
    $('personnel-selection-count').textContent=String(selected.size);
    const btn=$('personnel-bulk-open');btn.disabled=!selected.size;
  }
  function clearSelections(){selected.clear();updateCount();}
  function editorState(person){
    editor=person;
    const pane=$('personnel-access-panel');
    pane.hidden=!person;
    const linked=Boolean(person?.access_user_id);
    $('personnel-access-create').hidden=linked;
    $('personnel-access-existing').hidden=!linked;
    $('personnel-access-enabled').checked=false;
    $('personnel-access-role-wrap').hidden=true;
    $('personnel-access-submit').disabled=true;
    $('personnel-access-feedback').textContent='';
    if(!person)return;
    $('personnel-access-role').value=person.position==='SUPERVISOR'?'SUPERVISOR':'TECNICO';
    $('personnel-access-state').textContent=linked
      ?person.access_status==='CONFIGURADA'?'Acceso configurado':'Invitación pendiente'
      :person.is_active!==1?'Personal inactivo':'Sin acceso';
    $('personnel-access-description').textContent=linked
      ?'Esta ficha ya tiene una cuenta en Usuarios y permisos.'
      :'La cuenta utilizará su identificación, nombre y correo registrados. Guarda primero cualquier cambio de la ficha.';
    if(!eligible(person)&&!linked){
      $('personnel-access-enabled').disabled=true;
      $('personnel-access-feedback').textContent=invalidReasons(person);
    }else $('personnel-access-enabled').disabled=false;
  }
  function errorText(e){
    if(e?.errors?.length)return e.errors.map(x=>(x.name||'Registro')+': '+(errorNames[x.error]||x.error)).join('\n');
    return errorNames[e?.error]||e?.error||'No fue posible completar la operación.';
  }
  async function request(mode,assignments){
    const response=await fetch('/api/usuarios/vincular-personal',{
      method:'POST',credentials:'same-origin',cache:'no-store',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({mode,assignments})
    });
    if(response.status===401){location.replace('/main');throw new Error('Sesión caducada');}
    if(response.status===403){location.replace('/inicio');throw new Error('No tienes permisos');}
    const payload=await response.json().catch(()=>({error:'RESPUESTA_INVALIDA'}));
    if(!response.ok||!payload.ok||payload.valid===false)throw Object.assign(new Error(errorText(payload)),{details:payload});
    return payload;
  }
  async function create(assignments,mode){
    await request('validate',assignments);
    if(mode==='single'){
      const person=people.get(assignments[0].personnel_id);
      if(!confirm('¿Crear la cuenta de PULSO para '+person.full_name+' con perfil '+roleNames[assignments[0].role]+'?'))return;
    }
    const result=await request('commit',assignments);
    links=result.invitations||[];
    $('record-dialog').close();
    $('personnel-bulk-dialog').close();
    clearSelections();
    window.dispatchEvent(new CustomEvent('pulso:personal-access-created'));
    showInvitations();
  }
  function showInvitations(){
    const list=$('personnel-invites-list');
    list.replaceChildren();
    for(const row of links){
      const item=document.createElement('div');item.className='personnel-invite-item';
      const info=document.createElement('div');
      const name=document.createElement('strong');name.textContent=row.name;
      const caption=document.createElement('small');caption.textContent=row.email+' · '+roleNames[row.role];
      info.append(name,caption);
      const copy=document.createElement('button');copy.type='button';copy.textContent='Copiar enlace';
      copy.addEventListener('click',async()=>{
        try{await navigator.clipboard.writeText(row.link);copy.textContent='Copiado';}
        catch {copy.textContent='No disponible';}
      });
      item.append(info,copy);list.append(item);
    }
    $('personnel-invites-title').textContent=links.length+' invitación'+(links.length===1?'':'es')+' creada'+(links.length===1?'':'s');
    $('personnel-invites-dialog').showModal();
  }
  function csvEscape(value){
    let string=String(value??'');
    if(/^[=+\-@\t\r]/.test(string))string="'"+string;
    return '"'+string.replace(/"/g,'""')+'"';
  }
  function exportCsv(){
    if(!links.length)return;
    const rows=[['Nombre','Correo','Perfil','Enlace personal']];
    for(const row of links)rows.push([row.name,row.email,roleNames[row.role],row.link]);
    const output='\uFEFF'+rows.map(row=>row.map(csvEscape).join(';')).join('\r\n');
    const url=URL.createObjectURL(new Blob([output],{type:'text/csv;charset=utf-8'}));
    const a=document.createElement('a');a.href=url;a.download='PULSO_Invitaciones_Privadas.csv';
    document.body.append(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  async function singleAccess(){
    if(!editor||!eligible(people.get(editor.id)))return;
    const assignment=[{personnel_id:editor.id,role:$('personnel-access-role').value}];
    const button=$('personnel-access-submit');button.disabled=true;
    $('personnel-access-feedback').textContent='';
    try{await create(assignment,'single');}
    catch(e){$('personnel-access-feedback').textContent=e.message||'No se pudo crear el acceso.';}
    finally{button.disabled=false;}
  }
  function assignments(){
    const role=$('personnel-bulk-role').value;
    return [...selected].map(id=>({
      personnel_id:id,
      role:role==='CARGO'?people.get(id).position:role
    }));
  }
  function resetPreview(){
    validated=false;
    $('personnel-bulk-confirm').textContent='Validar selección';
    $('personnel-bulk-errors').replaceChildren();
  }
  function openBatch(){
    pending=assignments();
    if(!pending.length)return;
    $('personnel-bulk-total').textContent=String(pending.length);
    const holder=$('personnel-bulk-preview');holder.replaceChildren();
    for(const x of pending){
      const p=people.get(x.personnel_id);
      const row=document.createElement('p');row.textContent=p.full_name+' · '+p.email;holder.append(row);
    }
    resetPreview();
    $('personnel-bulk-dialog').showModal();
  }
  async function validateOrCommit(){
    const btn=$('personnel-bulk-confirm');btn.disabled=true;
    const message=$('personnel-bulk-errors');message.replaceChildren();
    try{
      const set=assignments();
      if(!validated){
        const outcome=await request('validate',set);
        if(!outcome.valid)throw new Error('La selección contiene errores.');
        validated=true;
        btn.textContent='Crear '+set.length+' accesos';
        message.textContent='Validación correcta. Ninguna cuenta se ha creado todavía.';
        message.style.color='#137950';
      }else{
        if(!confirm('¿Crear '+set.length+' cuentas pendientes de activación en PULSO?'))return;
        await create(set,'bulk');
        pending=[];
      }
    }catch(e){
      message.textContent=e.message||'No se pudo validar.';
      message.style.color='#a33d2f';
      validated=false;
      btn.textContent='Validar selección';
    }finally{btn.disabled=false;}
  }
  function closeInvites(){
    $('personnel-invites-dialog').close();
    links=[];$('personnel-invites-list').replaceChildren();
  }
  window.addEventListener('pulso:personnel-rendered',e=>{
    people=new Map((e.detail.items||[]).map(p=>[p.id,p]));
    updateCount();
  });
  window.addEventListener('pulso:personnel-editor',e=>editorState(e.detail.personnel||null));
  window.addEventListener('pulso:tab-changed',e=>{if(e.detail.tab!=='personal')clearSelections();});
  $('master-table-head').addEventListener('change',e=>{
    if(e.target.id!=='personnel-select-all')return;
    for(const box of document.querySelectorAll('input[data-person-select]')){
      if(box.disabled)continue;
      if(e.target.checked)selected.add(box.dataset.personSelect);else selected.delete(box.dataset.personSelect);
    }
    updateCount();
  });
  $('master-table-body').addEventListener('change',e=>{
    const target=e.target;
    if(!target.matches('input[data-person-select]'))return;
    if(target.checked)selected.add(target.dataset.personSelect);else selected.delete(target.dataset.personSelect);
    updateCount();
  });
  $('personnel-access-enabled').addEventListener('change',e=>{
    $('personnel-access-role-wrap').hidden=!e.target.checked;
    $('personnel-access-submit').disabled=!e.target.checked;
  });
  $('personnel-access-submit').addEventListener('click',()=>{void singleAccess();});
  $('personnel-open-users').addEventListener('click',()=>{
    $('record-dialog').close();
    $('tab-usuarios').click();
  });
  $('personnel-bulk-open').addEventListener('click',openBatch);
  $('personnel-bulk-role').addEventListener('change',resetPreview);
  $('personnel-bulk-confirm').addEventListener('click',()=>{void validateOrCommit();});
  $('personnel-bulk-cancel').addEventListener('click',()=>$('personnel-bulk-dialog').close());
  $('personnel-bulk-x').addEventListener('click',()=>$('personnel-bulk-dialog').close());
  $('personnel-invites-close').addEventListener('click',closeInvites);
  $('personnel-invites-x').addEventListener('click',closeInvites);
  $('personnel-invites-export').addEventListener('click',exportCsv);
  $('personnel-invites-dialog').addEventListener('close',()=>{
    links=[];$('personnel-invites-list').replaceChildren();
  });
})();