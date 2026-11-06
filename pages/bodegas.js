'use strict';
(() => {
  const $=id=>document.getElementById(id);
  let rows=[],editing=null,busy=false;
  const messages={
    CENTRO_ALMACEN_DUPLICADO:'La combinación Centro + Almacén ya está registrada.',
    DATOS_BODEGA_INVALIDOS:'Revisa el centro, almacén, descripción, administración, departamento y estado.',
    CLAVE_INMUTABLE:'Centro y Almacén no pueden modificarse después de registrar la bodega.',
    BODEGA_NO_ENCONTRADA:'El registro ya no existe. Actualiza la tabla.',
    SIN_PERMISOS:'Solo el administrador puede modificar esta maestra.',
    ORIGEN_NO_AUTORIZADO:'La solicitud no está autorizada.'
  };
  const departments=[["AMAZONAS","Amazonas"],["ANTIOQUIA","Antioquia"],["ARAUCA","Arauca"],["ATLANTICO","Atlántico"],["BOLIVAR","Bolívar"],["BOYACA","Boyacá"],["CALDAS","Caldas"],["CAQUETA","Caquetá"],["CASANARE","Casanare"],["CAUCA","Cauca"],["CESAR","Cesar"],["CHOCO","Chocó"],["CORDOBA","Córdoba"],["CUNDINAMARCA","Cundinamarca"],["GUAINIA","Guainía"],["GUAVIARE","Guaviare"],["HUILA","Huila"],["LA GUAJIRA","La Guajira"],["MAGDALENA","Magdalena"],["META","Meta"],["NARINO","Nariño"],["NORTE DE SANTANDER","Norte de Santander"],["PUTUMAYO","Putumayo"],["QUINDIO","Quindío"],["RISARALDA","Risaralda"],["SAN ANDRES","San Andrés"],["SANTANDER","Santander"],["SUCRE","Sucre"],["TOLIMA","Tolima"],["VALLE DEL CAUCA","Valle del Cauca"],["VAUPES","Vaupés"],["VICHADA","Vichada"],["BOGOTA D.C.","Bogotá D. C."]];
  const ownDepartments=new Set(['CESAR','LA GUAJIRA','SAN ANDRES']);
  const labelDepartment=Object.fromEntries(departments);
  function departmentOptions(){
    const field=$('warehouse-department');
    const selected=field.value;
    const onlyOwn=$('warehouse-administration').value==='PROPIA';
    field.replaceChildren(new Option('Seleccione...',''));
    for(const [code,title] of departments){
      if(!onlyOwn||ownDepartments.has(code))field.add(new Option(title,code));
    }
    field.value=[...field.options].some(o=>o.value===selected)?selected:'';
  }
  function notice(message,error=false){
    const el=$('master-message');el.hidden=!message;el.textContent=message||'';el.classList.toggle('error',error);
  }
  function fieldError(message){
    const el=$('warehouse-error');el.textContent=message||'';el.hidden=!message;
  }
  async function api(method='GET',payload=null){
    const response=await fetch('/api/maestras/bodegas',{
      method,cache:'no-store',credentials:'same-origin',
      ...(payload?{headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}:{})
    });
    const data=await response.json().catch(()=>({ok:false,error:'RESPUESTA_INVALIDA'}));
    if(response.status===401){location.replace('/main');throw new Error('Sesión caducada');}
    if(response.status===403){location.replace('/inicio');throw new Error('Sin permisos');}
    if(!response.ok||!data.ok)
      throw new Error(messages[data.error]||'No fue posible completar la operación ('+(data.error||response.status)+').');
    return data;
  }
  const normalize=text=>String(text||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
  const badge=(value,className='')=>{
    const span=document.createElement('span');span.className='warehouse-badge '+className;span.textContent=value;return span;
  };
  const td=(row,value,sub='')=>{
    const cell=document.createElement('td');
    if(value instanceof Node)cell.append(value);
    else{
      const strong=document.createElement('strong');strong.textContent=String(value??'');cell.append(strong);
    }
    if(sub){const description=document.createElement('span');description.className='cell-sub';description.textContent=sub;cell.append(description);}
    row.append(cell);
    return cell;
  };
  const button=(label,onClick,cls='')=>{
    const element=document.createElement('button');element.type='button';
    element.textContent=label;element.className=cls;element.addEventListener('click',onClick);
    return element;
  };
  function render(){
    const tbody=$('warehouse-table');tbody.replaceChildren();
    const query=normalize($('warehouse-search').value);
    const admin=$('warehouse-admin-filter').value;
    const status=$('warehouse-status-filter').value;
    const visible=rows.filter(r=>(!admin||r.administration===admin)&&
      (status===''||r.is_active===Number(status))&&
      (!query||normalize([r.centro,r.almacen,r.description,r.department,r.administration].join(' ')).includes(query)));
    for(const item of visible){
      const tr=document.createElement('tr');
      td(tr,item.centro);td(tr,item.almacen);td(tr,item.description);
      td(tr,badge(item.administration,item.administration==='ALIADO'?'ally':''));
      td(tr,labelDepartment[item.department]||item.department);
      td(tr,badge(item.is_active===1?'ACTIVA':'INACTIVA',item.is_active===1?'':'inactive'));
      const controls=document.createElement('div');controls.className='warehouse-actions';
      controls.append(button('Editar',()=>open(item)));
      controls.append(button(item.is_active===1?'Desactivar':'Activar',()=>toggle(item),
        item.is_active===1?'deactivate':''));
      td(tr,controls);tbody.append(tr);
    }
    $('warehouse-empty').hidden=visible.length>0;
    $('warehouse-results-count').textContent=visible.length+' registro'+(visible.length===1?'':'s');
    $('bodegas-count').textContent=rows.length;
  }
  async function refresh(){
    try{const list=await api();rows=list.items||[];render();}
    catch(error){notice(error.message,true);}
  }
  function open(item=null){
    editing=item;
    $('warehouse-form').reset();
    $('warehouse-id').value=item?.id||'';
    $('warehouse-centro').value=item?.centro||'';
    $('warehouse-almacen').value=item?.almacen||'';
    $('warehouse-description').value=item?.description||'';
    $('warehouse-administration').value=item?.administration||'PROPIA';
    departmentOptions();
    $('warehouse-department').value=item?.department||'';
    $('warehouse-active').checked=item?item.is_active===1:true;
    $('warehouse-centro').readOnly=Boolean(item);
    $('warehouse-almacen').readOnly=Boolean(item);
    $('warehouse-form-label').textContent=item?'EDITAR REGISTRO':'NUEVO REGISTRO';
    $('warehouse-form-title').textContent='Bodegas y Aliados';
    fieldError('');
    $('warehouse-dialog').showModal();
  }
  function formData(){
    return {
      centro:$('warehouse-centro').value.trim(),
      almacen:$('warehouse-almacen').value.trim(),
      description:$('warehouse-description').value.trim(),
      administration:$('warehouse-administration').value,
      department:$('warehouse-department').value,
      is_active:$('warehouse-active').checked
    };
  }
  async function save(event){
    event.preventDefault();if(busy)return;
    const payload=formData();
    if(editing)payload.id=editing.id;
    busy=true;$('warehouse-save').disabled=true;fieldError('');
    try{
      await api(editing?'PATCH':'POST',payload);
      $('warehouse-dialog').close();
      await refresh();
      notice(editing?'Bodega actualizada.':'Bodega registrada.');
    }catch(e){fieldError(e.message);}
    finally{busy=false;$('warehouse-save').disabled=false;}
  }
  async function toggle(item){
    const next=item.is_active!==1;
    if(!confirm('¿'+(next?'Activar':'Desactivar')+' el almacén '+item.centro+' / '+item.almacen+'?'))return;
    try{
      await api('PATCH',{id:item.id,is_active:next});
      await refresh();notice('Estado actualizado.');
    }catch(e){notice(e.message,true);}
  }
  window.addEventListener('pulso:tab-changed',event=>{
    if(event.detail.tab==='bodegas'){notice('');void refresh();}
  });
  window.addEventListener('pulso:maestras-imported',event=>{
    if(event.detail.kind==='BODEGAS'){void refresh();}
  });
  $('warehouse-search').addEventListener('input',render);
  $('warehouse-admin-filter').addEventListener('change',render);
  $('warehouse-status-filter').addEventListener('change',render);
  $('warehouse-administration').addEventListener('change',departmentOptions);
  departmentOptions();
  $('warehouse-new').addEventListener('click',()=>open());
  $('warehouse-form').addEventListener('submit',save);
  $('warehouse-close').addEventListener('click',()=>$('warehouse-dialog').close());
  $('warehouse-cancel').addEventListener('click',()=>$('warehouse-dialog').close());
  // Precargar el total de bodegas, aunque esta pestaña no esté seleccionada.
  void refresh();
})();