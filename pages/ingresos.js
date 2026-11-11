'use strict';
(() => {
  const $=id=>document.getElementById(id);
  // Los tipos anteriores se conservan únicamente para visualizar el historial.
  const DOC_TYPES={SALDO_INICIAL:'Saldo inicial',NUMERO_PEDIDO:'Número de Pedido',ORDEN_COMPRA:'Orden de compra',FACTURA:'Factura',REMISION:'Remisión',ACTA_ENTREGA:'Acta de entrega',OTRO:'Otro'};
  let catalog=[],warehouse=[],bySap=new Map(),byWarehouse=new Map(),list=[];
  let id='',status='BORRADOR',step=1,items=[],support={size:0,filename:''},validation=null,dirty=false,busy=false;
  let editingIndex=null,editingDraft=null,editingNew=false;
  const text=(id,value)=>{$(id).textContent=String(value??'');};
  const elt=(tag,value,cls)=>{const x=document.createElement(tag);if(value!==undefined)x.textContent=String(value);if(cls)x.className=cls;return x;};
  const n=v=>String(v??'').trim().toUpperCase();
  const safe=v=>String(v??'').trim();
  const showMessage=(message,error=false)=>{
    const el=$('ingress-message');el.textContent=message||'';el.hidden=!message;el.classList.toggle('error',error);
  };
  function problem(code){
    const messages={
      NO_AUTENTICADO:'Sesión caducada.',SIN_PERMISOS:'No tienes permisos para registrar ingresos.',
      ORIGEN_NO_AUTORIZADO:'La solicitud no está autorizada.',
      DATOS_INVALIDOS:'Revisa los campos del documento y los ítems.',
      VALIDACION_BLOQUEANTE:'Existen errores bloqueantes. Corrígelos antes de registrar.',
      INGRESO_YA_REGISTRADO:'El ingreso ya quedó registrado. Actualiza el listado.',
      INGRESO_INMUTABLE:'Un ingreso registrado no puede editarse.',
      REVALIDAR_INGRESO:'La validación cambió. Revisa de nuevo los seriales, SAP y bodegas.',
      NO_SE_PUDO_GUARDAR:'No fue posible guardar el borrador.',
      PDF_DEMASIADO_GRANDE:'El PDF no puede superar 5 MB.',
      PDF_INVALIDO:'El archivo no es un PDF válido.',
      PDF_NO_GUARDADO:'No fue posible adjuntar el PDF.',
      INGRESO_NO_ENCONTRADO:'No se encontró el ingreso.',
      SERVICIO_TEMPORALMENTE_NO_DISPONIBLE:'No se pudo conectar con el servicio.'
    };
    return messages[code]||code||'No se pudo completar la operación.';
  }
  function showListMessage(message,error=false){
    const alert=$('ingress-list-message');
    alert.textContent=message||'';
    alert.hidden=!message;
    alert.classList.toggle('error',error);
  }
  async function api(path,{method='GET',data=null,raw=null,headers={}}={}){
    const response=await fetch('/api/ingresos'+path,{
      method,credentials:'same-origin',cache:'no-store',
      headers:{...(data!==null?{'Content-Type':'application/json'}:{}),...headers},
      ...(data!==null?{body:JSON.stringify(data)}:raw?{body:raw}:{})
    });
    if(response.status===401){location.replace('/main');throw new Error('Sesión caducada');}
    if(response.status===403){location.replace('/inicio');throw new Error('Sin permisos');}
    const output=await response.json().catch(()=>({error:'RESPUESTA_INVALIDA'}));
    if(!response.ok||output.ok===false){
      const err=new Error(problem(output.error));err.details=output;
      throw err;
    }
    return output;
  }
  const options=(select,rows,label,placeholder)=>{
    const chosen=select.value;
    select.replaceChildren(new Option(placeholder,''));
    rows.forEach(row=>select.add(new Option(label(row),row.id)));
    if([...select.options].some(x=>x.value===chosen))select.value=chosen;
  };
  function refreshCatalogOptions(){
    bySap=new Map(catalog.map(x=>[n(x.sap_code),x]));
    byWarehouse=new Map(warehouse.map(x=>[x.id,x]));
    options($('ing-source'),warehouse.filter(x=>x.administration==='ALIADO'),
      x=>x.centro+' / '+x.almacen+' · '+x.description,'Seleccionar aliado...');
    options($('ing-destination'),warehouse.filter(x=>x.administration==='PROPIA'),
      x=>x.centro+' / '+x.almacen+' · '+x.description,'Seleccionar bodega...');
    const datalist=$('ing-sap-list');datalist.replaceChildren();
    for(const row of catalog){
      const option=document.createElement('option');
      option.value=row.sap_code;option.label=row.description+' · '+row.serial_profile;
      datalist.append(option);
    }
  }
  async function initial(){
    try{
      const [listData,catalogData]=await Promise.all([api(''),api('/catalogos')]);
      list=listData.items||[];
      catalog=catalogData.catalog||[];
      warehouse=catalogData.warehouses||[];
      refreshCatalogOptions();
      renderList();
      // La puerta temporal desaparece definitivamente después de registrar la apertura.
      try{
        const response=await fetch('/api/saldos-iniciales/estado',{credentials:'same-origin',cache:'no-store'});
        if(response.ok){
          const state=await response.json();
          $('ingress-opening-link').hidden=!state.available;
        }
      }catch{}
    }catch(err){text('ingress-list-count',err.message);}
  }
  function renderList(){
    const q=safe($('ingress-search').value).toLowerCase();
    const st=$('ingress-status-filter').value;
    const results=list.filter(x=>(!st||x.status===st)&&
      (!q||[x.reference,x.document_number,x.source_description,x.destination_description,x.document_type].join(' ').toLowerCase().includes(q)));
    const tbody=$('ingress-table-body');tbody.replaceChildren();
    for(const record of results){
      const tr=document.createElement('tr');
      const add=(value,secondary='')=>{
        const cell=elt('td');
        cell.append(elt('strong',value||'Pendiente'));
        if(secondary)cell.append(elt('small',secondary));
        tr.append(cell);
      };
      add(record.reference||'Borrador',record.received_date||record.created_at?.slice(0,10)||'');
      add(record.document_number||'Sin número',DOC_TYPES[record.document_type]||'Pendiente');
      add(record.document_type==='SALDO_INICIAL'?'Inventario de apertura':record.source_description||'Pendiente');
      add(record.destination_description||'Pendiente');
      add(record.item_count||0);add(record.total_units||0);
      const state=elt('td');
      state.append(elt('span',record.status==='REGISTRADO'?'Registrado':'Borrador',
        record.status==='REGISTRADO'?'ingress-pill':'ingress-pill draft'));
      tr.append(state);
      const actions=elt('td'),buttons=elt('div',undefined,'ingress-row-actions');
      const open=elt('button',record.status==='BORRADOR'?'Continuar':'Ver detalle','ingress-row-button');
      open.type='button';open.addEventListener('click',()=>void openIngress(record.id));
      buttons.append(open);
      if(record.status==='BORRADOR'){
        const remove=elt('button','Eliminar','ingress-row-button ingress-row-delete');
        remove.type='button';
        remove.setAttribute('aria-label','Eliminar borrador del pedido '+(record.document_number||'sin número'));
        remove.title='Eliminar este borrador definitivamente';
        remove.addEventListener('click',()=>void deleteDraft(record,remove));
        buttons.append(remove);
      }
      actions.append(buttons);tr.append(actions);
      tbody.append(tr);
    }
    $('ingress-empty').hidden=results.length>0;
    text('ingress-list-count',results.length+' ingreso'+(results.length===1?'':'s'));
    text('kpi-ingress-total',list.length);
    text('kpi-ingress-drafts',list.filter(x=>x.status==='BORRADOR').length);
    text('kpi-ingress-confirmed',list.filter(x=>x.status==='REGISTRADO').length);
    text('kpi-ingress-units',list.filter(x=>x.status==='REGISTRADO').reduce((sum,x)=>sum+Number(x.total_units||0),0));
  }
  async function deleteDraft(record,button){
    if(busy||record.status!=='BORRADOR')return;
    const label=record.document_number||'sin número';
    const confirmed=window.confirm(
      '¿Eliminar definitivamente el borrador del pedido '+label+'?\n\n'+
      'Se eliminarán el documento, sus '+Number(record.item_count||0)+' ítems y el PDF adjunto, si existe.\n'+
      'Esta acción no se puede deshacer.'
    );
    if(!confirmed)return;
    busy=true;button.disabled=true;
    try{
      await api('/'+record.id,{method:'DELETE'});
      // Eliminar de la vista inmediatamente después de recibir confirmación del servidor.
      list=list.filter(entry=>entry.id!==record.id);
      renderList();
      showListMessage('Borrador del pedido '+label+' eliminado correctamente. El inventario no se modificó.');
      try{
        list=(await api('')).items||list;
        renderList();
      }catch{
        // La baja ya fue confirmada. Conserva el listado local sin mostrar un falso error.
      }
    }catch(error){
      showListMessage(error.message,true);
      try{
        list=(await api('')).items||list;
        renderList();
      }catch{}
    }finally{busy=false;button.disabled=false;}
  }
  function getDoc(){
    return {
      document_type:$('ing-doc-type').value,document_number:safe($('ing-doc-number').value),
      document_date:$('ing-doc-date').value,received_date:$('ing-date').value,
      source_id:$('ing-source').value||null,destination_id:$('ing-destination').value||null,
      notes:safe($('ing-notes').value)
    };
  }
  function setDoc(doc){
    const type=$('ing-doc-type');
    type.replaceChildren(new Option('Número de Pedido','NUMERO_PEDIDO'));
    // Los documentos ya registrados mantienen su tipo histórico en modo consulta.
    const historic=doc.status==='REGISTRADO'&&doc.document_type&&doc.document_type!=='NUMERO_PEDIDO';
    if(historic){
      const option=new Option(DOC_TYPES[doc.document_type]||doc.document_type,doc.document_type);
      type.add(option);
      type.value=doc.document_type;
    }else type.value='NUMERO_PEDIDO';
    $('ing-doc-number').value=doc.document_number||'';
    $('ing-doc-date').value=doc.document_date||'';
    $('ing-date').value=doc.received_date||'';
    $('ing-source').value=doc.source_id||'';
    $('ing-destination').value=doc.destination_id||'';
    $('ing-notes').value=doc.notes||'';
    text('ing-notes-count',$('ing-notes').value.length);
  }
  function warehouseName(wid){
    const v=byWarehouse.get(wid);
    return v?v.centro+' / '+v.almacen+' · '+v.description:'Pendiente';
  }
  function setDirty(){
    if(status!=='BORRADOR')return;
    dirty=true;validation=null;text('ingress-save-indicator','Cambios sin guardar');
    renderSummary();renderConfirmation();renderValidation();
  }
  // Un SAP sin perfil admite identificador interno único por unidad,
  // o gestión legada por cantidad si no se especifica serial.
  function itemComplete(item){
    const sap=bySap.get(n(item.sap_code));
    const serial=n(item.serial),quantity=Number(item.quantity);
    if(!sap||!Number.isInteger(quantity)||quantity<1)return false;
    if(!['VALORADO','NOVALORADO'].includes(n(item.lot))||
       !['NUEVO','REMANUFACTURADO'].includes(n(item.reception_state)))return false;
    if(serial)return quantity===1&&(sap.serial_profile!=='CON PERFIL DE SERIE'||!['SIN PERFIL DE SERIE','N/A','NA','SIN SERIAL'].includes(serial));
    return sap.serial_profile==='SIN PERFIL DE SERIE';
  }
  function renderSummary(){
    const doc=getDoc(),serialCount=items.filter(x=>x.serial?.trim()).length;
    text('ing-aside-lines',items.length+' ítems');
    text('ing-aside-doc',(DOC_TYPES[doc.document_type]||'Documento')+(doc.document_number?' · '+doc.document_number:''));
    text('ing-aside-source',warehouseName(doc.source_id));
    text('ing-aside-destination',warehouseName(doc.destination_id));
    text('ing-aside-serial',serialCount+' serial'+(serialCount===1?'':'es'));
    const complete=items.filter(itemComplete).length;
    $('ing-progress-fill').style.width=items.length?Math.round(100*complete/items.length)+'%':'0%';
    text('ing-aside-progress',complete+' de '+items.length+' ítems completos.');
    const aside=$('ing-aside-list');aside.replaceChildren();
    const errs=validation?.errors||[];
    const warns=validation?.warnings||[];
    text('ing-aside-issues',errs.length+warns.length);
    if(!errs.length&&!warns.length)aside.append(elt('p',validation?'Sin alertas bloqueantes.':'Revisa los pasos antes de confirmar.'));
    for(const error of errs.slice(0,5))aside.append(elt('p',error.message,'bad'));
    for(const warning of warns.slice(0,2))aside.append(elt('p',warning.message,'warn'));
  }
  function cell(tr,child){
    const td=document.createElement('td');
    if(child instanceof Node)td.append(child);else td.textContent=String(child??'');
    tr.append(td);return td;
  }
  // Lectura de Excel protegida: editar únicamente una copia temporal por fila.
  const itemKeys=['sap_code','serial','quantity','lot','reception_state','notes'];
  const itemLabels={sap_code:'Código SAP',serial:'Serial',quantity:'Cantidad',lot:'Lote',reception_state:'Estado de recepción',notes:'Observaciones'};
  function rowIssues(index){return (validation?.errors||[]).filter(issue=>issue.index===index);}
  function viewItemValue(item,key){
    const value=key==='reception_state'
      ?(n(item[key])==='REMANUFACTURADO'?'Remanufacturado':n(item[key])==='NUEVO'?'Nuevo':'')
      :String(item[key]??'').trim();
    const span=elt('span',value||'—','ingress-read-value'+(!value?' empty':''));
    span.title=value||'Sin información';
    span.setAttribute('aria-label',itemLabels[key]+': '+(value||'Sin información'));
    return span;
  }
  function itemEditorField(draft,key,index){
    const isSelect=key==='lot'||key==='reception_state';
    const field=document.createElement(isSelect?'select':'input');
    if(isSelect){
      const values=key==='lot'
        ?[['','Seleccionar lote...'],['VALORADO','VALORADO'],['NOVALORADO','NOVALORADO']]
        :[['','Seleccionar estado...'],['NUEVO','Nuevo'],['REMANUFACTURADO','Remanufacturado']];
      values.forEach(([value,label])=>field.add(new Option(label,value)));
      field.className='ingress-classification';
    }else field.type=key==='quantity'?'number':'text';
    field.value=String(draft[key]??'');
    field.setAttribute('aria-label','Editar '+itemLabels[key]+' del ítem '+(index+1));
    if(key==='sap_code'){
      field.className='sap-input';field.maxLength=50;field.setAttribute('list','ing-sap-list');
    }else if(key==='serial'){
      field.className='serial-input';field.maxLength=100;
    }else if(key==='quantity'){
      field.className='quantity-input';field.min=1;field.max=1000000;field.step=1;
    }else if(key==='notes')field.maxLength=240;
    field.addEventListener(isSelect?'change':'input',()=>{
      draft[key]=key==='quantity'?(field.value===''?0:Number(field.value)):field.value;
      if(key==='sap_code'){
        const tr=field.closest('tr'),sap=bySap.get(n(draft.sap_code));
        tr.querySelector('.income-item-description').textContent=sap?.description||'SAP no encontrado';
        tr.querySelector('.income-item-profile').textContent=sap?.serial_profile||'Sin clasificar';
      }
    });
    return field;
  }
  function beginItemEdit(index,isNew=false){
    if(status!=='BORRADOR'||index<0||index>=items.length)return;
    if(editingIndex!==null){
      showMessage('Aplica o cancela primero la edición del ítem '+(editingIndex+1)+'.',true);return;
    }
    editingIndex=index;editingDraft={...items[index]};editingNew=isNew;
    renderItems();
    $('ing-item-table').querySelector('[data-item-index="'+index+'"] .sap-input')?.focus({preventScroll:true});
  }
  function applyItemEdit(){
    if(editingIndex===null||status!=='BORRADOR')return;
    const index=editingIndex,quantity=Number(editingDraft.quantity);
    if(!Number.isInteger(quantity)||quantity<1||quantity>1000000){
      showMessage('Ítem '+(index+1)+': la cantidad debe ser un entero de 1 a 1.000.000.',true);return;
    }
    items[index]={...items[index],...editingDraft};
    editingIndex=null;editingDraft=null;editingNew=false;
    setDirty();renderItems();
    showMessage('Corrección aplicada al ítem '+(index+1)+'. Guarda el borrador para validar y conservar el cambio.');
  }
  function cancelItemEdit(){
    if(editingIndex===null)return;
    if(editingNew)items.splice(editingIndex,1);
    editingIndex=null;editingDraft=null;editingNew=false;
    renderItems();
    showMessage('Edición cancelada. No se modificó el ítem.');
  }
  function refreshItemTotals(){
    text('ing-item-total',items.length+' ítem'+(items.length===1?'':'s'));
    text('ing-unit-total',items.reduce((acc,r)=>acc+Math.max(0,Number(r.quantity)||0),0)+' unidades');
  }
  function renderItems(){
    const body=$('ing-item-table');body.replaceChildren();
    items.forEach((item,index)=>{
      const isEditing=editingIndex===index,draft=isEditing?editingDraft:item;
      const sap=bySap.get(n(draft.sap_code)),issues=rowIssues(index);
      const tr=elt('tr');tr.dataset.itemIndex=String(index);
      if(issues.length)tr.classList.add('ingress-item-invalid');
      if(isEditing)tr.classList.add('ingress-item-editing');
      cell(tr,index+1);
      cell(tr,isEditing?itemEditorField(draft,'sap_code',index):viewItemValue(item,'sap_code'));
      const info=elt('div');
      info.append(elt('span',sap?.description||'SAP no encontrado','income-item-description'));
      info.append(elt('small',sap?.serial_profile||'Sin clasificar','income-item-profile'));
      cell(tr,info);
      for(const key of itemKeys.slice(1))
        cell(tr,isEditing?itemEditorField(draft,key,index):viewItemValue(item,key));
      const ok=itemComplete(item)&&!issues.length;
      const pill=elt('span',isEditing?'Editando':ok?'Completo':'Revisar',
        isEditing?'ingress-pill editing':ok?'ingress-pill':'ingress-pill draft');
      if(issues.length)pill.title=issues.map(issue=>issue.message).join(' | ');
      cell(tr,pill);
      const actions=elt('div',undefined,'ingress-item-actions');
      if(status==='BORRADOR'){
        if(isEditing){
          const apply=elt('button','✓','ingress-item-apply');
          apply.type='button';apply.title='Aplicar corrección del ítem '+(index+1);
          apply.setAttribute('aria-label',apply.title);
          apply.addEventListener('click',applyItemEdit);
          const cancel=elt('button','↶','ingress-item-cancel');
          cancel.type='button';cancel.title='Cancelar edición del ítem '+(index+1);
          cancel.setAttribute('aria-label',cancel.title);
          cancel.addEventListener('click',cancelItemEdit);
          actions.append(apply,cancel);
        }else{
          const edit=elt('button','✎','ingress-item-edit');
          edit.type='button';edit.title='Editar ítem '+(index+1);
          edit.setAttribute('aria-label',edit.title);edit.disabled=editingIndex!==null;
          edit.addEventListener('click',()=>beginItemEdit(index));
          const remove=elt('button','×','ingress-item-remove');
          remove.type='button';remove.title='Eliminar ítem '+(index+1);
          remove.setAttribute('aria-label',remove.title);remove.disabled=editingIndex!==null;
          remove.addEventListener('click',()=>{
            if(!confirm('¿Eliminar el ítem '+(index+1)+' del borrador?'))return;
            items.splice(index,1);setDirty();renderItems();
            showMessage('Ítem eliminado del borrador. Guarda para conservar el cambio.');
          });
          actions.append(edit,remove);
        }
      }
      cell(tr,actions);body.append(tr);
    });
    refreshItemTotals();
    $('ing-item-add').disabled=status!=='BORRADOR'||editingIndex!==null;
    $('ing-item-import').disabled=status!=='BORRADOR'||editingIndex!==null;
  }
  function renderValidation(){
    const el=$('ing-validation-list'),head=$('ing-validation-head');el.replaceChildren();
    if(!validation){
      head.className='ingress-validation-head bad';head.textContent='Guarda el borrador y realiza la validación.';
      return;
    }
    const errors=validation.errors||[],warnings=validation.warnings||[];
    head.className='ingress-validation-head'+(errors.length?' bad':'');
    head.textContent=errors.length
      ?errors.length+' error'+(errors.length===1?'':'es')+' bloqueante'+(errors.length===1?'':'s')+' por corregir.'
      :'Validación correcta. El ingreso puede registrarse.';
    if(!errors.length&&!warnings.length)el.append(elt('div','✓ Todas las reglas verificadas.','ing-validation-row'));
    for(const issue of [...errors,...warnings]){
      const row=elt('div',undefined,'ing-validation-row '+(issue.blocking?'bad':'warning'));
      row.append(elt('span',issue.blocking?'×':'!','marker'));
      row.append(elt('span',issue.message));
      if(issue.blocking){
        const btn=elt('button','Corregir');btn.type='button';
        btn.addEventListener('click',()=>navigate(issue.step||2,issue.index));
        row.append(btn);
      }
      el.append(row);
    }
  }
  function renderConfirmation(){
    const parent=$('ing-confirm-grid');parent.replaceChildren();
    const doc=getDoc();
    const pairs=[
      ['Tipo',DOC_TYPES[doc.document_type]||'Pendiente'],
      ['Número de pedido',doc.document_number||'Pendiente'],
      ['Origen / Aliado',warehouseName(doc.source_id)],
      ['Bodega destino',warehouseName(doc.destination_id)],
      ['Fecha del documento',doc.document_date||'Pendiente'],
      ['Fecha de ingreso',doc.received_date||'Pendiente'],
      ['Soporte PDF',support.size?support.filename+' · '+Math.round(support.size/1024)+' KB':'No adjunto (opcional)'],
      ['Total',items.length+' ítems · '+items.reduce((a,x)=>a+(Number(x.quantity)||0),0)+' unidades']
    ];
    for(const [label,value] of pairs){
      const box=elt('div',undefined,'ing-confirm-card');
      box.append(elt('small',label),elt('strong',value));parent.append(box);
    }
    const tbody=$('ing-confirm-items');tbody.replaceChildren();
    for(const item of items){
      const tr=elt('tr');
      cell(tr,item.sap_code);cell(tr,bySap.get(n(item.sap_code))?.description||'Sin descripción');
      cell(tr,n(item.serial)||'Sin perfil de serie');cell(tr,item.quantity);
      cell(tr,n(item.lot)||'Sin clasificar');
      cell(tr,n(item.reception_state)||'Sin clasificar');
      tbody.append(tr);
    }
    const blocked=!validation?.valid || dirty;
    $('ing-confirm-block').hidden=!blocked;
    if(blocked)text('ing-confirm-block',dirty
      ?'Hay cambios sin guardar o validar. Guarda y revisa la validación.'
      :(validation?.errors?.length||0)+' errores bloqueantes por resolver.');
    $('ing-confirm').disabled=blocked || !$('ing-confirm-ack').checked || status!=='BORRADOR';
  }
  function setStep(next){
    step=next;
    for(let x=1;x<=4;x++){
      $('ingress-step-'+x).hidden=x!==next;
      const btn=document.querySelector('[data-step="'+x+'"]');
      btn.classList.toggle('current',x===next);
      btn.classList.toggle('done',x<next);
      if(x===next)btn.setAttribute('aria-current','step');
      else btn.removeAttribute('aria-current');
    }
    $('ing-prev').disabled=step===1;
    $('ing-next').hidden=step===4;
    $('ing-save').hidden=status!=='BORRADOR';
    $('ing-confirm').hidden=step!==4||status!=='BORRADOR';
    $('ing-confirm-ack').disabled=status!=='BORRADOR';
    if(next===3)renderValidation();
    if(next===4)renderConfirmation();
    showMessage('');
  }
  async function saveDraft({quiet=false}={}){
    if(editingIndex!==null){showMessage('Aplica o cancela la edición del ítem '+(editingIndex+1)+' antes de guardar.',true);return false;}
    if(status!=='BORRADOR'||!id)return true;
    const button=$('ing-save');button.disabled=true;
    text('ingress-save-indicator','Guardando...');
    try{
      const output=await api('/'+id,{method:'PATCH',data:{document:getDoc(),items}});
      dirty=false;validation=output.validation;
      text('ingress-save-indicator','Borrador guardado');
      renderItems();renderSummary();renderValidation();renderConfirmation();
      if(!quiet)showMessage('Borrador guardado. Todavía no afecta las existencias.');
      return true;
    }catch(e){
      text('ingress-save-indicator','No se pudo guardar');
      showMessage(e.message,true);return false;
    }finally{button.disabled=status!=='BORRADOR';}
  }
  async function navigate(next,index){
    if(busy||next<1||next>4)return;
    if(status==='BORRADOR'){
      if(!await saveDraft({quiet:true}))return;
    }
    if(next===3||next===4){
      try{
        validation=(await api('/'+id+'/validar')).validation;
      }catch(err){showMessage(err.message,true);return;}
    }
    setStep(next);renderItems();
    if(next===2&&Number.isInteger(index)){
      const row=$('ing-item-table').querySelector('[data-item-index="'+index+'"]');
      row?.scrollIntoView({block:'nearest'});
      if(status==='BORRADOR')beginItemEdit(index);
    }
    renderSummary();
  }
  function reflectSupport(){
    $('ing-support-actions').hidden=!support.size;
    text('ing-support-label',support.size?support.filename+' · '+Math.round(support.size/1024)+' KB':'PDF de máximo 5 MB. También puedes registrar el ingreso sin soporte.');
    $('ing-support-download').href='/api/ingresos/'+id+'/soporte';
    $('ing-support-select').disabled=status!=='BORRADOR';
    $('ing-support-remove').disabled=status!=='BORRADOR';
  }
  // Los ingresos contabilizados se consultan como historial, nunca como borradores.
  function showRegisteredDetail(data){
    const doc=data.document,rows=data.items||[];
    id=doc.id;status='REGISTRADO';dirty=false;validation=null;
    editingIndex=null;editingDraft=null;editingNew=false;
    text('ingress-detail-reference',doc.reference||'Registro confirmado');
    text('ingress-detail-pedido',(DOC_TYPES[doc.document_type]||'Documento')+' · '+(doc.document_number||'Sin número'));
    text('ingress-detail-lines',rows.length+' ítem'+(rows.length===1?'':'s'));
    const units=rows.reduce((total,row)=>total+(Number(row.quantity)||0),0);
    text('ingress-detail-units',units+' unidad'+(units===1?'':'es'));
    const body=$('ingress-detail-items');body.replaceChildren();
    for(const item of rows){
      const tr=elt('tr');
      cell(tr,item.sap_code||'—');
      cell(tr,item.sap_description||bySap.get(n(item.sap_code))?.description||'Sin descripción');
      cell(tr,item.serial||'Sin serial');
      cell(tr,Number(item.quantity)||0);
      cell(tr,item.lot||'Sin clasificar');
      cell(tr,item.reception_state==='REMANUFACTURADO'?'Remanufacturado':item.reception_state==='NUEVO'?'Nuevo':item.reception_state||'Sin clasificar');
      body.append(tr);
    }
    $('ingress-home').hidden=true;
    $('ingress-wizard').hidden=true;
    $('ingress-detail').hidden=false;
  }
  async function openIngress(entryId){
    if(busy)return;busy=true;
    showListMessage('');
    try{
      const data=await api('/'+entryId);
      if(data.document.status==='REGISTRADO'){
        showRegisteredDetail(data);
        return;
      }
      $('ingress-detail').hidden=true;
      id=entryId;status=data.document.status;
      editingIndex=null;editingDraft=null;editingNew=false;
      support={size:data.document.support_size||0,filename:data.document.support_filename||''};
      validation=data.validation;
      items=(data.items||[]).map(x=>({
        sap_code:x.sap_code||'',serial:x.serial||'',quantity:x.quantity||0,
        lot:x.lot||'',reception_state:x.reception_state||'',notes:x.notes||''
      }));
      setDoc(data.document);dirty=false;
      text('ingress-reference-label',data.document.reference||'Borrador · '+id.slice(0,8));
      text('income-wizard-title',status==='BORRADOR'?'Nuevo ingreso':'Detalle del ingreso');
      text('ingress-save-indicator',status==='BORRADOR'?'Borrador guardado':'Registro definitivo');
      $('ingress-home').hidden=true;$('ingress-wizard').hidden=false;
      for(const control of $('ingress-step-1').querySelectorAll('input:not([type=file]),select,textarea'))
        control.disabled=status!=='BORRADOR';
      $('ing-confirm-ack').checked=false;
      reflectSupport();renderItems();renderSummary();renderValidation();renderConfirmation();
      setStep(status==='BORRADOR'?1:4);
    }catch(e){showMessage(e.message,true);}
    finally{busy=false;}
  }
  async function newIngress(){
    if(busy)return;busy=true;
    showListMessage('');
    try{
      const result=await api('',{method:'POST'});
      await openIngressAfterCreate(result.id);
    }catch(e){alert(e.message);}
    finally{busy=false;}
  }
  async function openIngressAfterCreate(createdId){
    const data=await api('/'+createdId);
    id=createdId;status='BORRADOR';editingIndex=null;editingDraft=null;editingNew=false;support={size:0,filename:''};validation=data.validation;items=[];
    setDoc(data.document);dirty=false;
    text('ingress-reference-label','Borrador · '+id.slice(0,8));
    text('income-wizard-title','Nuevo ingreso');
    text('ingress-save-indicator','Borrador creado');
    $('ingress-home').hidden=true;$('ingress-detail').hidden=true;$('ingress-wizard').hidden=false;
    for(const control of $('ingress-step-1').querySelectorAll('input:not([type=file]),select,textarea'))control.disabled=false;
    $('ing-confirm-ack').checked=false;
    reflectSupport();renderItems();renderSummary();renderValidation();renderConfirmation();
    setStep(1);
  }
  async function goHome(){
    if(editingIndex!==null){showMessage('Aplica o cancela la edición del ítem '+(editingIndex+1)+' antes de salir.',true);return;}
    if(status==='BORRADOR'&&dirty&&!await saveDraft({quiet:true}))return;
    $('ingress-wizard').hidden=true;$('ingress-detail').hidden=true;$('ingress-home').hidden=false;id='';
    try{list=(await api('')).items||[];renderList();}
    catch(e){alert(e.message);}
  }
  async function uploadPdf(file){
    if(!file||!id||status!=='BORRADOR')return;
    if(file.size>5*1024*1024||file.size===0||!file.name.toLowerCase().endsWith('.pdf')){
      showMessage('Adjunta un PDF válido de máximo 5 MB.',true);return;
    }
    text('ingress-save-indicator','Adjuntando PDF...');
    try{
      const result=await api('/'+id+'/soporte',{method:'POST',raw:file,
        headers:{'Content-Type':'application/pdf','x-file-name':file.name}});
      support={size:result.size,filename:result.name};
      reflectSupport();setDirty();renderSummary();
      text('ingress-save-indicator','PDF adjunto');
      showMessage('PDF adjuntado de forma privada al borrador.');
    }catch(err){showMessage(err.message,true);}
    finally{$('ing-support-file').value='';}
  }
  async function removePdf(){
    if(!id||!support.size||status!=='BORRADOR')return;
    if(!confirm('¿Quitar el PDF de soporte del borrador?'))return;
    try{
      await api('/'+id+'/soporte',{method:'DELETE'});
      support={size:0,filename:''};reflectSupport();setDirty();
      showMessage('PDF eliminado del borrador.');
    }catch(e){showMessage(e.message,true);}
  }
  async function confirmIngress(){
    if(busy||status!=='BORRADOR'||!$('ing-confirm-ack').checked)return;
    busy=true;$('ing-confirm').disabled=true;
    try{
      if(!await saveDraft({quiet:true}))return;
      const validationResult=(await api('/'+id+'/validar')).validation;
      validation=validationResult;renderSummary();renderValidation();renderConfirmation();
      if(!validation.valid){
        showMessage('Hay inconsistencias bloqueantes. Regresa a Validación y corrígelas.',true);
        return;
      }
      if(!confirm('¿Registrar definitivamente este ingreso? Se actualizarán las existencias y no podrá editarse.'))return;
      const result=await api('/'+id+'/confirmar',{method:'POST'});
      status='REGISTRADO';dirty=false;
      text('ingress-reference-label',result.reference);
      text('income-wizard-title','Ingreso registrado');
      text('ingress-save-indicator','Registrado correctamente');
      $('ing-confirm-ack').disabled=true;
      renderItems();renderConfirmation();setStep(4);
      showMessage('Ingreso '+result.reference+' registrado. Inventario actualizado correctamente.');
    }catch(e){
      showMessage(e.message,true);
      if(e.details?.validation){validation=e.details.validation;renderItems();renderValidation();renderSummary();renderConfirmation();}
    }finally{busy=false;if(status==='BORRADOR')renderConfirmation();}
  }
  async function itemTemplate(){
    if(!window.ExcelJS){showMessage('No se pudo cargar el lector de Excel.',true);return;}
    const button=$('ing-item-template');button.disabled=true;
    try{
      const book=new ExcelJS.Workbook();book.creator='PULSO';
      const sheet=book.addWorksheet('Items',{views:[{state:'frozen',ySplit:1,showGridLines:false}]});
      sheet.columns=[
        {header:'Código SAP',key:'sap_code',width:22},
        {header:'Serial',key:'serial',width:35},
        {header:'Cantidad',key:'quantity',width:16},
        {header:'Lote',key:'lot',width:20},
        {header:'Estado de Recepción',key:'reception_state',width:26},
        {header:'Observaciones',key:'notes',width:43}
      ];
      const header=sheet.getRow(1);header.height=28;
      header.eachCell(cell=>{
        cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF075A47'}};
        cell.font={name:'Aptos',size:11,color:{argb:'FFFFFFFF'},bold:true};
        cell.alignment={vertical:'middle'};
      });
      sheet.autoFilter={from:{row:1,column:1},to:{row:1,column:6}};
      const dropdown=(values,title)=>({
        type:'list',allowBlank:false,formulae:['"'+values.join(',')+'"'],
        showErrorMessage:true,errorStyle:'error',errorTitle:'Valor no válido',
        error:'Selecciona una opción de la lista de '+title+'.'
      });
      for(let row=2;row<=501;row++){
        sheet.getCell('D'+row).dataValidation=dropdown(['VALORADO','NOVALORADO'],'Lote');
        sheet.getCell('E'+row).dataValidation=dropdown(['Nuevo','Remanufacturado'],'Estado de recepción');
      }
      sheet.getColumn('sap_code').numFmt='@';
      sheet.getColumn('serial').numFmt='@';
      sheet.getColumn('quantity').numFmt='0';
      const bytes=await book.xlsx.writeBuffer();
      const url=URL.createObjectURL(new Blob([bytes],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
      const a=document.createElement('a');a.href=url;a.download='PULSO_Plantilla_Items_Ingresos.xlsx';
      document.body.append(a);a.click();a.remove();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(e){showMessage('No se pudo descargar la plantilla: '+e.message,true);}
    finally{button.disabled=false;}
  }
  async function importItems(file){
    if(!file||status!=='BORRADOR')return;
    if(editingIndex!==null){showMessage('Aplica o cancela la edición actual antes de importar.',true);$('ing-item-file').value='';return;}
    if(!window.ExcelJS){showMessage('No se pudo cargar el lector Excel.',true);return;}
    if(file.size>5*1024*1024){showMessage('El Excel no debe superar 5 MB.',true);return;}
    try{
      const workbook=new ExcelJS.Workbook();
      await workbook.xlsx.load(await file.arrayBuffer());
      const sheet=workbook.worksheets[0];
      if(!sheet)throw new Error('El Excel no tiene hojas.');
      const headers=['Código SAP','Serial','Cantidad','Lote','Estado de Recepción','Observaciones'];
      const val=x=>String(x?.text??x?.result??x??'').trim();
      for(let i=0;i<headers.length;i++)
        if(val(sheet.getRow(1).getCell(i+1).value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase()!==headers[i].normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase())
          throw new Error('La plantilla debe contener: '+headers.join(', ')+'.');
      const parsed=[];const issues=[];
      for(let i=2;i<=sheet.rowCount;i++){
        const row=sheet.getRow(i);
        const codes=Array.from({length:6},(_,k)=>val(row.getCell(k+1).value));
        if(codes.every(v=>!v))continue;
        const quantity=Number(codes[2]);
        if(!Number.isInteger(quantity)||quantity<=0||quantity>1000000){
          issues.push('Fila '+i+': cantidad inválida.');continue;
        }
        parsed.push({sap_code:codes[0],serial:codes[1],quantity,
          lot:codes[3].toUpperCase(),reception_state:codes[4].toUpperCase(),notes:codes[5]});
      }
      if(!parsed.length)throw new Error('El archivo no contiene ítems.');
      if(parsed.length+items.length>500)throw new Error('Máximo 500 ítems por ingreso.');
      if(issues.length)throw new Error(issues.slice(0,5).join(' '));
      if(!confirm('Agregar '+parsed.length+' ítems del Excel al borrador actual. ¿Continuar?'))return;
      items.push(...parsed);setDirty();renderItems();
      showMessage(parsed.length+' ítems añadidos al borrador. Guarda para validar SAP y seriales.');
    }catch(e){showMessage('No se importó el Excel: '+e.message,true);}
    finally{$('ing-item-file').value='';}
  }
  async function start(){
    $('ingress-new').addEventListener('click',()=>void newIngress());
    $('ingress-search').addEventListener('input',renderList);
    $('ingress-status-filter').addEventListener('change',renderList);
    $('ingress-back-home').addEventListener('click',()=>void goHome());
    $('ingress-detail-back').addEventListener('click',()=>void goHome());
    $('ing-save').addEventListener('click',()=>void saveDraft());
    $('ing-prev').addEventListener('click',()=>void navigate(step-1));
    $('ing-next').addEventListener('click',()=>void navigate(step+1));
    $('ing-confirm').addEventListener('click',()=>void confirmIngress());
    $('ing-confirm-ack').addEventListener('change',renderConfirmation);
    $('ing-item-add').addEventListener('click',()=>{
      if(status==='BORRADOR'&&editingIndex===null&&items.length<500){
        items.push({sap_code:'',serial:'',quantity:1,lot:'',reception_state:'',notes:''});
        setDirty();beginItemEdit(items.length-1,true);
      }
    });
    $('ing-item-template').addEventListener('click',itemTemplate);
    $('ing-item-import').addEventListener('click',()=>$('ing-item-file').click());
    $('ing-item-file').addEventListener('change',e=>void importItems(e.target.files?.[0]));
    $('ing-support-select').addEventListener('click',()=>$('ing-support-file').click());
    $('ing-support-file').addEventListener('change',e=>void uploadPdf(e.target.files?.[0]));
    $('ing-support-remove').addEventListener('click',()=>void removePdf());
    for(const el of $('ingress-step-1').querySelectorAll('input:not([type=file]),select,textarea')){
      el.addEventListener('input',()=>{
        if(el.id==='ing-notes')text('ing-notes-count',el.value.length);
        setDirty();
      });
      el.addEventListener('change',setDirty);
    }
    document.querySelectorAll('[data-step]').forEach(button=>{
      button.addEventListener('click',()=>void navigate(Number(button.dataset.step)));
    });
    window.addEventListener('beforeunload',event=>{
      if(id&&status==='BORRADOR'&&(dirty||editingIndex!==null)){event.preventDefault();event.returnValue='';}
    });
    await initial();
  }
  void start();
})();