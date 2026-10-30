/* PULSO 1.0 | Maestra de técnicos | creación manual y carga masiva */
let techRows=[];
let techUploadInfo=null;
let techQuery='';
let techPreviewPage=0;
const techDepartments=[
 {id:'CESAR',name:'Cesar'},
 {id:'GUAJIRA',name:'La Guajira'},
 {id:'SAN_ANDRES',name:'San Andrés'}
];
const techNorm=s=>String(s??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
function techDepartment(s){
 const n=techNorm(s);
 if(['cesar'].includes(n))return 'CESAR';
 if(['guajira','laguajira'].includes(n))return 'GUAJIRA';
 if(['sanandres','sanandresislas'].includes(n))return 'SAN_ANDRES';
 return '';
}
function technicianExisting(r){
 const id=techNorm(r.identifier);
 const byId=id?tecs().find(t=>techNorm(t.identifier)===id):null;
 if(byId)return byId;
 const byName=tecs().filter(t=>techNorm(t.name)===techNorm(r.name));
 return byName[0]||null;
}
function techIssue(r,index,collection=techRows){
 if(!r.name||r.name.trim().length<5)return 'Nombre completo obligatorio (mínimo 5 caracteres)';
 if(!r.department_id)return 'Falta departamento válido: CESAR, GUAJIRA o SAN_ANDRES';
 if(!['Activo','Inactivo'].includes(r.status))return 'Estado inválido';
 if(technicianExisting(r))return 'Ya existe un técnico con ese nombre o identificación';
 const key=techNorm(r.name);
 if(collection.some((x,i)=>i!==index&&techNorm(x.name)===key))return 'Nombre repetido dentro del archivo';
 const doc=techNorm(r.identifier);
 if(doc&&collection.some((x,i)=>i!==index&&techNorm(x.identifier)===doc))return 'Identificación repetida dentro del archivo';
 return '';
}
function techSummary(){
 const bad=techRows.filter((r,i)=>techIssue(r,i)).length;
 return '<div class="metric-row">'+
 statTile('Técnicos en la maestra','Registrados en PULSO',tecs().length,'♙','primary')+
 statTile('Filas importadas','Pendientes de confirmar',techRows.length,'▤')+
 statTile('Registros válidos','Listos para importar',techRows.length-bad,'✓','success')+
 statTile('Con observaciones','Corregir en archivo Excel',bad,'!','danger')+
 statTile('Departamentos','Con técnicos activos',new Set(tecs().filter(t=>t.active).map(t=>t.department_id)).size,'⌂','amber')+'</div>';
}
function techList(){
 const found=tecs().filter(t=>!techQuery||[t.name,t.identifier,t.department_id,t.supervisor_name].some(v=>String(v||'').toLowerCase().includes(techQuery.toLowerCase())));
 return '<div class="preview-header"><div><strong>Técnicos registrados ('+found.length+')</strong><div class="caption">La maestra es independiente de las cuentas de acceso. Cada técnico tendrá inventario propio.</div></div>'+
 '<input id="techQuery" class="preview-search" value="'+safe(techQuery)+'" placeholder="⌕ Buscar nombre, identificación..."></div>'+
 '<div class="tablewrap"><table class="table"><thead><tr><th>Nombre completo</th><th>Identificación</th><th>Departamento</th><th>Supervisor</th><th>Estado</th><th>Acción</th></tr></thead><tbody>'+
 found.map(t=>'<tr><td class="strong">'+safe(t.name)+'</td><td>'+safe(t.identifier||'Sin registrar')+'</td><td>'+safe(t.department_id)+'</td><td>'+safe(t.supervisor_name||'Sin asignar')+'</td><td>'+pill(t.active?'ACTIVO':'INACTIVO')+'</td><td><button class="btn outline small" data-tech-toggle="'+t.id+'" data-target="'+(!t.active)+'">'+(t.active?'Desactivar':'Activar')+'</button></td></tr>').join('')+
 '</tbody></table>'+(!found.length?empty('Sin técnicos registrados','Importa la plantilla o registra el primer técnico.'):'')+'</div>';
}
function techPreview(){
 if(!techRows.length)return empty('No has cargado la maestra','Carga un archivo Excel con los técnicos, identificaciones y departamentos.');
 const issueCount=techRows.filter((r,i)=>techIssue(r,i)).length;
 const max=Math.max(1,Math.ceil(techRows.length/30));
 techPreviewPage=Math.min(techPreviewPage,max-1);
 const chunk=techRows.slice(techPreviewPage*30,(techPreviewPage+1)*30);
 return '<div class="preview-header"><div><strong>Vista previa de la maestra importada</strong><div class="caption">Solo lectura. Corrige los datos en Excel y vuelve a cargarlo si es necesario.</div></div>'+
 '<span class="pill '+(issueCount?'warn':'')+'">'+issueCount+' observaciones</span></div>'+
 '<div class="tablewrap"><table class="table"><thead><tr><th>Fila</th><th>Nombre completo</th><th>Identificación</th><th>Departamento</th><th>Supervisor</th><th>Estado</th><th>Validación</th></tr></thead><tbody>'+
 chunk.map((r,j)=>{const i=techPreviewPage*30+j,issue=techIssue(r,i);return '<tr class="'+(issue?'issue-row':'')+'"><td>'+ (i+2)+'</td><td class="strong">'+safe(r.name)+'</td><td>'+safe(r.identifier||'No informada')+'</td><td>'+safe(r.department_id||'Sin departamento')+'</td><td>'+safe(r.supervisor_name||'Sin supervisor')+'</td><td>'+pill(r.status)+'</td><td title="'+safe(issue)+'">'+(issue?'<span class="pill warn">⚠ '+safe(issue)+'</span>':'<span class="pill">✓ Válido</span>')+'</td></tr>'}).join('')+
 '</tbody></table></div><div class="preview-actions"><span class="micro muted">'+(techRows.length?techPreviewPage*30+1:0)+' a '+Math.min((techPreviewPage+1)*30,techRows.length)+' de '+techRows.length+' registros</span><div class="pager"><button class="btn outline small" id="techPrev" '+(!techPreviewPage?'disabled':'')+'>‹ Anterior</button><span class="micro muted">'+(techPreviewPage+1)+' / '+max+'</span><button class="btn outline small" id="techNext" '+(techPreviewPage+1>=max?'disabled':'')+'>Siguiente ›</button></div></div>'+
 '<div class="preview-actions"><button class="btn outline" id="techClear">✕ Limpiar vista previa</button><button class="btn" id="techSaveBatch" '+(issueCount?'disabled':'')+'>✓ Registrar '+techRows.length+' técnicos</button></div>';
}
function techniciansView(){
 if(!staff())return empty('Sin autorización','Solo logística administra esta maestra.');
 return bodyHead('Maestra de técnicos','Administración de técnicos por departamento e importación masiva desde Excel.',
 '<button class="btn outline" id="techDownload">↓ Descargar plantilla Excel</button>')+
 '<div class="process-info"><span class="info-icon">i</span><p><strong>Antes de Despachos:</strong> registra los técnicos que aparecen en el archivo. PULSO cruzará nombre o identificación con la maestra. No necesitas crearles todavía usuario ni contraseña.</p></div>'+
 techSummary()+
 '<div class="grid two" style="margin-bottom:16px"><div class="card stack"><div class="spread"><strong>▤ Importar técnicos desde Excel</strong><span class="pill gray">Carga masiva</span></div>'+
 '<div class="caption">Encabezados: Nombre completo, Identificación, Departamento, Supervisor y Estado.</div>'+
 '<label class="btn outline" style="cursor:pointer;align-self:flex-start">⇧ Seleccionar archivo<input id="techUpload" type="file" accept=".xlsx,.xls,.csv" class="hidden"></label>'+
 (techUploadInfo?'<div class="file-chip"><div><div class="file-name">'+safe(techUploadInfo.name)+'</div><div class="micro muted">'+techRows.length+' registros</div></div><span style="color:#168c6d">✓</span></div>':'')+
 '<div class="notice warn">Departamento obligatorio. Identificación y supervisor pueden completarse en el Excel. Los registros duplicados se bloquearán para evitar una maestra inconsistente.</div></div>'+
 '<div class="card stack"><div class="spread"><strong>♙ Registrar un técnico</strong><span class="pill">Manual</span></div>'+
 '<label class="field">Nombre completo<input id="techManualName" placeholder="Nombre y apellidos"></label>'+
 '<div class="grid two"><label class="field">Identificación<input id="techManualIdentifier" placeholder="Cédula o código (opcional)"></label>'+
 '<label class="field">Departamento<select id="techManualDepartment">'+opts(techDepartments,'','Seleccionar departamento')+'</select></label></div>'+
 '<div class="grid two"><label class="field">Supervisor<input id="techManualSupervisor" placeholder="Nombre del supervisor (opcional)"></label>'+
 '<label class="field">Estado<select id="techManualStatus"><option>Activo</option><option>Inactivo</option></select></label></div>'+
 '<button class="btn" id="techManualSave">+ Registrar técnico</button></div></div>'+
 '<div class="preview-area" style="margin-bottom:16px">'+techPreview()+'</div>'+
 '<div class="preview-area">'+techList()+'</div>';
}
function techRowsFromExcel(list){
 return list.map(o=>({
  name:String(pick(o,'Nombre completo','Nombre del técnico','Técnico','Tecnico','Nombre')||'').trim().replace(/\s+/g,' '),
  identifier:String(pick(o,'Identificación','Cedula','Cédula','Número de identificación','Documento de identidad')||'').trim(),
  department_id:techDepartment(pick(o,'Departamento','Zona','Departamento del técnico')),
  supervisor_name:String(pick(o,'Supervisor','Nombre del supervisor')||'').trim(),
  status:techNorm(pick(o,'Estado','Activo'))==='inactivo'?'Inactivo':'Activo'
 }));
}
async function techReadFile(file){
 try{
  if(!window.XLSX)throw Error('No cargó el lector Excel.');
  if(!/\.(xlsx|xls|csv)$/i.test(file.name.trim()))throw Error('Archivo no válido. Usa Excel o CSV.');
  if(file.size>15*1024*1024)throw Error('El archivo supera 15 MB.');
  const wb=XLSX.read(await file.arrayBuffer(),{type:'array',cellDates:false});
  const data=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{defval:'',raw:false});
  if(!data.length||data.length>2000)throw Error('La maestra debe contener entre 1 y 2.000 filas.');
  techRows=techRowsFromExcel(data);
  techUploadInfo={name:file.name,size:file.size};techPreviewPage=0;render();
  toast('Maestra leída: '+techRows.length+' registros. Revisa las validaciones antes de confirmar.');
 }catch(e){toast(e.message,true)}
}
function techTemplate(){
 if(!window.XLSX)return toast('No cargó el módulo Excel',true);
 const sheet=XLSX.utils.aoa_to_sheet([['Nombre completo','Identificación','Departamento','Supervisor','Estado'],['','','','','Activo']]);
 sheet['!cols']=[{wch:38},{wch:20},{wch:22},{wch:30},{wch:15}];
 const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,sheet,'Técnicos');XLSX.writeFile(wb,'PULSO_Maestra_de_Tecnicos.xlsx');
}
async function techInsert(payload){
 if(!staff())throw Error('Solo logística puede registrar técnicos.');
 const {error}=await db.from('locations').insert(payload);
 if(error)throw Error(error.message);
}
async function techSaveBatch(){
 try{
  if(!techRows.length)throw Error('No hay técnicos por registrar.');
  const errors=techRows.map(techIssue);
  const invalid=techRows.map((r,i)=>techIssue(r,i)).filter(Boolean);
  if(invalid.length)throw Error('Corrige las '+invalid.length+' observaciones en Excel antes de confirmar.');
  if(!confirm('¿Registrar '+techRows.length+' técnicos en la maestra? No se crearán usuarios ni despachos.'))return;
  const payload=techRows.map(t=>({name:t.name,identifier:t.identifier||null,kind:'TECNICO',department_id:t.department_id,supervisor_name:t.supervisor_name||'',active:t.status==='Activo'}));
  await techInsert(payload);
  techRows=[];techUploadInfo=null;techPreviewPage=0;await refresh();toast('✓ Maestra actualizada correctamente.');switchPage('technicians');
 }catch(e){toast(e.message,true)}
}
async function techSaveManual(){
 try{
  const row={
   name:val($('#techManualName')?.value),
   identifier:val($('#techManualIdentifier')?.value),
   department_id:$('#techManualDepartment')?.value||'',
   supervisor_name:val($('#techManualSupervisor')?.value),
   status:$('#techManualStatus')?.value||'Activo'
  };
  const issue=techIssue(row,0,[]);
  if(issue)throw Error(issue);
  await techInsert([{name:row.name,identifier:row.identifier||null,department_id:row.department_id,supervisor_name:row.supervisor_name,kind:'TECNICO',active:row.status==='Activo'}]);
  await refresh();toast('✓ Técnico registrado en la maestra.');
 }catch(e){toast(e.message,true)}
}
function bindTechniciansPage(){
 if($('#techDownload'))$('#techDownload').onclick=techTemplate;
 if($('#techUpload'))$('#techUpload').onchange=e=>{if(e.target.files?.[0])techReadFile(e.target.files[0])};
 if($('#techClear'))$('#techClear').onclick=()=>{techRows=[];techUploadInfo=null;techPreviewPage=0;render()};
 if($('#techSaveBatch'))$('#techSaveBatch').onclick=techSaveBatch;
 if($('#techManualSave'))$('#techManualSave').onclick=techSaveManual;
 if($('#techPrev'))$('#techPrev').onclick=()=>{techPreviewPage--;render()};
 if($('#techNext'))$('#techNext').onclick=()=>{techPreviewPage++;render()};
 if($('#techQuery'))$('#techQuery').oninput=e=>{techQuery=e.target.value;let pos=e.target.selectionStart;render();const el=$('#techQuery');if(el){el.focus();el.setSelectionRange(pos,pos)}};
 document.querySelectorAll('[data-tech-toggle]').forEach(el=>el.onclick=async()=>{
  if(!confirm('¿Cambiar estado del técnico?'))return;
  const {error}=await db.from('locations').update({active:el.dataset.target==='true'}).eq('id',el.dataset.techToggle).eq('kind','TECNICO');
  if(error)toast(error.message,true);else{toast('Estado actualizado');await refresh()}
 });
}
