'use strict';
/* Apertura única de inventario. No crea saldos hasta la confirmación completa. */
(()=>{
 const $=id=>document.getElementById(id);
 const make=(tag,value,cls)=>{const el=document.createElement(tag);
  if(value!==undefined)el.textContent=String(value);if(cls)el.className=cls;return el;};
 const labels=['Centro','Almacén','Código SAP','Serial','Cantidad','Lote','Estado de Recepción','Observaciones'];
 const keys=['centro','almacen','sap_code','serial','quantity','lot','reception_state','notes'];
 let content=null,preview=null,busy=false,done=false;
 function banner(message,error=false){
  const b=$('opening-errors-banner');b.textContent=message||'';b.hidden=!message;b.classList.toggle('error',error);
 }
 function stateMessage(text,warning=false){
  const p=$('opening-state-message');p.textContent=text;p.classList.toggle('warning',warning);
 }
 async function api(path,{method='GET',data=null}={}){
  const res=await fetch('/api/saldos-iniciales'+path,{
   method,credentials:'same-origin',cache:'no-store',
   headers:data?{'Content-Type':'application/json'}:{},
   ...(data?{body:JSON.stringify(data)}:{})
  });
  if(res.status===401){location.assign('/main');throw Error('Sesión caducada.');}
  if(res.status===403){location.assign('/inicio');throw Error('No tienes permisos para registrar el saldo inicial.');}
  const body=await res.json().catch(()=>({error:'RESPUESTA_INVALIDA'}));
  if(!res.ok||body.ok===false){
   const messages={
    APERTURA_YA_REALIZADA:'El saldo inicial ya fue registrado. Esta carga única está bloqueada.',
    APERTURA_REQUIERE_INVENTARIO_VACIO:'Se detectaron operaciones nuevas. La apertura solo puede realizarse antes de crear Ingresos o Despachos.',
    APERTURA_INVALIDA:'La validación encontró errores. No se registró ningún ítem.',
    APERTURA_NO_CONFIRMADA:'No se pudo confirmar la apertura. Verifica los datos antes de reintentar.',
    SOLICITUD_DEMASIADO_GRANDE:'El archivo supera el límite de tamaño de la carga inicial.'
   };
   const e=Error(messages[body.error]||body.error||'No se completó la solicitud.');
   e.details=body;throw e;
  }
  return body;
 }
 function finish(result){
  done=true;
  $('opening-form').hidden=true;
  $('opening-complete').hidden=false;
  $('opening-confirm').disabled=true;
  $('opening-ack').disabled=true;
  const total=result?.totals||result?.record||{};
  $('opening-complete-label').textContent='Se registraron '+Number(total.units||0)+
   ' unidades en '+Number(total.warehouses??total.documents??0)+' bodegas. Esta apertura ya no puede repetirse.';
  const list=$('opening-complete-docs');list.replaceChildren();
  for(const record of result?.documents||[]){
   const p=make('p',(record.warehouse_name||record.document_number)+' · '+(record.reference||'Registrado'));
   list.append(p);
  }
  stateMessage('✓ Saldos iniciales registrados. Las siguientes existencias se incorporarán mediante Ingresos.');
 }
 async function loadState(){
  const state=await api('/estado');
  if(state.completed){finish(state);return;}
  if(state.blocked){
   $('opening-form').hidden=true;
   stateMessage('La apertura está bloqueada porque ya hay movimientos de Ingresos o Despachos. No se permite mezclar saldos iniciales con operaciones posteriores.',true);
   return;
  }
  $('opening-form').hidden=false;
  stateMessage('Apertura disponible una sola vez. Descarga la plantilla, verifica los saldos y confirma únicamente cuando esté completa.');
 }
 function excelValue(cell,index,rowNumber){
  const value=cell.value;
  if(value===null||value===undefined)return '';
  if(value instanceof Date)return value.toISOString().slice(0,10);
  if(typeof value==='object'){
   if(value.text!==undefined)return String(value.text).trim();
   if(value.result!==undefined)return String(value.result).trim();
   return '';
  }
  if(typeof value==='number'){
   if(!Number.isSafeInteger(value)||value>1e15)
    throw Error('Fila '+rowNumber+': dato numérico demasiado largo. Escribe códigos y seriales como TEXTO.');
   if([0,1,2,3].includes(index)&&!Number.isInteger(value))
    throw Error('Fila '+rowNumber+': código o serial numérico no válido.');
  }
  return String(value).trim();
 }
 async function parse(file){
  if(!window.ExcelJS)throw Error('No se cargó ExcelJS. Actualiza PULSO.');
  if(!file||!/\.xlsx$/i.test(file.name))throw Error('Solo archivos .xlsx.');
  if(file.size>8*1024*1024)throw Error('El archivo supera 8 MB.');
  const book=new ExcelJS.Workbook();
  await book.xlsx.load(await file.arrayBuffer());
  const sheet=book.worksheets[0];
  if(!sheet)throw Error('El archivo está vacío.');
  for(let i=0;i<labels.length;i++){
   if(String(sheet.getRow(1).getCell(i+1).value||'').trim()!==labels[i])
    throw Error('Encabezados incorrectos. Descarga la plantilla oficial y no cambies sus columnas.');
  }
  if(sheet.rowCount>4000)throw Error('Máximo 2.500 registros de inventario.');
  const rows=[];
  for(let r=2;r<=sheet.rowCount;r++){
   const values=labels.map((l,i)=>excelValue(sheet.getRow(r).getCell(i+1),i,r));
   if(values.every(v=>!v))continue;
   if(rows.length>=2500)throw Error('El límite es 2.500 registros por apertura.');
   const record=Object.fromEntries(keys.map((k,i)=>[k,values[i]]));
   record.quantity=Number(values[4]);
   rows.push(record);
  }
  if(!rows.length)throw Error('La plantilla no contiene existencias.');
  return rows;
 }
 async function download(){
  if(!window.ExcelJS){banner('No se pudo cargar el lector de Excel.',true);return;}
  try{
   const book=new ExcelJS.Workbook(),sheet=book.addWorksheet('Saldos iniciales',{
    views:[{state:'frozen',ySplit:1,showGridLines:false}]});
   sheet.columns=labels.map((label,index)=>({header:label,key:keys[index],
    width:[15,15,23,35,16,18,25,46][index]}));
   sheet.getRow(1).height=28;
   sheet.getRow(1).eachCell(cell=>{
    cell.font={bold:true,color:{argb:'FFFFFFFF'},size:11};
    cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF075A47'}};
    cell.alignment={vertical:'middle'};
   });
   sheet.autoFilter={from:{row:1,column:1},to:{row:1,column:8}};
   for(const col of [1,2,3,4,6,7,8])sheet.getColumn(col).numFmt='@';
   sheet.getColumn(5).numFmt='0';
   sheet.dataValidations.add('F2:F2501',{
    type:'list',allowBlank:false,formulae:['"VALORADO,NOVALORADO"']});
   sheet.dataValidations.add('G2:G2501',{
    type:'list',allowBlank:false,formulae:['"NUEVO,REMANUFACTURADO"']});
   const guide=book.addWorksheet('Instrucciones');
   guide.columns=[{width:31},{width:100}];
   const notes=[
    ['PULSO · SALDOS INICIALES','Carga única de existencias, permitida solo antes de registrar movimientos posteriores.'],
    ['Centro / Almacén','Deben existir en Maestras → Bodegas y aliados, ser PROPIA y estar activos.'],
    ['Código SAP','Código existente de Maestras → Equipos y materiales. Guardar como texto si tiene ceros iniciales.'],
    ['Serial','Obligatorio con perfil de serie. Para cada serial usar una fila y Cantidad = 1.'],
    ['Sin perfil de serie','Puedes dejar Serial vacío y escribir la cantidad total, o usar identificador interno con Cantidad = 1.'],
    ['Cantidad','Número entero positivo. No se admiten cantidades negativas.'],
    ['Lote','VALORADO o NOVALORADO. Obligatorio para informes futuros.'],
    ['Estado de Recepción','NUEVO o REMANUFACTURADO. Obligatorio.'],
    ['Observaciones','Opcionales, máximo 240 caracteres.'],
    ['Estados automáticos','Estado físico BUENO; disponibilidad DISPONIBLE.'],
    ['Agrupación','PULSO creará una referencia de apertura por cada bodega propia del archivo.'],
    ['Confirmación','Una sola confirmación atómica: todo el inventario o nada. Función bloqueada al terminar.'],
    ['Máximo','2.500 filas, 150 bodegas, 8 MB por archivo.']
   ];
   for(const [a,b] of notes){const row=guide.addRow([a,b]);
    row.getCell(1).font={bold:true,color:{argb:'FF075A47'}};row.height=26;}
   const bytes=await book.xlsx.writeBuffer();
   const url=URL.createObjectURL(new Blob([bytes],{
    type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
   }));
   const a=document.createElement('a');a.href=url;
   a.download='PULSO_Plantilla_Saldos_Iniciales_Unica_Vez.xlsx';
   document.body.append(a);a.click();a.remove();
   setTimeout(()=>URL.revokeObjectURL(url),1000);
   banner('Plantilla descargada. Diligencia «Saldos iniciales» y conserva sus encabezados.');
  }catch(error){banner(error.message,true);}
 }
 function showErrors(errors){
  const container=$('opening-errors');container.replaceChildren();container.hidden=!errors.length;
  if(!errors.length)return;
  container.append(make('strong','No se puede confirmar. Errores encontrados: '+errors.length));
  const ul=make('ul');
  for(const error of errors)
   ul.append(make('li',(error.row?'Fila '+error.row+' · ':'')+
    (error.field?error.field+': ':'')+(error.message||'')));
  container.append(ul);
 }
 function showGroups(groups){
  const parent=$('opening-groups');parent.replaceChildren();
  for(const [index,group] of groups.entries()){
   const details=make('details',undefined,'opening-group');details.open=index<3;
   const head=make('summary');
   const title=make('strong',group.warehouse_label);
   head.append(title,make('span',group.items.length+' ítems · '+group.units+' unidades','opening-soft-count'));
   details.append(head);
   const wrap=make('div',undefined,'ingress-table-wrap opening-lines-wrap');
   const table=make('table',undefined,'ingress-table'),thead=make('thead'),tr=make('tr');
   ['SAP','Descripción','Serial','Cantidad','Lote','Estado recepción','Observaciones'].forEach(h=>tr.append(make('th',h)));
   thead.append(tr);
   const tbody=make('tbody');
   for(const it of group.items){
    const row=make('tr');
    [it.sap_code,it.sap_description||'—',it.serial||'Sin serial',it.quantity,it.lot,
     it.reception_state,it.notes||'—'].forEach(value=>row.append(make('td',value)));
    tbody.append(row);
   }
   table.append(thead,tbody);wrap.append(table);details.append(wrap);
   parent.append(details);
  }
 }
 function renderPreview(data){
  $('opening-preview').hidden=false;
  $('opening-preview-status').textContent=data.valid?'Validación correcta':'Correcciones pendientes';
  $('opening-preview-status').classList.toggle('warning',!data.valid);
  const totals=data.totals||{};
  $('opening-count-warehouses').textContent=totals.warehouses||0;
  $('opening-count-items').textContent=totals.lines||0;
  $('opening-count-units').textContent=totals.units||0;
  $('opening-count-serials').textContent=totals.serialized||0;
  showGroups(data.groups||[]);
  showErrors(data.errors||[]);
  $('opening-ack').disabled=!data.valid;
  $('opening-ack').checked=false;
  $('opening-confirm').disabled=true;
 }
 async function onUpload(file){
  if(busy||!file||done)return;
  busy=true;content=null;preview=null;
  $('opening-preview').hidden=true;banner('');
  stateMessage('Leyendo el Excel y validando existencias...');
  try{
   const rows=await parse(file);
   content={operation_id:crypto.randomUUID(),rows};
   $('opening-filename').textContent=file.name+' · '+rows.length+' ítems';
   preview=await api('/validar',{method:'POST',data:content});
   renderPreview(preview);
   if(preview.valid){
    stateMessage('Validación correcta. Aún no se ha registrado ninguna unidad.');
    banner('Vista previa lista. Confirma solo después de revisar todos los ítems.');
   }else{
    stateMessage('Se detectaron errores de validación.',true);
    banner('Corrige el Excel y vuelve a cargarlo. Ninguna existencia fue modificada.',true);
   }
  }catch(error){banner(error.message,true);stateMessage('Archivo no validado.',true);}
  finally{busy=false;$('opening-file').value='';}
 }
 async function confirmOpening(){
  if(done||busy||!content||!preview?.valid||!$('opening-ack').checked)return;
  if(!window.confirm(
   '¿Registrar definitivamente '+preview.totals.units+' unidades en '+
   preview.totals.warehouses+' bodegas?\n\nEsta es la ÚNICA carga inicial y no podrá repetirse.'
  ))return;
  busy=true;const button=$('opening-confirm');button.disabled=true;
  button.textContent='Registrando inventario inicial...';banner('');
  try{
   const result=await api('/confirmar',{method:'POST',data:content});
   content=null;finish(result);
  }catch(error){
   if(error.details?.validation){
    preview={...preview,valid:false,errors:error.details.validation.errors||[]};
    renderPreview(preview);
   }else{
    try{const state=await api('/estado');
     if(state.completed){finish(state);return;}
    }catch{}
   }
   banner(error.message,true);
  }finally{
   busy=false;
   if(!done){
    button.textContent='Registrar saldo inicial definitivamente';
    button.disabled=!preview?.valid||!$('opening-ack').checked;
   }
  }
 }
 $('opening-template').addEventListener('click',()=>void download());
 $('opening-upload').addEventListener('click',()=>$('opening-file').click());
 $('opening-file').addEventListener('change',e=>void onUpload(e.target.files?.[0]));
 $('opening-ack').addEventListener('change',()=>{
  $('opening-confirm').disabled=done||busy||!preview?.valid||!$('opening-ack').checked;
 });
 $('opening-confirm').addEventListener('click',()=>void confirmOpening());
 void loadState().catch(error=>stateMessage(error.message,true));
})();
