'use strict';
(() => {
  const $=id=>document.getElementById(id);
  const SCHEMAS={
    SUPERVISORES:{name:'Supervisores',file:'PULSO_Maestra_Supervisores.xlsx',sheet:'Supervisores',columns:[
      ['Identificación','document_number'],['Nombre','full_name'],['Departamento','department'],
      ['Zona','zone'],['Correo','email'],['Teléfono','phone'],['Estado','is_active']]},
    TECNICOS:{name:'Técnicos',file:'PULSO_Maestra_Tecnicos.xlsx',sheet:'Tecnicos',columns:[
      ['Identificación','document_number'],['Nombre','full_name'],['Departamento','department'],
      ['Ciudad Base','city_base'],['Identificación Supervisor','supervisor_document'],
      ['Correo','email'],['Teléfono','phone'],['Estado','is_active']]},
    CATALOGO:{name:'Equipos y Materiales',file:'PULSO_Maestra_Equipos_Materiales.xlsx',sheet:'Equipos_Materiales',columns:[
      ['Código SAP','sap_code'],['Descripción','description'],['Tipo','item_type'],
      ['Perfil','serial_profile'],['Unidad','unit'],['Familia','family'],['Estado','is_active']]},
    BODEGAS:{name:'Bodegas y Aliados',file:'PULSO_Maestra_Bodegas_Aliados.xlsx',sheet:'Bodegas_Aliados',columns:[
      ['Centro','centro'],['Almacén','almacen'],['Descripción','description'],
      ['Administración','administration'],['Departamento','department'],['Estado','is_active']]}
  };
  const normalize=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim().replace(/\s+/g,' ');
  const schema=()=>SCHEMAS[$('bulk-kind').value];
  let rows=[],rowNumbers=[],valid=false,checking=false;
  function result(text,kind='') {
    const el=$('bulk-results');el.replaceChildren();
    const p=document.createElement('p');p.className=kind;p.textContent=text;el.append(p);
  }
  function errorsView(errors){
    const holder=$('bulk-results');
    if(!errors.length)return;
    const ul=document.createElement('ul');ul.className='bulk-error-list';
    for(const e of errors.slice(0,40)){
      const li=document.createElement('li');
      const realRow=rowNumbers[e.row-2]||e.row;
      li.textContent='Fila '+realRow+' · '+e.field+': '+e.message;ul.append(li);
    }
    holder.append(ul);
  }
  function state(){
    $('bulk-check').disabled=!rows.length||checking;
    $('bulk-confirm').disabled=!rows.length||!valid||checking;
    $('bulk-template').disabled=checking;
    $('bulk-file').disabled=checking;
  }
  function reset(){
    rows=[];rowNumbers=[];valid=false;checking=false;
    $('bulk-file').value='';
    $('bulk-preview-area').hidden=true;
    $('bulk-preview-head').replaceChildren();$('bulk-preview-body').replaceChildren();
    result('Descarga la plantilla y selecciona tu archivo .xlsx. No se cargará nada sin validación.');
    state();
  }
  function workbookOrThrow(){
    if(!window.ExcelJS)throw new Error('No se pudo cargar la biblioteca de Excel. Actualiza la página.');
    return new window.ExcelJS.Workbook();
  }
  async function downloadTemplate(){
    const btn=$('bulk-template');btn.disabled=true;
    try {
      const wb=workbookOrThrow();
      const def=schema();
      wb.creator='PULSO';
      const ws=wb.addWorksheet(def.sheet,{views:[{state:'frozen',ySplit:1,showGridLines:false}]});
      ws.columns=def.columns.map(([title,key])=>({header:title,key,width:key==='description'?43:key==='full_name'?32:key==='serial_profile'?26:key==='supervisor_document'?28:22}));
      const head=ws.getRow(1);head.height=28;
      head.eachCell(cell=>{
        cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF075A47'}};
        cell.font={name:'Aptos',size:11,color:{argb:'FFFFFFFF'},bold:true};
        cell.alignment={vertical:'middle'};
      });
      for(const [,key] of def.columns.map((c,i)=>[i,c[1]])){
        if(['document_number','supervisor_document','sap_code','centro','almacen'].includes(key))ws.getColumn(key).numFmt='@';
      }
      ws.autoFilter={from:{row:1,column:1},to:{row:1,column:def.columns.length}};
      const buffer=await wb.xlsx.writeBuffer();
      const blob=new Blob([buffer],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
      const link=document.createElement('a');
      const url=URL.createObjectURL(blob);link.href=url;link.download=def.file;document.body.append(link);link.click();link.remove();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(e){result(e.message,'err');}
    finally{btn.disabled=false;}
  }
  function preview(){
    const def=schema(),thead=$('bulk-preview-head'),tbody=$('bulk-preview-body');
    thead.replaceChildren();tbody.replaceChildren();
    const h=document.createElement('tr');
    for(const [title] of def.columns){const th=document.createElement('th');th.textContent=title;h.append(th);}
    thead.append(h);
    for(const item of rows.slice(0,8)){
      const tr=document.createElement('tr');
      for(const [,key] of def.columns){const td=document.createElement('td');td.textContent=key==='is_active'?(item.is_active?'ACTIVO':'INACTIVO'):(item[key]||'');tr.append(td);}
      tbody.append(tr);
    }
    $('bulk-preview-area').hidden=false;
  }
  function cellText(cell){
    const raw=cell.value;
    if(raw&&typeof raw==='object'&&('formula' in raw||'sharedFormula' in raw))throw new Error('No se permiten fórmulas en el Excel. Utiliza valores escritos.');
    if(raw===undefined||raw===null)return '';
    return String(cell.text??raw).trim();
  }
  function mapStatus(value,row){
    if(!value)return true;
    const state=normalize(value);
    if(['activo','si','1','true'].includes(state))return true;
    if(['inactivo','no','0','false'].includes(state))return false;
    throw new Error('Fila '+row+': Estado debe ser ACTIVO o INACTIVO.');
  }
  async function readFile(){
    const file=$('bulk-file').files[0];
    rows=[];rowNumbers=[];valid=false;checking=false;
    $('bulk-preview-area').hidden=true;
    $('bulk-preview-head').replaceChildren();$('bulk-preview-body').replaceChildren();
    state();
    if(!file)return;
    if(!file.name.toLowerCase().endsWith('.xlsx')||file.size>5*1024*1024||file.size<100)
      throw new Error('Selecciona un archivo .xlsx válido, de máximo 5 MB.');
    const wb=workbookOrThrow();
    const buffer=await file.arrayBuffer();
    await wb.xlsx.load(buffer);
    if(wb.worksheets.length!==1)throw new Error('El Excel debe contener una sola hoja, como la plantilla.');
    const ws=wb.worksheets[0],def=schema();
    const expected=new Set(def.columns.map(c=>normalize(c[0])));
    const colMap=new Map();
    const header=ws.getRow(1);
    for(let i=1;i<=Math.max(header.cellCount,def.columns.length);i++){
      const title=cellText(header.getCell(i));
      if(!title)continue;
      const key=normalize(title);
      if(!expected.has(key))throw new Error('Columna desconocida: '+title+'. Descarga la plantilla correspondiente.');
      if(colMap.has(key))throw new Error('Columna repetida: '+title);
      colMap.set(key,i);
    }
    for(const [title] of def.columns){
      if(!colMap.has(normalize(title)))throw new Error('Falta la columna obligatoria: '+title);
    }
    if(ws.rowCount>10000)throw new Error('El libro contiene demasiadas filas.');
    for(let i=2;i<=ws.rowCount;i++){
      const row=ws.getRow(i),record={};
      let nonempty=false;
      for(const [title,key] of def.columns){
        const value=cellText(row.getCell(colMap.get(normalize(title))));
        if(value)nonempty=true;
        record[key]=value;
      }
      if(!nonempty)continue;
      record.is_active=mapStatus(record.is_active,i);
      rows.push(record);rowNumbers.push(i);
      if(rows.length>1000)throw new Error('Máximo 1.000 registros por archivo. Divide el Excel en varias plantillas.');
    }
    if(!rows.length)throw new Error('El Excel no contiene registros para importar.');
    preview();
    result('Archivo leído: '+rows.length+' registros. Pulsa «Validar Excel» antes de importarlos.');
    state();
  }
  async function send(mode) {
    checking=true;state();
    try {
      const endpoint=$('bulk-kind').value==='BODEGAS'?'/api/maestras/bodegas/import':'/api/maestras/import';
      const response=await fetch(endpoint,{
        method:'POST',credentials:'same-origin',cache:'no-store',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({kind:$('bulk-kind').value,mode,rows})
      });
      const answer=await response.json().catch(()=>({ok:false,error:'RESPUESTA_INVALIDA'}));
      if(response.status===401){location.assign('/main');return;}
      if(response.status===403){location.assign('/inicio');return;}
      if(answer.errors?.length){
        valid=false;
        result('Carga bloqueada: se detectaron '+answer.errors.length+' errores. No se guardó ningún registro.','err');
        errorsView(answer.errors);
        return;
      }
      if(!response.ok||!answer.ok)throw new Error('No se pudo procesar el archivo ('+(answer.error||response.status)+').');
      if(mode==='validate'){
        valid=Boolean(answer.valid);
        result(valid?'Validación correcta: '+answer.total+' registros listos para importar. No se ha guardado nada.':'La validación encontró errores.',''+(valid?'ok':'err'));
      } else {
        const count=answer.inserted;
        $('bulk-dialog').close();
        window.dispatchEvent(new CustomEvent('pulso:maestras-imported',{detail:{kind:$('bulk-kind').value,count}}));
      }
    } catch(e){valid=false;result(e.message,'err');}
    finally{checking=false;state();}
  }
  $('bulk-open').addEventListener('click',()=>{
    $('bulk-kind').value=$('tab-bodegas').getAttribute('aria-selected')==='true'?'BODEGAS'
      :$('tab-catalogo').getAttribute('aria-selected')==='true'?'CATALOGO':'SUPERVISORES';
    reset();
    $('bulk-note').textContent=$('bulk-kind').value==='BODEGAS'
      ?'Centro y Almacén deben ser únicos. Administración admite PROPIA o ALIADO.'
      :'Descarga la plantilla y valida los registros antes de importarlos.';
    $('bulk-dialog').showModal();
  });
  $('bulk-kind').addEventListener('change',()=>{
    reset();
    $('bulk-note').textContent=$('bulk-kind').value==='TECNICOS'
      ?'La identificación del supervisor debe existir en Personal y estar activa.'
      :$('bulk-kind').value==='SUPERVISORES'
      ?'Carga primero los supervisores y después los técnicos.'
      :$('bulk-kind').value==='BODEGAS'
      ?'Centro y Almacén deben ser únicos. Administración admite PROPIA o ALIADO.'
      :'El SAP y su perfil de serie se validarán contra el catálogo existente.';
  });
  $('bulk-file').addEventListener('change',async()=>{
    try{await readFile();}catch(e){rows=[];rowNumbers=[];valid=false;result(e.message,'err');state();}
  });
  $('bulk-template').addEventListener('click',()=>{void downloadTemplate();});
  $('bulk-check').addEventListener('click',()=>{void send('validate');});
  $('bulk-confirm').addEventListener('click',()=>{if(valid&&confirm('¿Confirmas cargar '+rows.length+' registros en la maestra?'))void send('commit');});
  $('bulk-close').addEventListener('click',()=>$('bulk-dialog').close());
  $('bulk-cancel').addEventListener('click',()=>$('bulk-dialog').close());
})();
