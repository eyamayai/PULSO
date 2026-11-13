'use strict';
(()=>{
 const $=id=>document.getElementById(id);
 const node=(tag,value,cls)=>{const e=document.createElement(tag);if(value!==undefined)e.textContent=String(value);if(cls)e.className=cls;return e;};
 const upper=v=>String(v??'').trim().toUpperCase(),trim=v=>String(v??'').trim();
 let payload=null,preview=null,busy=false,confirmed=false,localErrors=[];
 function alert(text,error=false){const e=$('con-alert');e.textContent=text||'';e.hidden=!text;e.classList.toggle('error',error);}
 function screen(name){for(const x of ['home','upload','detail'])$('consumption-'+x).hidden=x!==name;window.scrollTo(0,0);}
 async function api(path,method='GET',data=null){
  const res=await fetch('/api/consumos'+path,{method,credentials:'same-origin',cache:'no-store',
   ...(data?{headers:{'content-type':'application/json'},body:JSON.stringify(data)}:{})});
  if(res.status===401){location.assign('/main');throw Error('Sesión caducada.');}
  if(res.status===403){location.assign('/inicio');throw Error('Sin permisos de administración.');}
  const value=await res.json().catch(()=>({error:'RESPUESTA_INVALIDA'}));
  if(!res.ok||value.ok===false){const msg={
   CONSUMOS_INVALIDOS:'Hay consumos inválidos. No se registró ningún equipo.',
   CONSUMOS_CAMBIARON_REVALIDAR:'Las existencias asignadas cambiaron; recarga y valida el Excel.',
   LOTE_CONSUMOS_YA_UTILIZADO:'El identificador ya fue usado para otro reporte.'
  };const error=Error(msg[value.error]||value.error||'Error del servidor.');error.details=value;throw error;}
  return value;
 }
 function reset(){
  payload=null;preview=null;localErrors=[];busy=false;confirmed=false;
  $('con-file').value='';$('con-file-status').textContent='Sin archivo';
  $('con-filename').textContent='Hasta 500 líneas por reporte. No se procesará EQUIPOS RETIRADOS.';
  $('con-preview').hidden=true;$('con-success').hidden=true;$('con-ack').checked=false;
  $('con-ack').disabled=true;$('con-confirm').disabled=true;
  $('con-confirm').textContent='Confirmar consumos';alert('');
 }
 async function home(){
  const data=await api(''),stats=data.summary||{};
  for(const [id,key] of [['con-kpi-units','units'],['con-kpi-items','lines'],
   ['con-kpi-techs','technicians'],['con-kpi-reports','reports']])
   $(id).textContent=Number(stats[key]||0).toLocaleString('es-CO');
  const search=upper($('con-search').value),rows=(data.items||[]).filter(r=>
   !search||upper(r.source_filename).includes(search)||upper(r.created_at).includes(search));
  $('con-results').textContent=rows.length+' reportes';$('con-empty').hidden=!!rows.length;
  const tbody=$('con-history');tbody.replaceChildren();
  for(const rec of rows){
   const tr=node('tr'),td=node('td');td.append(node('strong',rec.source_filename));
   td.append(node('small',rec.id.slice(0,8),'dispatch-cell-detail'));tr.append(td);
   for(const x of [rec.created_at,rec.lines,rec.units,rec.technicians])tr.append(node('td',x));
   const act=node('td'),button=node('button','Ver detalle','ingress-row-button');button.type='button';
   button.addEventListener('click',()=>void detail(rec.id));act.append(button);tr.append(act);tbody.append(tr);
  }
 }
 async function detail(id){
  try{
   const data=await api('/lote/'+id);
   $('con-detail-title').textContent=data.header.source_filename+' · '+data.header.created_at;
   const tbody=$('con-detail-rows');tbody.replaceChildren();
   for(const item of data.items||[]){
    const tr=node('tr');
    for(const val of [item.ot,item.technician_name,item.sap_code+' · '+item.sap_description,
     item.reported_serial||'Vacío en Claro',item.internal_serial||'Sin serial',
     item.quantity,item.dispatch_reference])tr.append(node('td',val));
    tbody.append(tr);
   }
   screen('detail');
  }catch(e){alert(e.message,true);}
 }
 function read(cell,row,kind=''){
  const val=cell.value;
  if(val==null)return '';
  if(val instanceof Date)return val.toISOString().slice(0,10);
  if(typeof val==='number'&&kind==='date'){
   if(!Number.isFinite(val)||val<36526||val>73415)throw Error('Fecha inválida en fila '+row);
   return new Date(Date.UTC(1899,11,30)+Math.floor(val)*86400000).toISOString().slice(0,10);
  }
  if(typeof val==='number'){
   if(!Number.isSafeInteger(val)||String(val).includes('e'))
    throw Error('Fila '+row+': número mayor a la precisión de Excel; almacénalo como texto.');
   return String(val);
  }
  if(typeof val==='object')return trim(val.text??val.result??'');
  return trim(val);
 }
 function key(sap,ot,wfm,tech){
  return [upper(sap),upper(ot),upper(wfm).replace(/^7K/,''),upper(tech)].join('|');
 }
 function installed(sheet){
  if(!sheet)throw Error('Falta Sheet1 (EQUIPOS INSTALADOS).');
  const map=new Map();let started=false;
  for(let i=1;i<=sheet.rowCount;i++){
   const r=sheet.getRow(i),v=c=>read(r.getCell(c),i),mark=upper(v(2));
   if(mark==='EQUIPOS RETIRADOS')break;
   if(mark==='EQUIPOS INSTALADOS'){started=true;continue;}
   if(!started||!mark||mark==='SAP')continue;
   const sap=upper(v(2)),ot=upper(v(7)),wfm=upper(v(6)),tech=upper(v(12)),serial=upper(v(8));
   if(!sap||!ot||!tech)continue;
   const k=key(sap,ot,wfm,tech);
   if(!map.has(k))map.set(k,[]);
   map.get(k).push({sap_code:sap,ot,wfm_id:wfm,technician_document:tech,
    serial,serial_profile:upper(v(13))});
  }
  if(!started)throw Error('No se encontró EQUIPOS INSTALADOS en Sheet1.');
  return map;
 }
 async function parse(file){
  if(!window.ExcelJS)throw Error('El lector ExcelJS no está disponible.');
  if(!file||!/\.xlsx$/i.test(file.name))throw Error('Solo se admiten archivos .xlsx.');
  if(file.size>8*1024*1024)throw Error('El Excel supera 8 MB.');
  const book=new ExcelJS.Workbook();await book.xlsx.load(await file.arrayBuffer());
  const support=installed(book.getWorksheet('Sheet1')||book.worksheets[0]),
   sheet=book.getWorksheet('Sheet2')||book.worksheets[1];
  if(!sheet)throw Error('Falta Sheet2, el reporte oficial de consumos de Claro.');
  const required={3:'MATERIAL',4:'CANT',5:'ALM',6:'CENTRO',8:'OBS',
   9:'NUMERO DE SERIE',10:'LOTE',11:'ORDEN',12:'FECHA',15:'Identificación'};
  for(const [index,header] of Object.entries(required))
   if(upper(read(sheet.getRow(1).getCell(Number(index)),1))!==upper(header))
    throw Error('El formato de Sheet2 no coincide con el reporte WFM (columna '+index+').');
  if(sheet.rowCount>1200)throw Error('El archivo supera el máximo de 500 líneas.');
  const rows=[],problems=[];
  for(let i=2;i<=sheet.rowCount;i++){
   const r=sheet.getRow(i),get=(col,kind)=>read(r.getCell(col),i,kind);
   if(!trim(get(3))&&!trim(get(11)))continue;
   if(rows.length>=500)throw Error('Límite de 500 consumos por archivo.');
   const sap=upper(get(3)),ot=upper(get(11)),wfm=upper(get(8)).replace(/^7K/,''),
    tech=upper(get(15)),serial=upper(get(9));
   const found=support.get(key(sap,ot,wfm,tech))||[];
   if(found.length>1)problems.push({row:i,field:'Sheet1',
    message:'Coincidencia ambigua de '+found.length+' equipos instalados.'});
   rows.push({line:i,sap_code:sap,ot,wfm_id:wfm,technician_document:tech,
    reported_serial:serial,quantity:Number(get(4)),centro:upper(get(6)),almacen:upper(get(5)),
    lot:upper(get(10)),consumption_date:get(12,'date'),support:found.length===1?found[0]:null});
  }
  if(!rows.length)throw Error('Sheet2 no contiene consumos.');
  return {rows,problems};
 }
 function showErrors(errors){
  const e=$('con-errors');e.replaceChildren();e.hidden=!errors.length;
  if(!errors.length)return;
  e.append(node('strong',errors.length+' errores bloqueantes. No se registrará ningún consumo.'));
  const ul=node('ul');
  for(const err of errors)ul.append(node('li',(err.row?'Fila '+err.row+' · ':'')+
   (err.field?err.field+': ':'')+err.message));
  e.append(ul);
 }
 function showGroups(groups){
  const parent=$('con-groups');parent.replaceChildren();
  for(const [i,g] of groups.entries()){
   const d=node('details',undefined,'con-group');d.open=i<3;
   const sum=node('summary');sum.append(node('strong',g.technician_name+' · '+g.technician_document),
    node('span',g.items.length+' ítems · '+g.units+' unidades'));d.append(sum);
   const wrap=node('div',undefined,'ingress-table-wrap'),table=node('table',undefined,'ingress-table'),
    thead=node('thead'),tr=node('tr'),tbody=node('tbody');
   for(const x of ['OT','SAP / Descripción','Serial Claro','Serial PULSO','Cantidad','Bodega','Despacho'])
    tr.append(node('th',x));
   thead.append(tr);
   for(const it of g.items){
    const row=node('tr');
    const values=[it.ot,it.sap_code+' · '+it.sap_description,it.reported_serial||'Celda vacía',
     it.internal_serial||'Sin serial',it.quantity,it.centro+' / '+it.almacen,it.dispatch_reference];
    for(let j=0;j<values.length;j++){
     const td=node('td',values[j]);
     if(j===3&&!it.reported_serial&&it.internal_serial)
      td.append(node('small','Recuperado de Sheet1','con-source-tag'));
     row.append(td);
    }
    tbody.append(row);
   }
   table.append(thead,tbody);wrap.append(table);d.append(wrap);parent.append(d);
  }
 }
 function render(data){
  preview=data;$('con-preview').hidden=false;
  const stats=data.totals||{};
  for(const [id,key] of [['con-stat-lines','lines'],['con-stat-units','units'],
   ['con-stat-techs','technicians'],['con-stat-recovered','recovered']])
   $(id).textContent=Number(stats[key]||0);
  showGroups(data.groups||[]);showErrors([...(data.errors||[]),...localErrors]);
  const valid=data.valid&&!localErrors.length;
  $('con-preview-status').textContent=valid?'Conciliación completa':'Con errores';
  $('con-ack').checked=false;$('con-ack').disabled=!valid;
  $('con-confirm').disabled=true;$('con-file-status').textContent=valid?'Validado':'Revisar errores';
  alert(valid?'Validación correcta. Aún no se registraron consumos.':
   'Corrige el Excel. Ningún equipo fue consumido.',!valid);
 }
 async function upload(file){
  if(!file||busy)return;
  busy=true;payload=null;preview=null;confirmed=false;localErrors=[];
  $('con-preview').hidden=true;alert('');$('con-file-status').textContent='Leyendo Excel...';
  try{
   const read=await parse(file);localErrors=read.problems;
   payload={operation_id:crypto.randomUUID(),filename:file.name,rows:read.rows};
   $('con-filename').textContent=file.name+' · '+read.rows.length+' consumos';
   $('con-file-status').textContent='Validando asignaciones...';
   render(await api('/validar','POST',payload));
  }catch(err){payload=null;$('con-file-status').textContent='Archivo inválido';alert(err.message,true);}
  finally{busy=false;$('con-file').value='';}
 }
 function done(result){
  confirmed=true;payload=null;$('con-preview').hidden=true;$('con-success').hidden=false;
  $('con-success-text').textContent='Se registraron '+result.totals.lines+' ítems y '+
   result.totals.units+' unidades. El saldo en bodega no volvió a descontarse.';
  $('con-file-status').textContent='✓ Confirmado';alert('');
 }
 async function confirmAll(){
  if(busy||confirmed||!payload||!preview?.valid||localErrors.length||!$('con-ack').checked)return;
  if(!window.confirm('Confirmar '+preview.totals.lines+' consumos y '+
   preview.totals.units+' unidades? No se podrá consumir dos veces el mismo equipo.'))return;
  busy=true;const button=$('con-confirm');button.disabled=true;button.textContent='Confirmando consumos...';
  try{done(await api('/confirmar','POST',payload));}
  catch(err){if(err.details?.validation)render({...preview,...err.details.validation});alert(err.message,true);}
  finally{busy=false;if(!confirmed){button.textContent='Confirmar consumos';
   button.disabled=!preview?.valid||localErrors.length>0||!$('con-ack').checked;}}
 }
 $('con-new').addEventListener('click',()=>{reset();screen('upload');});
 $('con-back').addEventListener('click',()=>{if(!busy){screen('home');void home();}});
 $('con-detail-back').addEventListener('click',()=>{screen('home');void home();});
 $('con-upload-button').addEventListener('click',()=>$('con-file').click());
 $('con-file').addEventListener('change',e=>void upload(e.target.files?.[0]));
 $('con-ack').addEventListener('change',()=>{
  $('con-confirm').disabled=busy||confirmed||!preview?.valid||localErrors.length>0||!$('con-ack').checked;
 });
 $('con-confirm').addEventListener('click',()=>void confirmAll());
 $('con-done').addEventListener('click',()=>{screen('home');void home();});
 $('con-search').addEventListener('input',()=>void home());
 void home().catch(err=>alert(err.message,true));
})();
