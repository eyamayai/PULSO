'use strict';
(() => {
 const $=id=>document.getElementById(id);
 const make=(tag,value,cls)=>{
  const x=document.createElement(tag);
  if(value!==undefined)x.textContent=String(value);
  if(cls)x.className=cls;
  return x;
 };
 const t=(id,value)=>{$(id).textContent=String(value??'');};
 const upper=value=>String(value??'').trim().toUpperCase();
 const txt=value=>String(value??'').trim();
 const dateLocal=()=>{
  const date=new Date(),pad=x=>String(x).padStart(2,'0');
  return date.getFullYear()+'-'+pad(date.getMonth()+1)+'-'+pad(date.getDate());
 };
 let records=[],metrics={},technicians=[],warehouses=[],serials=[],bulk=[],technicianSummaries=[],activeEquipment=[];
 let dispatchId='',dispatchStatus='BORRADOR',items=[],step=1,dirty=false,busy=false;
 let currentMode='manual',validation=null,activeTab='recent',pageIndex=0;
 const toast=(message,error=false)=>{
  const el=$('dispatch-toast');el.textContent=message||'';el.hidden=!message;el.classList.toggle('error',error);
 };
 const errorText=code=>({
  SIN_PERMISOS:'No tienes permisos para gestionar despachos.',
  TECNICO_INVALIDO:'Selecciona un técnico activo.',
  BODEGA_INVALIDA:'Selecciona una bodega propia activa.',
  FECHA_INVALIDA:'Indica una fecha válida.',
  SIN_ITEMS:'Selecciona al menos un ítem.',
  SIN_EXISTENCIAS:'La bodega no tiene suficientes unidades.',
  SERIAL_NO_DISPONIBLE:'Uno o más seriales no están disponibles en la bodega.',
  EXISTENCIAS_CAMBIARON:'El inventario cambió. Actualiza los disponibles y valida de nuevo.',
  VALIDACION_BLOQUEANTE:'Corrige los errores antes de confirmar.',
  DESPACHO_INMUTABLE:'Un despacho finalizado no admite modificaciones.',
  DESPACHO_NO_ENCONTRADO:'No se encontró el despacho.',
  NO_SE_PUDO_GUARDAR:'No se pudieron guardar los cambios.',
  DATOS_INVALIDOS:'Revisa los campos y cantidades.'
 })[code]||code||'No se pudo completar la operación.';
 async function api(path,{method='GET',data=null}={}){
  const resp=await fetch('/api/despachos'+path,{
   method,credentials:'same-origin',cache:'no-store',
   headers:data!==null?{'Content-Type':'application/json'}:{},
   ...(data!==null?{body:JSON.stringify(data)}:{})
  });
  if(resp.status===401){location.assign('/main');throw new Error('Tu sesión ha caducado.');}
  if(resp.status===403){location.assign('/inicio');throw new Error('Acceso no autorizado.');}
  const body=await resp.json().catch(()=>({error:'RESPUESTA_INVALIDA'}));
  if(!resp.ok||body.ok===false){
   const err=new Error(errorText(body.error));err.details=body;throw err;
  }
  return body;
 }
 const display=(which)=>{
  for(const [id,key] of [['dispatch-home','home'],['dispatch-wizard','wizard'],['dispatch-detail','detail']])
   $(id).hidden=which!==key;
  toast('');
 };
 const stockList=()=>[
  ...serials.map(x=>({...x,kind:'serial',quantity:1})),
  ...bulk.map(x=>({...x,kind:'bulk',serial:'',lot:'',reception_state:''}))
 ];
 function refreshKpis(){
  t('dispatch-kpi-available',metrics.available||0);
  // Total acumulado calculado en SQL; no depende de la paginación del listado.
  const bulkAssigned=Number(metrics.assigned_total||0);
  t('dispatch-kpi-assigned',bulkAssigned);
  t('dispatch-kpi-techs',metrics.technicians||0);
  t('dispatch-kpi-drafts',metrics.drafts||0);
  const available=Number(metrics.available||0),assigned=bulkAssigned,total=available+assigned;
  t('dispatch-donut-total',total);
  t('dispatch-legend-free',available);
  t('dispatch-legend-busy',assigned);
  const angle=total?Math.round(assigned/total*360):0;
  $('dispatch-donut').style.background='conic-gradient(#008665 0deg '+angle+'deg, #a9eccc '+angle+'deg 360deg)';
 }
 const tabConfig={
  recent:{
   title:'Los últimos movimientos de asignación y sus borradores.',
   search:'Buscar por referencia, técnico o documento...',
   headers:['Referencia','Fecha','Técnico','Ítems','Unidades','Estado','Acciones'],
   empty:'Todavía no hay movimientos recientes.'
  },
  tech:{
   title:'Consolidado de equipos asignados a cada técnico responsable.',
   search:'Buscar por nombre o identificación del técnico...',
   headers:['Técnico responsable','Identificación','Despachos','Unidades asignadas','Última entrega','Acciones'],
   empty:'Todavía no hay técnicos con equipos asignados.'
  },
  active:{
   title:'Trazabilidad de equipos y materiales actualmente bajo responsabilidad de técnicos.',
   search:'Buscar por técnico, SAP, descripción o serial...',
   headers:['Técnico','Código SAP','Descripción','Serial','Cantidad','Fecha','Acciones'],
   empty:'Todavía no hay equipos asignados a técnicos.'
  },
  history:{
   title:'Consulta de despachos confirmados, con filtros por técnico y fechas.',
   search:'Buscar por referencia, técnico o serial...',
   headers:['Referencia','Fecha','Técnico','Ítems','Unidades','Estado','Acciones'],
   empty:'No hay despachos confirmados con estos filtros.'
  }
 };
 function contains(text,query){return String(text??'').toLowerCase().includes(query);}
 function matchAny(values,query){return !query||values.some(value=>contains(value,query));}
 function listCell(row,value,sub='',strong=false){
  const cell=make('td');
  if(strong)cell.append(make('strong',value??'—'));
  else cell.append(make('span',value??'—'));
  if(sub)cell.append(make('small',sub,'dispatch-cell-detail'));
  row.append(cell);
  return cell;
 }
 function actionButton(label,action,className='ingress-row-button'){
  const button=make('button',label,className);
  button.type='button';button.addEventListener('click',action);
  return button;
 }
 function viewDispatch(record,body){
  const tr=make('tr');
  listCell(tr,record.reference||'Borrador',
    record.status==='DESPACHADO'?'Asignación confirmada':'Sin confirmar',true);
  listCell(tr,record.dispatch_date||'Pendiente');
  listCell(tr,record.technician_name||'Sin técnico');
  listCell(tr,Number(record.item_count)||0);
  listCell(tr,Number(record.total_units)||0);
  const state=make('td');
  state.append(make('span',record.status==='DESPACHADO'?'Despachado':'Borrador',
    record.status==='DESPACHADO'?'dispatch-pill':'dispatch-pill draft'));
  tr.append(state);
  const actions=make('td'),buttons=make('div',undefined,'dispatch-list-actions');
  buttons.append(actionButton(record.status==='BORRADOR'?'Continuar':'Ver detalle',()=>void openRecord(record.id)));
  if(record.status==='BORRADOR')
   buttons.append(actionButton('Eliminar',()=>void deleteRecord(record,buttons.lastElementChild),'ingress-row-button delete'));
  actions.append(buttons);tr.append(actions);body.append(tr);
 }
 function viewTechnician(record,body){
  const tr=make('tr');
  listCell(tr,record.technician_name||'Sin nombre','Responsable de equipos',true);
  listCell(tr,record.technician_document||'—');
  listCell(tr,Number(record.dispatch_count)||0);
  listCell(tr,Number(record.assigned_units)||0);
  listCell(tr,record.last_dispatch||'—');
  const actions=make('td');
  actions.append(actionButton('Ver despachos',()=>{
   activeTab='history';pageIndex=0;
   $('dispatch-search').value='';
   $('dispatch-technician-filter').value=record.technician_id;
   showTab();listView();
  }));
  tr.append(actions);body.append(tr);
 }
 function viewEquipment(record,body){
  const tr=make('tr');
  listCell(tr,record.technician_name||'—',record.technician_document||'',true);
  listCell(tr,record.sap_code,'',true);
  listCell(tr,record.sap_description||'—');
  listCell(tr,record.serial||'Sin serial');
  listCell(tr,Number(record.quantity)||0);
  listCell(tr,record.dispatch_date||'—');
  const actions=make('td');
  actions.append(actionButton('Ver detalle',()=>void openRecord(record.dispatch_id)));
  tr.append(actions);body.append(tr);
 }
 function showTab(){
  const config=tabConfig[activeTab];
  document.querySelectorAll('.dispatch-tab').forEach(button=>{
   const selected=button.dataset.tab===activeTab;
   button.classList.toggle('current',selected);
   button.setAttribute('aria-selected',String(selected));
  });
  t('dispatch-view-caption',config.title);
  $('dispatch-search').placeholder=config.search;
  $('dispatch-state-control').hidden=activeTab!=='recent';
  $('dispatch-technician-control').hidden=!(activeTab==='active'||activeTab==='history');
  $('dispatch-date-from-control').hidden=activeTab!=='history';
  $('dispatch-date-to-control').hidden=activeTab!=='history';
  const header=$('dispatch-list-head');header.replaceChildren();
  const row=make('tr');config.headers.forEach(name=>row.append(make('th',name)));
  header.append(row);
  t('dispatch-no-results',config.empty);
 }
 function viewRows(){
  const query=txt($('dispatch-search').value).toLowerCase();
  const selectedTech=$('dispatch-technician-filter').value;
  if(activeTab==='tech'){
   return technicianSummaries.filter(row=>matchAny([row.technician_name,row.technician_document],query))
    .sort((a,b)=>Number(b.assigned_units)-Number(a.assigned_units)||
      String(a.technician_name).localeCompare(String(b.technician_name),'es'));
  }
  if(activeTab==='active'){
   return activeEquipment.filter(row=>
    (!selectedTech||row.technician_id===selectedTech) &&
    matchAny([row.technician_name,row.technician_document,row.sap_code,
      row.sap_description,row.serial,row.reference],query)
   );
  }
  const state=$('dispatch-filter').value;
  const start=$('dispatch-date-from').value,end=$('dispatch-date-to').value;
  const equipmentMatches=query?new Set(activeEquipment.filter(row=>
   matchAny([row.sap_code,row.sap_description,row.serial],query)
  ).map(row=>row.dispatch_id)) : new Set();
  const result=records.filter(row=>{
   if(activeTab==='history'){
    if(row.status!=='DESPACHADO')return false;
    if(selectedTech&&row.technician_id!==selectedTech)return false;
    if(start&&(!row.dispatch_date||row.dispatch_date<start))return false;
    if(end&&(!row.dispatch_date||row.dispatch_date>end))return false;
   }else if(state&&row.status!==state)return false;
   return !query||matchAny([row.reference,row.technician_name,row.technician_document,
    row.warehouse_name,row.dispatch_date],query)||equipmentMatches.has(row.id);
  });
  return activeTab==='recent'?result.slice(0,12):result.sort((a,b)=>
   String(b.dispatch_date||'').localeCompare(String(a.dispatch_date||''))||
   String(b.created_at||'').localeCompare(String(a.created_at||'')));
 }
 function listView(){
  const rows=viewRows(),pageSize=activeTab==='recent'?12:15;
  const pageCount=Math.max(1,Math.ceil(rows.length/pageSize));
  pageIndex=Math.min(Math.max(0,pageIndex),pageCount-1);
  const body=$('dispatch-list');body.replaceChildren();
  const pageRows=rows.slice(pageIndex*pageSize,(pageIndex+1)*pageSize);
  for(const row of pageRows){
   if(activeTab==='tech')viewTechnician(row,body);
   else if(activeTab==='active')viewEquipment(row,body);
   else viewDispatch(row,body);
  }
  $('dispatch-no-results').hidden=rows.length>0;
  const label={recent:'movimientos recientes',tech:'técnicos',active:'equipos en uso',history:'despachos confirmados'}[activeTab];
  t('dispatch-result-count',rows.length+' '+label);
  t('dispatch-page-caption',rows.length?
   'Mostrando '+(pageIndex*pageSize+1)+' a '+Math.min((pageIndex+1)*pageSize,rows.length)+' de '+rows.length
   :'Sin resultados para esta vista');
  t('dispatch-page-number',(pageIndex+1)+' / '+pageCount);
  $('dispatch-page-prev').disabled=pageIndex<=0;
  $('dispatch-page-next').disabled=pageIndex>=pageCount-1;
  refreshKpis();
 }
 function warehouseLabel(warehouse){
  return warehouse.centro+' / '+warehouse.almacen+' · '+warehouse.description+
   ' ('+Number(warehouse.available_units||0)+' unidades disponibles)';
 }
 function warehouseNote(message,isWarning=false){
  const el=$('dispatch-warehouse-note');
  el.textContent=message;
  el.classList.toggle('warning',isWarning);
 }
 function unavailableWarehouse(id,name){
  if(!id||warehouses.some(w=>w.id===id))return false;
  const select=$('dispatch-warehouse');
  const option=new Option((name||'Bodega anterior')+' · SIN SALDO DISPONIBLE',id);
  option.disabled=true;
  select.add(option);select.value=id;
  warehouseNote('Esta bodega ya no tiene unidades disponibles para despachar. Selecciona otra.',true);
  return true;
 }
 function resetWarehouseNote(){
  if(!warehouses.length){
   warehouseNote('No hay bodegas propias con inventario disponible para despachar.',true);
  }else if($('dispatch-warehouse').selectedOptions[0]?.disabled&&$('dispatch-warehouse').value){
   warehouseNote('La bodega guardada se quedó sin saldo. Selecciona otra para continuar.',true);
  }else{
   warehouseNote('Solo se muestran bodegas propias con equipos o materiales disponibles.');
  }
 }
 async function reload(){
  const [result,cat,views]=await Promise.all([api(''),api('/catalogos'),api('/consultas')]);
  records=result.items||[];metrics=result.metrics||{};
  technicians=cat.technicians||[];warehouses=cat.warehouses||[];
  serials=cat.serials||[];bulk=cat.bulk||[];
  technicianSummaries=views.technicians||[];
  activeEquipment=views.equipment||[];
  const technicianChoices=$('dispatch-technician-filter'),existingTechnician=technicianChoices.value;
  technicianChoices.replaceChildren(new Option('Todos',''));
  for(const row of technicianSummaries)
   technicianChoices.add(new Option(row.technician_name+' · '+row.technician_document,row.technician_id));
  if([...technicianChoices.options].some(option=>option.value===existingTechnician))
   technicianChoices.value=existingTechnician;
  const choices=(id,rows,placeholder,label)=>{
   const sel=$(id),value=sel.value;
   sel.replaceChildren(new Option(placeholder,''));
   rows.forEach(row=>sel.add(new Option(label(row),row.id)));
   if([...sel.options].some(o=>o.value===value))sel.value=value;
  };
  choices('dispatch-tech',technicians,'Seleccionar técnico...',row=>row.full_name+' · '+row.document_number);
  const previousWarehouse=$('dispatch-warehouse').value;
  const previousLabel=$('dispatch-warehouse').selectedOptions[0]?.textContent||'Bodega anterior';
  choices('dispatch-warehouse',warehouses,
   warehouses.length?'Seleccionar bodega con saldo...':'No hay bodegas con saldo disponible',
   warehouseLabel);
  if(previousWarehouse)unavailableWarehouse(previousWarehouse,previousLabel.replace(/ · SIN SALDO DISPONIBLE$/,''));
  resetWarehouseNote();
  showTab();
  listView();
 }
 function currentDoc(){
  return {technician_id:$('dispatch-tech').value||null,warehouse_id:$('dispatch-warehouse').value||null,
   dispatch_date:$('dispatch-date').value,notes:txt($('dispatch-notes').value)};
 }
 const totals=()=>({lines:items.length,units:items.reduce((n,r)=>n+(Number(r.quantity)||0),0)});
 function counts(){
  const value=totals();t('dispatch-footer-text',value.lines+' ítems · '+value.units+' unidades');
 }
 function fieldSummary(container,data){
  container.replaceChildren();
  for(const [name,value] of data){
   const card=make('div');card.append(make('small',name),make('strong',value||'Pendiente'));
   container.append(card);
  }
 }
 function summaryData(){
  const person=technicians.find(x=>x.id===$('dispatch-tech').value);
  const w=warehouses.find(x=>x.id===$('dispatch-warehouse').value);
  return [
   ['Técnico',person?.full_name||'No seleccionado'],
   ['Identificación',person?.document_number||'No seleccionada'],
   ['Bodega de origen',w?w.centro+' / '+w.almacen+' · '+w.description:'No seleccionada'],
   ['Fecha del despacho',$('dispatch-date').value||'Sin fecha'],
   ['Ítems',items.length],
   ['Unidades',totals().units],
   ['Observaciones',$('dispatch-notes').value||'Sin observaciones']
  ];
 }
 function renderEquipmentTable(elementId){
  const body=$(elementId);body.replaceChildren();
  const stock=stockList();
  for(const item of items){
   const tr=make('tr'),found=stock.find(x=>x.sap_code===item.sap_code&&
    (item.serial?x.serial===item.serial:x.kind==='bulk'));
   for(const col of [item.sap_code,found?.description||'SAP',item.serial||'Sin serial',item.quantity])
    tr.append(make('td',col));
   body.append(tr);
  }
 }
 function renderSummary(){
  const count=totals();
  // Paso 3: solamente los equipos seleccionados, sin datos del técnico ni bodega.
  fieldSummary($('dispatch-review-counts'),[
   ['Ítems seleccionados',count.lines],['Unidades a asignar',count.units]
  ]);
  renderEquipmentTable('dispatch-review-items');
  // Paso 4: la revisión completa, incluida la lista final de equipos.
  fieldSummary($('dispatch-confirm-summary'),summaryData());
  renderEquipmentTable('dispatch-confirm-items');
 }
 function renderTech(){
  const person=technicians.find(x=>x.id===$('dispatch-tech').value);
  const el=$('dispatch-tech-summary');el.replaceChildren();
  if(!person){el.textContent='Selecciona un técnico en el paso anterior.';return;}
  el.append(make('strong',person.full_name),make('span','CC '+person.document_number),
   make('span','Departamento: '+(person.department||'—')),
   make('span','Zona / ciudad: '+(person.city_base||person.zone||'—')),
   make('span','Supervisor: '+(person.supervisor_name||'—')));
 }
 function renderStock(){
  const warehouse=$('dispatch-warehouse').value,query=txt($('dispatch-stock-search').value).toLowerCase();
  const selected=new Set(items.filter(i=>i.serial).map(i=>i.serial));
  const rowset=stockList().filter(r=>r.warehouse_id===warehouse &&
    (!query||[r.sap_code,r.description,r.serial].join(' ').toLowerCase().includes(query)));
  t('dispatch-stock-count',rowset.length+' disponibles en bodega');
  const target=$('dispatch-stock');target.replaceChildren();
  for(const row of rowset.slice(0,150)){
   const tr=make('tr');
   const add=value=>tr.append(make('td',value));
   add(row.sap_code);add(row.description);
   add(row.serial||'Sin serial');add(row.kind==='serial'?'1 unidad':row.quantity+' unidades');
   const qtyCell=make('td'),qty=make('input');
   qty.type='number';qty.min='1';qty.max=String(row.quantity);qty.step='1';qty.value='1';qty.className='dispatch-bulk-input';
   qty.disabled=row.kind==='serial';
   qty.setAttribute('aria-label','Cantidad a asignar de '+row.sap_code);
   qtyCell.append(qty);tr.append(qtyCell);
   const action=make('td'),addButton=make('button',selected.has(row.serial)&&row.serial?'Agregado':'＋ Agregar','dispatch-stock-add');
   addButton.type='button';addButton.disabled=!!row.serial&&selected.has(row.serial);
   addButton.addEventListener('click',()=>{
    const num=row.kind==='serial'?1:Number(qty.value);
    if(!Number.isInteger(num)||num<1||num>Number(row.quantity)){toast('Cantidad inválida o superior a la existencia.',true);return;}
    if(items.length>=500){toast('Un despacho admite máximo 500 filas.',true);return;}
    if(row.serial&&items.some(i=>i.serial===row.serial)){toast('El serial ya está seleccionado.',true);return;}
    const other=items.filter(i=>i.sap_code===row.sap_code&&!i.serial).reduce((s,i)=>s+Number(i.quantity),0);
    if(row.kind==='bulk'&&other+num>Number(row.quantity)){toast('No hay suficientes unidades disponibles de este SAP.',true);return;}
    items.push({sap_code:row.sap_code,serial:row.serial||'',quantity:num,notes:''});
    dirty=true;validation=null;renderStock();renderPicked();counts();toast('Ítem agregado al borrador.');
   });
   action.append(addButton);tr.append(action);target.append(tr);
  }
  $('dispatch-stock-empty').hidden=rowset.length!==0;
 }
 function renderPicked(){
  const target=$('dispatch-picked');target.replaceChildren();
  for(const [index,item] of items.entries()){
   const tr=make('tr'),found=stockList().find(x=>x.sap_code===item.sap_code&&
    (item.serial?x.serial===item.serial:x.kind==='bulk'));
   for(const text of [item.sap_code,found?.description||'SAP',item.serial||'Sin serial',item.quantity,item.notes||'—'])
    tr.append(make('td',text));
   const cell=make('td'),remove=make('button','× Quitar','dispatch-picked-remove');
   remove.type='button';remove.setAttribute('aria-label','Retirar ítem '+(index+1));
   remove.addEventListener('click',()=>{
    items.splice(index,1);dirty=true;validation=null;renderPicked();renderStock();counts();
   });
   cell.append(remove);tr.append(cell);target.append(tr);
  }
  $('dispatch-picked-empty').hidden=items.length!==0;
  counts();
 }
 function setStep(next){
  step=next;
  for(let n=1;n<=4;n++){
   const node=$('dispatch-step-'+(['one','two','three','four'][n-1]));
   node.hidden=n!==next;
  }
  for(const button of document.querySelectorAll('#dispatch-wizard .ingress-step')){
   const n=Number(button.dataset.step);
   button.classList.toggle('current',n===next);
   button.classList.toggle('done',n<next);
   if(n===next)button.setAttribute('aria-current','step');else button.removeAttribute('aria-current');
  }
  $('dispatch-prev').hidden=next===1;
  $('dispatch-next').hidden=next===4;
  $('dispatch-confirm').hidden=next!==4;
  renderTech();renderStock();renderPicked();renderSummary();
  $('dispatch-errors').hidden=true;
  $('dispatch-ack').checked=false;
 }
 async function begin(mode='manual'){
  if(busy)return;busy=true;
  try{
   await reload();
   const created=await api('',{method:'POST'});
   dispatchId=created.id;dispatchStatus='BORRADOR';
   currentMode=mode;items=[];dirty=false;validation=null;
   $('dispatch-tech').value='';$('dispatch-warehouse').value='';
   $('dispatch-date').value=dateLocal();$('dispatch-notes').value='';
   $('dispatch-stock-search').value='';
   t('dispatch-ref','Borrador · '+created.id.slice(0,8));
   t('dispatch-wizard-title',mode==='excel'?'Cargar despacho desde Excel':'Nuevo despacho a técnico');
   display('wizard');setStep(1);
   toast(mode==='excel'?'Selecciona el técnico y la bodega. En Equipos podrás cargar el Excel.':'Borrador creado. Selecciona técnico y bodega.');
  }catch(err){toast(err.message,true);}finally{busy=false;}
 }
 function showValidation(result){
  const el=$('dispatch-errors');el.replaceChildren();
  const issues=result?.errors||[];
  if(!issues.length){el.hidden=true;return;}
  el.hidden=false;
  el.append(make('strong','Se encontraron '+issues.length+' errores:'));
  for(const issue of issues.slice(0,18))el.append(make('span','• '+issue.message));
  if(issues.length>18)el.append(make('span','Hay más errores. Corrige el Excel o los ítems.'));
 }
 async function saveDraft(silent=false){
  if(!dispatchId||dispatchStatus!=='BORRADOR')return false;
  try{
   const doc=currentDoc();
   const result=await api('/'+dispatchId,{method:'PATCH',data:{...doc,items}});
   dirty=false;validation=result.validation;
   t('dispatch-save-status','Borrador guardado');
   showValidation(validation);
   if(!silent)toast('Borrador guardado. Aún no afecta las existencias.');
   return true;
  }catch(err){toast(err.message,true);return false;}
 }
 async function next(){
  if(busy)return;busy=true;
  try{
   if(step===1){
    if(!currentDoc().technician_id||!currentDoc().warehouse_id||!currentDoc().dispatch_date){
     toast('Selecciona técnico, una bodega con saldo disponible y fecha para continuar.',true);return;
    }
    if(!warehouses.some(w=>w.id===currentDoc().warehouse_id)){
     resetWarehouseNote();
     toast('La bodega seleccionada no tiene saldo disponible. Elige una con existencias.',true);return;
    }
    if(!await saveDraft(true))return;
    setStep(2);
    if(currentMode==='excel')toast('Puedes cargar la plantilla desde Excel o seleccionar equipos disponibles.');
   }else if(step===2){
    if(items.length===0){toast('Agrega al menos un equipo.',true);return;}
    if(!await saveDraft(true))return;
    if(!validation?.valid){showValidation(validation);toast('Corrige los errores detectados antes de avanzar.',true);return;}
    setStep(3);
   }else if(step===3){setStep(4);}
  }finally{busy=false;}
 }
 async function confirmDispatch(){
  if(busy)return;
  if(!$('dispatch-ack').checked){toast('Confirma que revisaste toda la asignación.',true);return;}
  busy=true;
  try{
   if(dirty&&!await saveDraft(true))return;
   const result=await api('/'+dispatchId+'/confirmar',{method:'POST'});
   await reload();
   busy=false;
   await openRecord(result.id);
   toast('Despacho '+result.reference+' registrado. Los seriales ya están asignados al técnico.');
  }catch(err){
   if(err.details?.validation)showValidation(err.details.validation);
   toast(err.message,true);
  }finally{busy=false;}
 }
 async function openRecord(id){
  if(busy)return;busy=true;
  try{
   await reload();
   const result=await api('/'+id);
   dispatchId=id;dispatchStatus=result.document.status;
   if(dispatchStatus==='DESPACHADO'){
    showDetail(result);display('detail');
   }else{
    const doc=result.document;
    $('dispatch-tech').value=doc.technician_id||'';
    $('dispatch-warehouse').value=doc.warehouse_id||'';
    const depleted=unavailableWarehouse(doc.warehouse_id,
      [doc.centro,doc.almacen].filter(Boolean).join(' / ')+' · '+(doc.warehouse_name||'Bodega anterior'));
    resetWarehouseNote();
    $('dispatch-date').value=doc.dispatch_date||dateLocal();
    $('dispatch-notes').value=doc.notes||'';
    items=(result.items||[]).map(it=>({sap_code:it.sap_code,serial:it.serial||'',quantity:Number(it.quantity),notes:it.notes||''}));
    dirty=false;validation=result.validation;
    t('dispatch-ref',doc.reference||'Borrador · '+id.slice(0,8));
    t('dispatch-wizard-title','Continuar despacho a técnico');
    currentMode='manual';display('wizard');setStep(1);
    if(depleted)toast('La bodega de este borrador ya no tiene saldo. Selecciona otra bodega para continuar.',true);
   }
  }catch(err){toast(err.message,true);}finally{busy=false;}
 }
 function showDetail(response){
  const d=response.document,rows=response.items||[];
  const summary=$('dispatch-detail-summary');summary.replaceChildren();
  const fields=[
   ['Despacho',d.reference||'—'],
   ['Técnico responsable',(d.technician_name||'—')+' · '+(d.technician_document||'')],
   ['Fecha de despacho',d.dispatch_date||'—'],
   ['Bodega origen',(d.centro||'')+' / '+(d.almacen||'')+' · '+(d.warehouse_name||'')],
   ['Observaciones',d.notes||'Sin observaciones']
  ];
  for(const [label,value] of fields){
   const card=make('div');card.append(make('small',label),make('strong',value));summary.append(card);
  }
  const total=rows.reduce((n,x)=>n+Number(x.quantity||0),0);
  t('dispatch-detail-totals',rows.length+' ítems · '+total+' unidades');
  const body=$('dispatch-detail-items');body.replaceChildren();
  for(const [i,x] of rows.entries()){
   const tr=make('tr');
   for(const v of [i+1,x.sap_code,x.sap_description||'—',x.serial||'Sin serial',
    x.quantity,x.lot||'Sin clasificar',x.physical_state||'Bueno'])tr.append(make('td',v));
   body.append(tr);
  }
 }
 async function home(){
  if(busy)return;
  if(!$('dispatch-wizard').hidden&&dirty){
   if(!window.confirm('Hay cambios sin guardar. ¿Salir y descartarlos?'))return;
  }
  busy=true;
  try{await reload();dispatchId='';display('home');}
  catch(err){toast(err.message,true);}finally{busy=false;}
 }
 async function deleteRecord(record,button){
  if(busy||record.status!=='BORRADOR')return;
  if(!window.confirm('¿Eliminar definitivamente el borrador '+(record.reference||record.technician_name||'sin referencia')+'?\nSe borrarán sus ítems. No se afectarán las existencias.'))return;
  busy=true;button.disabled=true;
  try{
   await api('/'+record.id,{method:'DELETE'});
   records=records.filter(x=>x.id!==record.id);listView();
   await reload();toast('Borrador eliminado. Inventario sin cambios.');
  }catch(err){toast(err.message,true);}finally{busy=false;button.disabled=false;}
 }
 function excelCell(cell){
  const value=cell?.value;
  if(value===null||value===undefined)return '';
  if(typeof value==='object'){
   if(value.text!==undefined)return String(value.text).trim();
   if(value.result!==undefined)return String(value.result).trim();
   return '';
  }
  return String(value).trim();
 }
 async function importExcel(file){
  if(!file)return;
  if(!window.ExcelJS){toast('No se pudo cargar el lector de Excel.',true);return;}
  try{
   const book=new ExcelJS.Workbook();
   await book.xlsx.load(await file.arrayBuffer());
   const sheet=book.worksheets[0];
   if(!sheet)throw new Error('El Excel no contiene una hoja válida.');
   const cols=['Código SAP','Serial','Cantidad','Observaciones'];
   if(!cols.every((h,i)=>excelCell(sheet.getRow(1).getCell(i+1))===h))
    throw new Error('Usa la plantilla de Despachos con sus cuatro encabezados.');
   const parsed=[];
   for(let row=2;row<=sheet.rowCount;row++){
    const values=cols.map((h,i)=>excelCell(sheet.getRow(row).getCell(i+1)));
    if(values.every(v=>v===''))continue;
    if(!values[0])throw new Error('Fila '+row+': falta el código SAP.');
    const qty=Number(values[2]);
    if(!Number.isInteger(qty)||qty<1||qty>1000000)throw new Error('Fila '+row+': cantidad inválida.');
    parsed.push({sap_code:upper(values[0]),serial:upper(values[1]),quantity:qty,notes:values[3]});
   }
   if(!parsed.length)throw new Error('La plantilla no contiene ítems.');
   if(parsed.length>500)throw new Error('Máximo 500 filas por despacho.');
   if(items.length&&!confirm('Esta importación reemplazará los ítems de este borrador. ¿Continuar?'))return;
   items=parsed;dirty=true;validation=null;
   renderStock();renderPicked();counts();
   toast(parsed.length+' filas cargadas. Pulsa «Guardar borrador» y después «Siguiente» para validar seriales y existencias.');
  }catch(err){toast(err.message,true);}
  finally{$('dispatch-excel-file').value='';}
 }
 async function template(){
  if(!window.ExcelJS){toast('No se cargó el componente Excel.',true);return;}
  try{
   const book=new ExcelJS.Workbook(),ws=book.addWorksheet('Despachos',{views:[{state:'frozen',ySplit:1,showGridLines:false}]});
   ws.columns=[{header:'Código SAP',key:'sap',width:23},{header:'Serial',key:'serial',width:36},
    {header:'Cantidad',key:'qty',width:16},{header:'Observaciones',key:'notes',width:44}];
   ws.getRow(1).height=28;
   ws.getRow(1).eachCell(c=>{
    c.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF075A47'}};
    c.font={bold:true,color:{argb:'FFFFFFFF'},size:11};c.alignment={vertical:'middle'};
   });
   ws.autoFilter={from:{row:1,column:1},to:{row:1,column:4}};
   ws.getColumn(1).numFmt='@';ws.getColumn(2).numFmt='@';ws.getColumn(3).numFmt='0';
   const data=await book.xlsx.writeBuffer();
   const url=URL.createObjectURL(new Blob([data],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
   const a=document.createElement('a');a.href=url;a.download='PULSO_Plantilla_Despachos_a_tecnicos.xlsx';
   document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }catch(err){toast(err.message,true);}
 }
 function wire(){
  $('dispatch-search').addEventListener('input',()=>{pageIndex=0;listView();});
  $('dispatch-filter').addEventListener('change',()=>{pageIndex=0;listView();});
  $('dispatch-technician-filter').addEventListener('change',()=>{pageIndex=0;listView();});
  $('dispatch-date-from').addEventListener('change',()=>{pageIndex=0;listView();});
  $('dispatch-date-to').addEventListener('change',()=>{pageIndex=0;listView();});
  $('dispatch-page-prev').addEventListener('click',()=>{pageIndex=Math.max(0,pageIndex-1);listView();});
  $('dispatch-page-next').addEventListener('click',()=>{pageIndex++;listView();});
  $('dispatch-stock-search').addEventListener('input',renderStock);
  $('dispatch-new').addEventListener('click',()=>void begin('manual'));
  $('dispatch-back').addEventListener('click',()=>void home());
  $('dispatch-detail-back').addEventListener('click',()=>void home());
  $('dispatch-change-tech').addEventListener('click',()=>setStep(1));
  $('dispatch-tech').addEventListener('change',()=>{dirty=true;renderTech();});
  $('dispatch-warehouse').addEventListener('change',()=>{dirty=true;resetWarehouseNote();renderStock();});
  $('dispatch-date').addEventListener('change',()=>{dirty=true;});
  $('dispatch-notes').addEventListener('input',()=>{dirty=true;});
  $('dispatch-save').addEventListener('click',()=>void saveDraft());
  $('dispatch-next').addEventListener('click',()=>void next());
  $('dispatch-prev').addEventListener('click',()=>setStep(Math.max(1,step-1)));
  $('dispatch-confirm').addEventListener('click',()=>void confirmDispatch());
  $('dispatch-import-button').addEventListener('click',()=>$('dispatch-excel-file').click());
  $('dispatch-excel-file').addEventListener('change',e=>void importExcel(e.target.files?.[0]));
  $('dispatch-download-template').addEventListener('click',()=>void template());
  document.querySelectorAll('#dispatch-wizard .ingress-step').forEach(btn=>
   btn.addEventListener('click',()=>{const target=Number(btn.dataset.step);if(target<step)setStep(target);}));
  document.querySelectorAll('.dispatch-tab').forEach(btn=>btn.addEventListener('click',()=>{
   activeTab=btn.dataset.tab;pageIndex=0;
   showTab();listView();
  }));
  window.addEventListener('beforeunload',e=>{
   if(dirty&&!$('dispatch-wizard').hidden){e.preventDefault();e.returnValue='';}
  });
 }
 wire();
 void reload().catch(err=>toast(err.message,true));
})();
