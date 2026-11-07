'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const types = {
    personal:{title:'Personal',url:'/api/maestras/personal'},
    catalogo:{title:'Equipos y materiales',url:'/api/maestras/catalogo'}
  };
  const lists={personal:[],catalogo:[]};
  let tab='personal';
  let editing=null;
  const setText=(id,value)=>{const e=$(id);if(e)e.textContent=String(value??'');};
  const normalize=t=>String(t||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  function message(text,error=false){
    const el=$('master-message');el.hidden=!text;
    el.classList.toggle('error',error);
    el.textContent=text||'';
  }
  function dialogError(text){
    const el=$('dialog-error');el.hidden=!text;el.textContent=text||'';
  }
  async function api(url,opts){
    const res=await fetch(url,{cache:'no-store',credentials:'same-origin',...opts});
    const data=await res.json().catch(()=>({ok:false,error:'RESPUESTA_INVALIDA'}));
    if(res.status===401){location.replace('/main');throw new Error('Sesión caducada');}
    if(res.status===403){location.replace('/inicio');throw new Error('Sin permisos');}
    if(!res.ok||!data.ok)throw new Error(mapError(data.error));
    return data;
  }
  function mapError(code){
    const messages={
      IDENTIFICACION_DUPLICADA:'Esta identificación ya está registrada.',
      SAP_DUPLICADO:'Este código SAP ya existe en la maestra.',
      SUPERVISOR_NO_VALIDO:'Debes seleccionar un supervisor activo.',
      SUPERVISOR_CON_TECNICOS_ACTIVOS:'Este supervisor tiene técnicos activos asignados. Reasígnalos antes de desactivarlo.',
      DATOS_INVALIDOS:'Revisa los datos obligatorios y sus formatos.',
      REFERENCIA_NO_VALIDA:'El registro está relacionado con información no válida.',
      CLAVE_INMUTABLE:'No se puede cambiar la identificación, el cargo o el SAP de un registro creado.',
      SIN_PERMISOS:'No tienes permisos para administrar estas maestras.'
    };
    return messages[code]||'No se pudo completar la operación. Intenta nuevamente.';
  }
  async function refresh(){
    try{
      const [people,catalog]=await Promise.all([api(types.personal.url),api(types.catalogo.url)]);
      lists.personal=people.items||[];
      lists.catalogo=catalog.items||[];
      setText('personal-count',lists.personal.length);
      setText('catalogo-count',lists.catalogo.length);
      render();
    }catch(e){message(e.message,true);}
  }
  function pill(value,category=''){
    const el=document.createElement('span');el.className='pill '+category;el.textContent=value;return el;
  }
  function cell(row,content,secondary){
    const td=document.createElement('td');
    if(content instanceof Node)td.append(content);
    else {const s=document.createElement('strong');s.textContent=String(content??'');td.append(s);}
    if(secondary){const sub=document.createElement('span');sub.className='cell-sub';sub.textContent=secondary;td.append(sub);}
    row.append(td);
  }
  function actionButton(text,callback,cls=''){
    const b=document.createElement('button');b.type='button';b.textContent=text;b.className=cls;b.addEventListener('click',callback);return b;
  }
  function render(){
    if(tab==='usuarios'||tab==='bodegas')return;
    const head=$('master-table-head'),body=$('master-table-body'),empty=$('master-empty');
    const personal=tab==='personal';
    head.replaceChildren();body.replaceChildren();
    const titles=personal
      ?['Seleccionar','Identificación','Nombre','Cargo','Departamento','Zona / ciudad','Supervisor','Acceso PULSO','Estado','Acciones']
      :['Código SAP','Descripción','Tipo','Perfil','Unidad','Familia','Valor del equipo (COP)','Estado','Acciones'];
    const tr=document.createElement('tr');
    for(const h of titles){
      const th=document.createElement('th');
      if(h==='Seleccionar'&&personal){
        const check=document.createElement('input');
        check.type='checkbox';check.id='personnel-select-all';
        check.setAttribute('aria-label','Seleccionar todos los colaboradores visibles con acceso disponible');
        th.append(check);
      }else th.textContent=h;
      tr.append(th);
    }
    head.append(tr);
    const q=normalize($('master-filter').value.trim());
    const filter=$('type-filter').value;
    const rows=lists[tab].filter(o=>(!filter||(personal?o.position:o.item_type)===filter) &&
      (!q||normalize(Object.values(o).join(' ')).includes(q)));
    for(const item of rows){
      const row=document.createElement('tr');
      if(personal){
        const selectionCell=document.createElement('td');
        const choice=document.createElement('input');
        choice.type='checkbox';
        choice.dataset.personSelect=item.id;
        choice.title=item.access_user_id?'Ya tiene acceso':!item.is_active?'El registro está inactivo':!item.email?'Registra primero su correo':'Seleccionar para habilitar acceso';
        choice.setAttribute('aria-label','Seleccionar acceso para '+item.full_name);
        choice.disabled=Boolean(item.access_user_id)||item.is_active!==1||!item.email;
        selectionCell.append(choice);
        row.append(selectionCell);
        cell(row,item.document_number);
        cell(row,item.full_name,item.email);
        cell(row,pill(item.position==='TECNICO'?'Técnico':'Supervisor',item.position==='TECNICO'?'tec':''));
        cell(row,item.department);
        cell(row,item.position==='TECNICO'?item.city_base:item.zone);
        cell(row,item.supervisor_name||'—');
      } else{
        cell(row,item.sap_code);
        cell(row,item.description);
        cell(row,pill(item.item_type==='EQUIPO'?'Equipo':'Material'));
        cell(row,item.serial_profile);
        cell(row,item.unit);
        cell(row,item.family||'—');
        cell(row,item.unit_value_cents===null||item.unit_value_cents===undefined?'Sin valor':
          new Intl.NumberFormat('es-CO',{style:'currency',currency:'COP',minimumFractionDigits:2,maximumFractionDigits:2}).format(item.unit_value_cents/100));
      }
      if(personal){
        const status=item.access_user_id
          ? (item.access_status==='CONFIGURADA'?'Acceso activo':item.access_status==='INVITADO'?'Invitación pendiente':'Cuenta vinculada')
          : 'Sin acceso';
        cell(row,pill(status,item.access_user_id?'':'inactive'));
      }
      cell(row,pill(item.is_active===1?'Activo':'Inactivo',item.is_active!==1?'inactive':''));
      const controls=document.createElement('div');controls.className='row-actions';
      controls.append(actionButton('Editar',()=>openEditor(item)));
      controls.append(actionButton(item.is_active===1?'Desactivar':'Activar',()=>changeStatus(item), 'change-state'));
      cell(row,controls);
      body.append(row);
    }
    empty.hidden=rows.length>0;
    setText('visible-count',rows.length+' registro'+(rows.length===1?'':'s'));
    if(personal)window.dispatchEvent(new CustomEvent('pulso:personnel-rendered',{detail:{items:lists.personal}}));
  }
  function setTab(next){
    tab=next;
    document.querySelectorAll('.master-tab').forEach(b=>{
      const active=b.dataset.tab===tab;
      b.classList.toggle('active',active);b.setAttribute('aria-selected',String(active));
    });
    const users=tab==='usuarios';
    const warehouses=tab==='bodegas';
    const custom=users||warehouses;
    $('master-toolbar').hidden=custom;
    $('master-table-scroll').hidden=custom;
    $('users-view').hidden=!users;
    $('warehouses-view').hidden=!warehouses;
    $('new-record').hidden=custom;
    $('bulk-open').hidden=users;
    $('personnel-bulk-open').hidden=next!=='personal';
    $('user-new').hidden=!users;
    $('warehouse-new').hidden=!warehouses;
    if(!custom){
      const typeFilter=$('type-filter');
      typeFilter.replaceChildren(new Option('Todos',''));
      for(const [value,label] of (tab==='personal'?[['SUPERVISOR','Supervisores'],['TECNICO','Técnicos']]:[['EQUIPO','Equipos'],['MATERIAL','Materiales']])) {
        typeFilter.add(new Option(label,value));
      }
      $('master-filter').value='';
      render();
    }
    window.dispatchEvent(new CustomEvent('pulso:tab-changed',{detail:{tab}}));
  }
  function showPersonFields(){
    const isTech=$('person-type').value==='TECNICO';
    $('zone-field').hidden=isTech;
    $('city-field').hidden=!isTech;
    $('supervisor-field').hidden=!isTech;
    $('person-zone').required=!isTech;
    $('person-city').required=isTech;
    $('person-supervisor').required=isTech;
  }
  function supervisorOptions(value=''){
    const select=$('person-supervisor');
    select.replaceChildren(new Option('Seleccione un supervisor...',''));
    for(const o of lists.personal.filter(o=>o.position==='SUPERVISOR'&&o.is_active===1)){
      select.add(new Option(o.full_name+' · '+o.document_number,o.id));
    }
    select.value=value;
  }
  function openEditor(item=null){
    editing=item;
    $('record-form').reset();
    $('record-id').value=item?.id||'';
    $('personal-fields').hidden=tab!=='personal';
    $('personal-fields').disabled=tab!=='personal';
    $('catalog-fields').hidden=tab!=='catalogo';
    $('catalog-fields').disabled=tab!=='catalogo';
    setText('dialog-title',types[tab].title);
    setText('dialog-label',item?'EDITAR REGISTRO':'NUEVO REGISTRO');
    $('record-active').checked=item?item.is_active===1:true;
    if(tab==='personal'){
      $('person-type').value=item?.position||'SUPERVISOR';
      $('person-type').disabled=Boolean(item);
      $('person-document').value=item?.document_number||'';
      $('person-document').readOnly=Boolean(item);
      $('person-name').value=item?.full_name||'';
      $('person-department').value=item?.department||'';
      $('person-zone').value=item?.zone||'';
      $('person-city').value=item?.city_base||'';
      $('person-email').value=item?.email||'';
      $('person-phone').value=item?.phone||'';
      supervisorOptions(item?.supervisor_id||'');
      showPersonFields();
    } else {
      $('sap-code').value=item?.sap_code||'';
      $('sap-code').readOnly=Boolean(item);
      $('sap-description').value=item?.description||'';
      $('sap-type').value=item?.item_type||'EQUIPO';
      $('sap-profile').value=item?.serial_profile||'CON PERFIL DE SERIE';
      $('sap-unit').value=item?.unit||'UND';
      $('sap-family').value=item?.family||'';
      $('sap-value').value=item?.unit_value_cents===null||item?.unit_value_cents===undefined?'':(item.unit_value_cents/100).toFixed(2);
    }
    dialogError('');
    $('record-dialog').showModal();
    window.dispatchEvent(new CustomEvent('pulso:personnel-editor',{detail:{personnel:tab==='personal'?item:null}}));
  }
  const val=id=>$(id).value.trim();
  async function save(event){
    event.preventDefault();
    const data=tab==='personal'?{
      position:val('person-type'),
      document_number:val('person-document'),full_name:val('person-name'),
      department:val('person-department'),zone:val('person-zone'),
      city_base:val('person-city'),supervisor_id:val('person-supervisor'),
      email:val('person-email'),phone:val('person-phone'),
      is_active:$('record-active').checked
    }:{
      sap_code:val('sap-code'),description:val('sap-description'),
      item_type:val('sap-type'),serial_profile:val('sap-profile'),
      unit:val('sap-unit'),family:val('sap-family'),unit_value:val('sap-value'),
      is_active:$('record-active').checked
    };
    if(editing)data.id=editing.id;
    const button=$('dialog-save');button.disabled=true;
    try{
      await api(types[tab].url,{method:editing?'PATCH':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
      $('record-dialog').close();
      await refresh();
      message(editing?'Registro actualizado.':'Registro creado.');
    }catch(err){dialogError(err.message);}
    finally{button.disabled=false;}
  }
  async function changeStatus(item){
    const active=item.is_active!==1;
    const label=tab==='personal'?item.full_name:item.sap_code;
    const operation=active?'activar':'desactivar';
    if(!confirm('¿Deseas '+operation+' el registro '+label+'?'))return;
    try{
      await api(types[tab].url,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:item.id,is_active:active})});
      await refresh();message('Estado actualizado.');
    }catch(err){message(err.message,true);}
  }
  document.querySelectorAll('.master-tab').forEach(button=>button.addEventListener('click',()=>setTab(button.dataset.tab)));
  $('type-filter').addEventListener('change',render);
  $('master-filter').addEventListener('input',render);
  $('new-record').addEventListener('click',()=>openEditor());
  $('person-type').addEventListener('change',showPersonFields);
  $('dialog-close').addEventListener('click',()=>$('record-dialog').close());
  $('dialog-cancel').addEventListener('click',()=>$('record-dialog').close());
  $('record-form').addEventListener('submit',save);
  $('record-dialog').addEventListener('close',()=>dialogError(''));
  window.addEventListener('pulso:personal-access-created',async()=>{
    await refresh();
    message('Accesos creados. Las cuentas ya aparecen en Usuarios y permisos.');
  });
  window.addEventListener('pulso:maestras-imported',async e=>{
    setTab(e.detail.kind==='BODEGAS'?'bodegas':e.detail.kind==='CATALOGO'?'catalogo':'personal');
    await refresh();
    message('Carga completada: '+(e.detail.inserted??e.detail.count??0)+' nuevos, '+(e.detail.updated??0)+' valores actualizados, '+(e.detail.unchanged??0)+' sin cambios.');
  });
  setTab('personal');
  void refresh();
})();
