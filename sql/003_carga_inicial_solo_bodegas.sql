-- Ajuste no destructivo: carga inicial e ingresos exclusivamente en bodegas.
-- Los equipos entregados a técnicos se reconstruyen desde el módulo Despachos.
create or replace function internal.pulso_process_batch(p_kind text,p_rows jsonb)
returns jsonb language plpgsql security definer
set search_path=pg_catalog,public as $$
declare r jsonb; v_asset public.assets%rowtype; v_id uuid; v_serial text; v_sap text;
 v_from uuid; v_to uuid; v_evt text; v_rec text; v_stock text; v_state text;
 v_date date; v_ok int:=0; v_skip int:=0; v_row int:=0; v_desc text;
begin
 if not internal.is_staff() then raise exception 'No autorizado para registrar movimientos'; end if;
 if p_kind not in ('CARGA_INICIAL','INGRESO','DESPACHO','CONSUMO','RETIRO','DEVOLUCION','PREALERTA','RECOLECCION') then
 raise exception 'Tipo de operación no permitido'; end if;
 if jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)=0 or jsonb_array_length(p_rows)>2000 then
 raise exception 'La carga debe contener entre 1 y 2000 filas'; end if;
 for r in select value from jsonb_array_elements(p_rows) loop
   v_row:=v_row+1;
   v_serial:=upper(btrim(coalesce(r->>'serial','')));
   v_sap:=btrim(coalesce(r->>'sap',''));
   v_desc:=btrim(coalesce(r->>'description',''));
   v_from:=nullif(r->>'bodega_id','')::uuid;
   v_to:=nullif(r->>'tech_id','')::uuid;
   v_evt:=nullif(btrim(coalesce(r->>'event_id','')),'');
   v_date:=coalesce(nullif(r->>'date','')::date,current_date);
   if v_serial='' or v_serial in ('SINPERFILDESERIE','SIN PERFIL DE SERIE','N/A','NA') then
     raise exception 'Fila %: serial sin identificar',v_row;
   end if;
   if v_evt is not null and exists(select 1 from public.movements where event_key=p_kind||':'||v_evt) then
     v_skip:=v_skip+1; continue;
   end if;
   select * into v_asset from public.assets where serial=v_serial for update;
   if p_kind in ('CARGA_INICIAL','INGRESO') then
      if found then raise exception 'Fila %: serial ya registrado %',v_row,v_serial; end if;
      if v_to is not null then
        raise exception 'Fila %: la carga inicial y los ingresos solo se registran en bodegas; utiliza Despachos para asignar al técnico',v_row;
      end if;
      if v_from is null or not exists(
        select 1 from public.locations where id=v_from and kind='BODEGA' and active
      ) then
        raise exception 'Fila %: debes seleccionar una bodega física válida',v_row;
      end if;
      v_to:=v_from;
      v_rec:=case when lower(coalesce(r->>'reception','')) like 'remanu%' then 'Remanufacturado' else 'Nuevo' end;
      v_stock:=case when upper(coalesce(r->>'stock_type','LIBRE'))='INVERSA' then 'INVERSA' else 'LIBRE' end;
      v_state:=case when v_stock='INVERSA' then 'EN_BODEGA'
                    else 'DISPONIBLE' end;
      if v_sap='' then raise exception 'Fila %: falta código SAP',v_row; end if;
      insert into public.assets(serial,serial_kind,sap,description,category,sap_center,sap_warehouse,physical_condition,profile_type,reception,stock_type,state,location_id,source_doc,supplier,received_on)
      values (v_serial, case when upper(coalesce(r->>'serial_kind',''))='GENERICO' then 'GENERICO' else 'FISICO' end,
      v_sap,v_desc,coalesce(r->>'category',''),coalesce(r->>'sap_center',''),coalesce(r->>'sap_warehouse',''),coalesce(r->>'physical_condition','BUENO'),coalesce(r->>'profile_type','SIN PERFIL'),v_rec,v_stock,v_state,v_to,
      coalesce(r->>'document',''),coalesce(r->>'supplier',''),v_date) returning id into v_id;
   else
      if p_kind='RETIRO' and not found then
        if v_to is null or not exists(select 1 from public.locations where id=v_to and kind='TECNICO') then
          raise exception 'Fila %: selecciona técnico responsable del retiro',v_row; end if;
        insert into public.assets(serial,serial_kind,sap,description,category,sap_center,sap_warehouse,physical_condition,profile_type,reception,stock_type,state,location_id,work_order,site_id,received_on)
        values (v_serial,case when upper(coalesce(r->>'serial_kind',''))='GENERICO' then 'GENERICO' else 'FISICO' end,
         v_sap,v_desc,coalesce(r->>'category',''),coalesce(r->>'sap_center',''),coalesce(r->>'sap_warehouse',''),'SIN_VALIDAR','SIN PERFIL','Remanufacturado',
         'INVERSA','PENDIENTE_DEVOLUCION',v_to,coalesce(r->>'ot',''),coalesce(r->>'site',''),v_date)
        returning id into v_id;
      else
        if not found then raise exception 'Fila %: serial no existe en PULSO: %',v_row,v_serial; end if;
        v_id:=v_asset.id;
        if p_kind='DESPACHO' then
          if v_asset.stock_type<>'LIBRE' or v_asset.state<>'DISPONIBLE' or not exists(select 1 from public.locations where id=v_asset.location_id and kind='BODEGA') then
             raise exception 'Fila %: equipo no disponible en bodega',v_row; end if;
          if not exists(select 1 from public.locations where id=v_to and kind='TECNICO') then raise exception 'Fila %: técnico no válido',v_row; end if;
          v_from:=v_asset.location_id;
          update public.assets set location_id=v_to,state='ASIGNADO',updated_at=now() where id=v_id;
        elsif p_kind='CONSUMO' then
          if v_asset.stock_type<>'LIBRE' or v_asset.state<>'ASIGNADO' or not exists(select 1 from public.locations where id=v_asset.location_id and kind='TECNICO') then
            raise exception 'Fila %: el serial no figura LIBRE asignado a técnico',v_row; end if;
          if v_to is not null and v_to<>v_asset.location_id then raise exception 'Fila %: el serial pertenece a otro técnico',v_row; end if;
          v_from:=v_asset.location_id;v_to:=null;
          update public.assets set location_id=null,stock_type='CONSUMIDO',state='CONSUMIDO',
           work_order=coalesce(r->>'ot',''),site_id=coalesce(r->>'site',''),updated_at=now() where id=v_id;
        elsif p_kind='RETIRO' then
          if v_asset.stock_type<>'CONSUMIDO' then raise exception 'Fila %: serial existente sin consumo previo, revisar retiro',v_row; end if;
          if v_to is null then raise exception 'Fila %: técnico requerido',v_row; end if;
          v_from:=null;
          update public.assets set location_id=v_to,stock_type='INVERSA',state='PENDIENTE_DEVOLUCION',
            work_order=coalesce(r->>'ot',''),site_id=coalesce(r->>'site',''),physical_condition='SIN_VALIDAR',updated_at=now() where id=v_id;
        elsif p_kind='DEVOLUCION' then
          if not exists(select 1 from public.locations where id=v_asset.location_id and kind='TECNICO') then
            raise exception 'Fila %: equipo no está en custodia de técnico',v_row; end if;
          if not exists(select 1 from public.locations where id=v_from and kind='BODEGA') then
            raise exception 'Fila %: bodega destino no válida',v_row; end if;
          v_to:=v_from; v_from:=v_asset.location_id;
          v_stock:=case when v_asset.stock_type='INVERSA' or upper(coalesce(r->>'reason','')) in ('GARANTIA','DESMONTE') then 'INVERSA' else 'LIBRE' end;
          update public.assets set location_id=v_to,stock_type=v_stock,
           state=case when v_stock='INVERSA' then 'EN_BODEGA' else 'DISPONIBLE' end,physical_condition=case when upper(coalesce(r->>'reason',''))='GARANTIA' then 'DAÑADO' else v_asset.physical_condition end,updated_at=now() where id=v_id;
        elsif p_kind='PREALERTA' then
          if v_asset.stock_type<>'INVERSA' or v_asset.state<>'EN_BODEGA' then
           raise exception 'Fila %: serial no disponible en INVERSA de bodega',v_row; end if;
          v_from:=v_asset.location_id;v_to:=v_from;
          update public.assets set state='PREALERTADO',updated_at=now() where id=v_id;
        elsif p_kind='RECOLECCION' then
          if v_asset.stock_type<>'INVERSA' or v_asset.state<>'PREALERTADO' then
           raise exception 'Fila %: primero debe prealertarse el equipo',v_row; end if;
          v_from:=v_asset.location_id;v_to:=null;
          update public.assets set location_id=null,stock_type='ENTREGADO',state='ENTREGADO_CLIENTE',updated_at=now() where id=v_id;
        end if;
      end if;
   end if;
   insert into public.movements(asset_id,kind,source_location,target_location,actor_id,event_key,
     work_order,site_id,event_date,note)
   values(v_id,p_kind,v_from,coalesce(v_to,v_from),auth.uid(),
    case when v_evt is not null then p_kind||':'||v_evt else null end,
    coalesce(r->>'ot',''),coalesce(r->>'site',''),v_date,coalesce(r->>'reason',''));
   v_ok:=v_ok+1;
 end loop;
 insert into public.import_runs(actor_id,kind,total) values(auth.uid(),p_kind,v_ok);
 return jsonb_build_object('processed',v_ok,'skipped',v_skip);
end $$;
