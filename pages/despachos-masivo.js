'use strict';
/* Carga multi-técnico. Una sola validación global y una única confirmación atómica. */
(()=>{
 const $=id=>document.getElementById(id);
 const make=(tag,value,cls)=>{
  const el=document.createElement(tag);if(value!==undefined)el.textContent=String(value);
  if(cls)el.className=cls;return el;
 };
 const HEADERS=['Identificación técnico','Centro','Almacén','Fecha de despacho',
  'Código SAP','Serial','Cantidad','Observaciones'];
 const FIELDS=['technician_document','centro','almacen','dispatch_date','sap_code','serial','quantity','notes'];
 let payload=null,preview=null,busy=false,confirmed=false;
 const status=text=>$('dispatch-mass-status').textContent=text;
 function alertMessage(message,isError=true){
  const container=$('dispatch-mass-alert');container.textContent=message||'';
  container.classList.toggle('error',isError);container.hidden=!message;
 }
 async function api(path,data){
  const response=await fetch('/api/despachos/masivo/'+path,{
   method:'POST',credentials:'same-origin',cache:'no-store',
   headers:{'Content-Type':'application/json'},body:JSON.stringify(data)
  });
  if(response.status===401){location.assign('/main');throw Error('La sesión ha caducado.');}
  if(response.status===403){location.assign('/inicio');throw Error('No tienes permisos para realizar esta operación.');}
  const body=await response.json().catch(()=>({error:'RESPUESTA_INVALIDA'}));
  if(!response.ok||body.ok===false){
   const text=body.error==='CARGA_MASIVA_REVALIDAR'
    ?'El inventario cambió durante la confirmación. No se registró ningún despacho de esta carga. Carga y valida de nuevo el archivo.'
    :body.error==='LOTE_YA_UTILIZADO'
     ?'Este identificador de carga ya fue utilizado con otro archivo.'
     :body.error==='CARGA_MASIVA_INVALIDA'
      ?'La validación encontró errores. No se ha confirmado ningún despacho.'
      :body.error||'No se completó la solicitud.';
   const error=Error(text);error.response=body;throw error;
  }
  return body;
 }
 function hideOtherScreens(){
  for(const id of ['dispatch-home','dispatch-wizard','dispatch-detail'])$(id).hidden=true;
 }
 function reset(){
  payload=null;preview=null;confirmed=false;busy=false;
  $('dispatch-mass-file').value='';
  $('dispatch-mass-file-name').textContent='Ningún archivo seleccionado · Máximo 500 filas y 100 despachos por carga.';
  $('dispatch-mass-preview').hidden=true;
  $('dispatch-mass-success').hidden=true;
  $('dispatch-mass-ack').checked=false;
  $('dispatch-mass-ack').disabled=true;
  $('dispatch-mass-confirm').disabled=true;
  $('dispatch-mass-confirm').textContent='Confirmar todos los despachos';
  alertMessage('');
  status('Sin archivo');
 }
 function open(){
  reset();hideOtherScreens();$('dispatch-mass').hidden=false;
  $('dispatch-mass').scrollIntoView({block:'start',behavior:'auto'});
 }
 function cellText(cell,index){
  const v=cell.value;
  if(v===null||v===undefined)return '';
  if(v instanceof Date){
   if(index===3)return v.toISOString().slice(0,10);
   return '';
  }
  if(typeof v==='object'){
   if(v.text!==undefined)return String(v.text).trim();
   if(v.result!==undefined)return String(v.result).trim();
   return '';
  }
  if(typeof v==='number'&&[0,1,2,4,5].includes(index)){
   // No aceptar identificaciones, SAP ni seriales numéricos sin formato texto:
   // Excel puede haber eliminado ceros iniciales o alterado seriales largos.
   throw Error('La fila '+cell.row+': la identificación, el SAP y el serial deben almacenarse como TEXTO en Excel.');
  }
  return String(v).trim();
 }
 async function parseExcel(file){
  if(!window.ExcelJS)throw Error('No se cargó ExcelJS. Actualiza PULSO e inténtalo de nuevo.');
  if(!file||!/\.xlsx$/i.test(file.name))throw Error('Solo se admiten archivos Excel .xlsx.');
  if(file.size>6*1024*1024)throw Error('El Excel supera el límite de 6 MB.');
  const book=new ExcelJS.Workbook();
  await book.xlsx.load(await file.arrayBuffer());
  const sheet=book.worksheets[0];
  if(!sheet)throw Error('El archivo no contiene una hoja de Despachos.');
  for(let index=0;index<HEADERS.length;index++){
   if(String(sheet.getRow(1).getCell(index+1).value||'').trim()!==HEADERS[index])
    throw Error('La plantilla no coincide. Descarga la plantilla de Despachos masivos y conserva los 8 encabezados.');
  }
  if(sheet.rowCount>2500)throw Error('El Excel tiene demasiadas filas. Máximo 500 ítems por carga.');
  const items=[];
  for(let n=2;n<=sheet.rowCount;n++){
   const cells=HEADERS.map((h,i)=>cellText(sheet.getRow(n).getCell(i+1),i));
   if(cells.every(x=>!x))continue;
   if(items.length>=500)throw Error('El Excel supera las 500 filas permitidas.');
   const row=Object.fromEntries(FIELDS.map((f,i)=>[f,cells[i]]));
   // Conservar códigos como texto para que coincidan con las Maestras.
   row.technician_document=row.technician_document.toUpperCase();
   row.centro=row.centro.toUpperCase();row.almacen=row.almacen.toUpperCase();
   row.sap_code=row.sap_code.toUpperCase();row.serial=row.serial.toUpperCase();
   row.quantity=row.quantity===''?0:Number(row.quantity);
   items.push(row);
  }
  if(!items.length)throw Error('El archivo no contiene equipos o materiales para asignar.');
  return items;
 }
 function renderErrors(errors){
  const list=$('dispatch-mass-errors');list.replaceChildren();
  list.hidden=!errors.length;
  if(!errors.length)return;
  list.append(make('strong','No se puede confirmar: '+errors.length+' errores detectados.'));
  const entries=make('ul');
  for(const item of errors){
   entries.append(make('li',(item.row?'Fila '+item.row+' · ':'')+
    (item.field?item.field+': ':'')+item.message));
  }
  list.append(entries);
 }
 function renderGroups(groups){
  const area=$('dispatch-mass-groups');area.replaceChildren();
  for(const [index,group] of groups.entries()){
   const container=make('details',undefined,'dispatch-mass-group');
   container.open=true;
   const summary=make('summary');
   const title=make('strong',(index+1)+'. '+group.technician_name+' · CC '+group.technician_document);
   const subtitle=make('span',group.warehouse_label+' · '+group.dispatch_date);
   const metrics=make('span',group.item_count+' ítems · '+group.units+' unidades','dispatch-soft-badge');
   const text=make('div');text.append(title,subtitle);
   summary.append(text,metrics);container.append(summary);
   const wrap=make('div',undefined,'ingress-table-wrap dispatch-mass-group-table');
   const table=make('table',undefined,'ingress-table'),head=make('thead'),headRow=make('tr');
   for(const label of ['Fila','SAP','Descripción','Serial','Cantidad','Observaciones'])
    headRow.append(make('th',label));
   head.append(headRow);
   const body=make('tbody');
   for(const item of group.items||[]){
    const tr=make('tr');
    for(const value of [item.line,item.sap_code,item.sap_description||'—',
     item.serial||'Sin serial',item.quantity,item.notes||'—'])tr.append(make('td',value));
    body.append(tr);
   }
   table.append(head,body);wrap.append(table);container.append(wrap);
   area.append(container);
  }
 }
 function renderPreview(data){
  $('dispatch-mass-preview').hidden=false;
  const metrics=data.totals||{};
  $('dispatch-mass-techs').textContent=metrics.technicians||0;
  $('dispatch-mass-dispatches').textContent=metrics.dispatches||0;
  $('dispatch-mass-lines').textContent=metrics.lines||0;
  $('dispatch-mass-units').textContent=metrics.units||0;
  $('dispatch-mass-preview-state').textContent=data.valid?'Validación correcta':'Con errores';
  $('dispatch-mass-preview-state').classList.toggle('invalid',!data.valid);
  renderGroups(data.groups||[]);
  renderErrors(data.errors||[]);
  $('dispatch-mass-ack').disabled=!data.valid;
  $('dispatch-mass-ack').checked=false;
  $('dispatch-mass-confirm').disabled=true;
 }
 async function onFile(file){
  if(busy||!file)return;
  busy=true;payload=null;preview=null;confirmed=false;
  $('dispatch-mass-confirm').disabled=true;
  $('dispatch-mass-preview').hidden=true;
  $('dispatch-mass-success').hidden=true;
  alertMessage('');
  status('Leyendo Excel...');
  try{
   const rows=await parseExcel(file);
   payload={operation_id:crypto.randomUUID(),rows};
   $('dispatch-mass-file-name').textContent=file.name+' · '+rows.length+' filas';
   status('Validando existencias...');
   preview=await api('validar',payload);
   renderPreview(preview);
   status(preview.valid?'Validado · Sin movimientos':'Errores de validación');
   if(preview.valid)alertMessage('Validación correcta. Ningún equipo ha salido del inventario todavía.',false);
   else alertMessage('Corrige los errores del Excel y vuelve a cargarlo. No se ha registrado ningún despacho.');
  }catch(error){
   payload=null;
   status('Archivo inválido');
   alertMessage(error.message);
  }finally{
   busy=false;$('dispatch-mass-file').value='';
   $('dispatch-mass-preview').hidden=!preview;
  }
 }
 function renderSuccess(result){
  confirmed=true;payload=null;
  $('dispatch-mass-preview').hidden=true;
  $('dispatch-mass-success').hidden=false;
  $('dispatch-mass-confirm').disabled=true;
  $('dispatch-mass-ack').disabled=true;
  const totals=result.totals||{};
  $('dispatch-mass-success-text').textContent=
   'Se registraron '+totals.dispatches+' despachos para '+totals.technicians+
   ' técnicos, con '+totals.lines+' ítems y '+totals.units+' unidades. No se requiere otra confirmación.';
  status('✓ Confirmado');
  alertMessage('');
  const body=$('dispatch-mass-success-list');body.replaceChildren();
  for(const row of result.dispatches||[]){
   const tr=make('tr');
   for(const text of [row.reference,row.technician_name,row.centro+' / '+row.almacen,
    row.dispatch_date,row.item_count,row.units])tr.append(make('td',text));
   body.append(tr);
  }
  $('dispatch-mass-success').scrollIntoView({block:'start',behavior:'smooth'});
 }
 async function confirmAll(){
  if(busy||confirmed||!preview?.valid||!payload||!$('dispatch-mass-ack').checked)return;
  if(!confirm('¿Confirmar '+preview.totals.dispatches+' despachos para '+preview.totals.technicians+
    ' técnicos y '+preview.totals.units+' unidades?\n\nSe registrarán TODOS en una sola operación y no podrán editarse.'))return;
  busy=true;const button=$('dispatch-mass-confirm');
  button.disabled=true;button.textContent='Confirmando todos los despachos...';
  status('Confirmando...');
  try{
   const result=await api('confirmar',payload);
   renderSuccess(result);
  }catch(error){
   if(error.response?.validation){
    preview={...preview,valid:false,
     errors:error.response.validation.errors||[],totals:error.response.validation.totals||preview.totals};
    renderPreview(preview);
   }else{
    // Si se perdió la respuesta, reintentar con el mismo ID es seguro.
    button.disabled=false;
   }
   status('Revisar confirmación');
   alertMessage(error.message+(preview?.valid?' Puedes reintentar con el mismo archivo sin duplicar despachos.':''));
  }finally{
   busy=false;
   if(!confirmed){
    button.textContent='Confirmar todos los despachos';
    button.disabled=!preview?.valid||!$('dispatch-mass-ack').checked;
   }
  }
 }
 async function download(){
  if(!window.ExcelJS){alertMessage('No se cargó el lector de Excel.');return;}
  try{
   const book=new ExcelJS.Workbook();
   const sheet=book.addWorksheet('Despachos masivos',{views:[{state:'frozen',ySplit:1,showGridLines:false}]});
   sheet.columns=[
    {header:HEADERS[0],key:FIELDS[0],width:28},
    {header:HEADERS[1],key:FIELDS[1],width:18},
    {header:HEADERS[2],key:FIELDS[2],width:18},
    {header:HEADERS[3],key:FIELDS[3],width:22},
    {header:HEADERS[4],key:FIELDS[4],width:23},
    {header:HEADERS[5],key:FIELDS[5],width:36},
    {header:HEADERS[6],key:FIELDS[6],width:14},
    {header:HEADERS[7],key:FIELDS[7],width:45}
   ];
   const header=sheet.getRow(1);header.height=30;
   header.eachCell(cell=>{
    cell.font={name:'Calibri',size:11,bold:true,color:{argb:'FFFFFFFF'}};
    cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF075A47'}};
    cell.alignment={vertical:'middle'};
    cell.border={bottom:{style:'thin',color:{argb:'FFEEA332'}}};
   });
   for(const index of [1,2,3,4,5,6,8])sheet.getColumn(index).numFmt='@';
   sheet.getColumn(7).numFmt='0';
   sheet.autoFilter={from:{row:1,column:1},to:{row:1,column:8}};
   const guide=book.addWorksheet('Instrucciones');
   guide.columns=[{width:30},{width:94}];
   const lines=[
    ['PULSO · Despachos masivos','Una fila por serial o por ítem sin serial.'],
    ['Identificación técnico','Cédula exacta del técnico activo en Maestras. Guardar como TEXTO.'],
    ['Centro / Almacén','Códigos de la bodega propia con existencias disponibles.'],
    ['Fecha de despacho','Formato de texto AAAA-MM-DD. Ejemplo: 2026-11-07.'],
    ['Código SAP','SAP exacto de Equipos y materiales, como texto.'],
    ['Serial','Obligatorio para SAP con perfil de serie. Mantener ceros iniciales.'],
    ['Cantidad','Número entero positivo. Si hay serial debe ser siempre 1.'],
    ['Observaciones','Opcional, máximo 240 caracteres por fila.'],
    ['Agrupación','Cada combinación de técnico, bodega y fecha crea UN despacho.'],
    ['Confirmación','Se confirma el archivo completo o se rechaza sin registrar nada.'],
    ['Límite','Máximo 500 filas / 100 despachos por Excel.']
   ];
   for(const [a,b] of lines){const row=guide.addRow([a,b]);row.getCell(1).font={bold:true,color:{argb:'FF075A47'}};row.height=24;}
   const data=await book.xlsx.writeBuffer();
   const url=URL.createObjectURL(new Blob([data],{
    type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
   }));
   const a=document.createElement('a');a.href=url;
   a.download='PULSO_Plantilla_Despachos_Masivos_Tecnicos.xlsx';
   document.body.append(a);a.click();a.remove();
   setTimeout(()=>URL.revokeObjectURL(url),1000);
   alertMessage('Plantilla descargada. Diligencia la primera hoja sin modificar los encabezados.',false);
  }catch(err){alertMessage(err.message);}
 }
 function wire(){
  $('dispatch-mass-open').addEventListener('click',open);
  $('dispatch-mass-back').addEventListener('click',()=>{
   if(busy)return;
   if(payload&&!confirmed&&!confirm('¿Salir de la carga masiva sin confirmar? No se ha despachado nada.'))return;
   location.assign('/despachos');
  });
  $('dispatch-mass-template').addEventListener('click',()=>void download());
  $('dispatch-mass-upload').addEventListener('click',()=>$('dispatch-mass-file').click());
  $('dispatch-mass-file').addEventListener('change',event=>void onFile(event.target.files?.[0]));
  $('dispatch-mass-ack').addEventListener('change',()=>{
   $('dispatch-mass-confirm').disabled=busy||confirmed||!preview?.valid||!$('dispatch-mass-ack').checked;
  });
  $('dispatch-mass-confirm').addEventListener('click',()=>void confirmAll());
  $('dispatch-mass-done').addEventListener('click',()=>location.assign('/despachos'));
 }
 wire();
})();
