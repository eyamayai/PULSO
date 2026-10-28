
-- PULSO 1.0 - instalación limpia (solo proyecto PULSO).
-- REEMPLAZA los objetos de la aplicación anterior en public; no crea respaldos.
create schema if not exists internal;
do $$
declare r record;
begin
  for r in select tablename from pg_tables where schemaname='public' loop
    execute format('drop table if exists public.%I cascade', r.tablename);
  end loop;
  for r in select p.proname, pg_get_function_identity_arguments(p.oid) args
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
  loop
    execute format('drop function if exists public.%I(%s) cascade',r.proname,r.args);
  end loop;
end $$;

create table public.departments (
  id text primary key, name text not null
);
insert into public.departments values
 ('GUAJIRA','La Guajira'),('CESAR','Cesar'),('SAN_ANDRES','San Andrés');

create table public.locations (
 id uuid primary key default gen_random_uuid(),
 name text not null,
 kind text not null check (kind in ('BODEGA','TECNICO')),
 department_id text not null references public.departments(id),
 active boolean not null default true,
 identifier text unique,
 created_at timestamptz default now()
);
insert into public.locations(name,kind,department_id) values
 ('Riohacha','BODEGA','GUAJIRA'),('Valledupar','BODEGA','CESAR'),
 ('Aguachica','BODEGA','CESAR'),('San Andrés','BODEGA','SAN_ANDRES');

create table public.actors (
 id uuid primary key references auth.users(id) on delete cascade,
 name text not null default '',
 role text not null default 'PENDIENTE' check(role in ('ADMIN','ASISTENTE','SUPERVISOR','TECNICO','PENDIENTE')),
 department_id text references public.departments(id),
 location_id uuid references public.locations(id),
 active boolean not null default true,
 created_at timestamptz default now()
);

create or replace function internal.actor_role() returns text
language sql stable security definer set search_path=pg_catalog as $$
 select coalesce((select a.role from public.actors a where a.id=auth.uid() and a.active),'PENDIENTE')
$$;
create or replace function internal.actor_department() returns text
language sql stable security definer set search_path=pg_catalog as $$
 select a.department_id from public.actors a where a.id=auth.uid() and a.active
$$;
create or replace function internal.actor_location() returns uuid
language sql stable security definer set search_path=pg_catalog as $$
 select a.location_id from public.actors a where a.id=auth.uid() and a.active
$$;
create or replace function internal.is_staff() returns boolean
language sql stable security definer set search_path=pg_catalog as $$
 select exists (select 1 from public.actors a where a.id=auth.uid() and a.active and a.role in ('ADMIN','ASISTENTE'))
$$;
revoke all on schema internal from public;
grant usage on schema internal to authenticated;
grant execute on all functions in schema internal to authenticated;

create or replace function internal.on_auth_user() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
begin
 insert into public.actors(id,name,role) values (new.id,coalesce(split_part(new.email,'@',1),''),'PENDIENTE')
 on conflict(id) do nothing;
 return new;
end $$;
drop trigger if exists pulso_new_user on auth.users;
create trigger pulso_new_user after insert on auth.users
for each row execute function internal.on_auth_user();
insert into public.actors(id,name)
select id,split_part(email,'@',1) from auth.users
on conflict(id) do nothing;

create table public.assets (
 id uuid primary key default gen_random_uuid(),
 serial text not null unique,
 serial_kind text not null default 'FISICO' check(serial_kind in('FISICO','GENERICO')),
 sap text not null default '',
 description text not null default '',
 category text not null default '',
 profile_type text not null default 'SIN PERFIL',
 reception text not null default 'Nuevo' check(reception in('Nuevo','Remanufacturado')),
 lot text generated always as (case when reception='Nuevo' then 'VALORADO' else 'NOVALORADO' end) stored,
 stock_type text not null check(stock_type in('LIBRE','INVERSA','CONSUMIDO','ENTREGADO')),
 state text not null,
 location_id uuid references public.locations(id),
 source_doc text default '',
 supplier text default '',
 work_order text default '',
 site_id text default '',
 received_on date,
 updated_at timestamptz not null default now(),
 created_at timestamptz not null default now()
);
create index assets_location_idx on public.assets(location_id,stock_type);
create index assets_sap_idx on public.assets(sap);
create table public.movements (
 id bigserial primary key,
 asset_id uuid not null references public.assets(id),
 kind text not null,
 source_location uuid references public.locations(id),
 target_location uuid references public.locations(id),
 actor_id uuid references auth.users(id),
 event_key text unique,
 work_order text default '',
 site_id text default '',
 event_date date,
 note text default '',
 created_at timestamptz default now()
);
create index movements_asset_idx on public.movements(asset_id,created_at desc);
create table public.import_runs(
 id uuid primary key default gen_random_uuid(),
 actor_id uuid references auth.users(id),
 kind text not null, total integer not null,
 created_at timestamptz default now()
);
create table public.transfers(
 id uuid primary key default gen_random_uuid(),
 asset_id uuid not null references public.assets(id),
 source_location uuid not null references public.locations(id),
 target_location uuid not null references public.locations(id),
 requested_by uuid references auth.users(id),
 approved_by uuid references auth.users(id),
 status text not null default 'SOLICITADA'
 check(status in('SOLICITADA','PENDIENTE_RECEPCION','ACEPTADA','RECHAZADA','CANCELADA')),
 requested_at timestamptz not null default now(),
 handed_at timestamptz,
 closed_at timestamptz,
 last_alert_at timestamptz,
 note text default ''
);
create index transfers_status_idx on public.transfers(status,handed_at);
create table public.notifications(
 id uuid primary key default gen_random_uuid(),
 recipient_id uuid not null references auth.users(id),
 transfer_id uuid references public.transfers(id),
 title text not null,
 body text not null,
 urgency text not null default 'NORMAL',
 viewed boolean not null default false,
 created_at timestamptz not null default now()
);
create table public.email_outbox(
 id bigint generated always as identity primary key,
 recipient_email text not null,
 subject text not null,
 body text not null,
 notification_id uuid references public.notifications(id),
 status text not null default 'PENDIENTE' check(status in ('PENDIENTE','ENVIADO','ERROR')),
 created_at timestamptz default now()
);
create or replace function internal.queue_notification_email() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
begin
 insert into public.email_outbox(recipient_email,subject,body,notification_id)
 select u.email, new.title, new.body, new.id from auth.users u
 where u.id=new.recipient_id and u.email is not null;
 return new;
end $$;
create trigger pulso_email_queue after insert on public.notifications
for each row execute function internal.queue_notification_email();

alter table public.departments enable row level security;
alter table public.locations enable row level security;
alter table public.actors enable row level security;
alter table public.assets enable row level security;
alter table public.movements enable row level security;
alter table public.transfers enable row level security;
alter table public.notifications enable row level security;
alter table public.import_runs enable row level security;
alter table public.email_outbox enable row level security;

create policy d_read on public.departments for select to authenticated using(internal.actor_role()<>'PENDIENTE');
create policy l_read on public.locations for select to authenticated using(internal.actor_role()<>'PENDIENTE');
create policy l_staff_insert on public.locations for insert to authenticated with check(internal.is_staff());
create policy l_staff_update on public.locations for update to authenticated using(internal.is_staff()) with check(internal.is_staff());
create policy a_read on public.actors for select to authenticated
using (id=auth.uid() or internal.is_staff() or (internal.actor_role()='SUPERVISOR' and department_id=internal.actor_department()));
create policy a_admin_update on public.actors for update to authenticated
using(internal.actor_role()='ADMIN') with check(internal.actor_role()='ADMIN');
create policy assets_read on public.assets for select to authenticated using (
 internal.is_staff()
 or location_id=internal.actor_location()
 or (internal.actor_role()='SUPERVISOR' and exists
  (select 1 from public.locations l where l.id=assets.location_id and l.department_id=internal.actor_department()))
);
create policy moves_read on public.movements for select to authenticated using(
 internal.is_staff()
 or source_location=internal.actor_location() or target_location=internal.actor_location()
 or (internal.actor_role()='SUPERVISOR' and exists
  (select 1 from public.locations l where l.id in(source_location,target_location) and l.department_id=internal.actor_department()))
);
create policy transfers_read on public.transfers for select to authenticated using (
 internal.is_staff() or source_location=internal.actor_location() or target_location=internal.actor_location()
 or (internal.actor_role()='SUPERVISOR' and exists
  (select 1 from public.locations l where l.id in(source_location,target_location) and l.department_id=internal.actor_department()))
);
create policy n_read on public.notifications for select to authenticated using(recipient_id=auth.uid());
create policy n_update on public.notifications for update to authenticated
using(recipient_id=auth.uid()) with check(recipient_id=auth.uid());
create policy runs_read on public.import_runs for select to authenticated using(internal.is_staff());

grant usage on schema public to authenticated;
grant select on public.departments,public.locations,public.actors,public.assets,public.movements,public.transfers,public.notifications,public.import_runs to authenticated;
grant insert,update on public.locations to authenticated;
grant update(role,name,department_id,location_id,active) on public.actors to authenticated;
grant update(viewed) on public.notifications to authenticated;

-- El procesamiento transaccional impide cargas parciales o consumo del mismo serial dos veces.
create or replace function public.pulso_process_batch(p_kind text,p_rows jsonb)
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
      v_to:=coalesce(v_to,v_from);
      if not exists(select 1 from public.locations where id=v_to) then raise exception 'Fila %: falta destino',v_row; end if;
      v_rec:=case when lower(coalesce(r->>'reception','')) like 'remanu%' then 'Remanufacturado' else 'Nuevo' end;
      v_stock:=case when upper(coalesce(r->>'stock_type','LIBRE'))='INVERSA' then 'INVERSA' else 'LIBRE' end;
      v_state:=case when v_stock='INVERSA' and exists(select 1 from public.locations where id=v_to and kind='TECNICO')
                  then 'PENDIENTE_DEVOLUCION'
                   when v_stock='INVERSA' then 'EN_BODEGA'
                   when exists(select 1 from public.locations where id=v_to and kind='TECNICO') then 'ASIGNADO'
                   else 'DISPONIBLE' end;
      if v_sap='' then raise exception 'Fila %: falta código SAP',v_row; end if;
      insert into public.assets(serial,serial_kind,sap,description,category,profile_type,reception,stock_type,state,location_id,source_doc,supplier,received_on)
      values (v_serial, case when upper(coalesce(r->>'serial_kind',''))='GENERICO' then 'GENERICO' else 'FISICO' end,
      v_sap,v_desc,coalesce(r->>'category',''),coalesce(r->>'profile_type','SIN PERFIL'),v_rec,v_stock,v_state,v_to,
      coalesce(r->>'document',''),coalesce(r->>'supplier',''),v_date) returning id into v_id;
   else
      if p_kind='RETIRO' and not found then
        if v_to is null or not exists(select 1 from public.locations where id=v_to and kind='TECNICO') then
          raise exception 'Fila %: selecciona técnico responsable del retiro',v_row; end if;
        insert into public.assets(serial,serial_kind,sap,description,category,profile_type,reception,stock_type,state,location_id,work_order,site_id,received_on)
        values (v_serial,case when upper(coalesce(r->>'serial_kind',''))='GENERICO' then 'GENERICO' else 'FISICO' end,
         v_sap,v_desc,coalesce(r->>'category',''),'SIN PERFIL','Remanufacturado',
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
            work_order=coalesce(r->>'ot',''),site_id=coalesce(r->>'site',''),updated_at=now() where id=v_id;
        elsif p_kind='DEVOLUCION' then
          if not exists(select 1 from public.locations where id=v_asset.location_id and kind='TECNICO') then
            raise exception 'Fila %: equipo no está en custodia de técnico',v_row; end if;
          if not exists(select 1 from public.locations where id=v_from and kind='BODEGA') then
            raise exception 'Fila %: bodega destino no válida',v_row; end if;
          v_to:=v_from; v_from:=v_asset.location_id;
          v_stock:=case when v_asset.stock_type='INVERSA' or upper(coalesce(r->>'reason','')) in ('GARANTIA','DESMONTE') then 'INVERSA' else 'LIBRE' end;
          update public.assets set location_id=v_to,stock_type=v_stock,
           state=case when v_stock='INVERSA' then 'EN_BODEGA' else 'DISPONIBLE' end,updated_at=now() where id=v_id;
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

create or replace function public.pulso_request_transfer(p_serial text,p_target uuid)
returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare a public.assets%rowtype; v_role text; v_loc uuid; t uuid;
begin
 v_role:=internal.actor_role();v_loc:=internal.actor_location();
 if v_role not in ('ADMIN','ASISTENTE','TECNICO') then raise exception 'No autorizado'; end if;
 select * into a from public.assets where serial=upper(btrim(p_serial)) for update;
 if not found or a.stock_type<>'LIBRE' or a.state<>'ASIGNADO' then raise exception 'Serial no disponible para transferencia'; end if;
 if v_role='TECNICO' and a.location_id<>v_loc then raise exception 'El equipo no pertenece a su inventario'; end if;
 if not exists(select 1 from public.locations where id=p_target and kind='TECNICO') then raise exception 'Destino inválido'; end if;
 if p_target=a.location_id then raise exception 'Origen y destino iguales'; end if;
 if exists(select 1 from public.transfers where asset_id=a.id and status in('SOLICITADA','PENDIENTE_RECEPCION')) then
 raise exception 'El serial ya tiene una transferencia activa'; end if;
 insert into public.transfers(asset_id,source_location,target_location,requested_by) values(a.id,a.location_id,p_target,auth.uid()) returning id into t;
 insert into public.notifications(recipient_id,transfer_id,title,body,urgency)
 select distinct x.id,t,'Transferencia solicitada','Pendiente de aprobación logística: '||a.serial,'NORMAL'
 from public.actors x where x.active and x.role in('ADMIN','ASISTENTE');
 return t;
end $$;

create or replace function public.pulso_transfer_action(p_id uuid,p_action text)
returns text language plpgsql security definer set search_path=pg_catalog,public as $$
declare t public.transfers%rowtype; a public.assets%rowtype; v_role text; v_src text;v_dst text;v_title text;
begin
 select * into t from public.transfers where id=p_id for update;
 if not found then raise exception 'Transferencia inexistente'; end if;
 select * into a from public.assets where id=t.asset_id for update;
 v_role:=internal.actor_role();
 if p_action='APROBAR' then
  if not internal.is_staff() or t.status<>'SOLICITADA' then raise exception 'No autorizada o en estado inválido'; end if;
  if a.location_id<>t.source_location or a.stock_type<>'LIBRE' or a.state<>'ASIGNADO' then raise exception 'Equipo ya no disponible'; end if;
  update public.assets set state='EN_TRANSITO',updated_at=now() where id=a.id;
  update public.transfers set status='PENDIENTE_RECEPCION',approved_by=auth.uid(),handed_at=now(),last_alert_at=now() where id=t.id;
  v_title:='Transferencia aprobada: recepción pendiente';
 elsif p_action='ACEPTAR' then
  if (not internal.is_staff() and not (v_role='TECNICO' and internal.actor_location()=t.target_location))
   or t.status<>'PENDIENTE_RECEPCION' then raise exception 'Solo receptor o logística puede aceptar'; end if;
  update public.assets set location_id=t.target_location,state='ASIGNADO',updated_at=now() where id=a.id;
  update public.transfers set status='ACEPTADA',closed_at=now() where id=t.id;
  insert into public.movements(asset_id,kind,source_location,target_location,actor_id,note)
  values(a.id,'TRANSFERENCIA',t.source_location,t.target_location,auth.uid(),'Recepción confirmada');
  v_title:='Transferencia recibida';
 elsif p_action in('RECHAZAR','CANCELAR') then
  if not internal.is_staff() and not (p_action='RECHAZAR' and v_role='TECNICO' and internal.actor_location()=t.target_location)
  then raise exception 'No autorizado'; end if;
  if t.status not in('SOLICITADA','PENDIENTE_RECEPCION') then raise exception 'Transferencia cerrada'; end if;
  if t.status='PENDIENTE_RECEPCION' then
    update public.assets set state='ASIGNADO',updated_at=now() where id=a.id;
  end if;
  update public.transfers set status=case when p_action='RECHAZAR' then 'RECHAZADA' else 'CANCELADA' end,closed_at=now() where id=t.id;
  v_title:='Transferencia '||lower(p_action)||': requiere revisión';
 else raise exception 'Acción inválida';end if;
 select department_id into v_src from public.locations where id=t.source_location;
 select department_id into v_dst from public.locations where id=t.target_location;
 insert into public.notifications(recipient_id,transfer_id,title,body,urgency)
 select distinct x.id,t.id,v_title, 'Serial '||a.serial||' · estado '||p_action,
 case when p_action='RECHAZAR' then 'CRITICO' else 'NORMAL' end
 from public.actors x where x.active and
 (x.role in('ADMIN','ASISTENTE') or (x.role='SUPERVISOR' and x.department_id in(v_src,v_dst))
 or x.location_id in(t.source_location,t.target_location));
 return p_action;
end $$;

create or replace function public.pulso_send_due_alerts()
returns integer language plpgsql security definer set search_path=pg_catalog,public as $$
declare t public.transfers%rowtype; v_src text;v_dst text;v_count integer:=0;v_urgency text;
begin
 -- Ejecución por pg_cron o por administrador; para usuarios ordinarios solo personal logístico.
 if auth.uid() is not null and not internal.is_staff() then raise exception 'No autorizado'; end if;
 for t in select * from public.transfers where status='PENDIENTE_RECEPCION'
  and handed_at <= now()-interval '6 hours'
  and last_alert_at<=now()-interval '6 hours'
  for update skip locked loop
   v_urgency:=case when now()-t.handed_at>=interval '24 hours' then 'CRITICO'
                   when now()-t.handed_at>=interval '12 hours' then 'ADVERTENCIA' else 'NORMAL' end;
   select department_id into v_src from public.locations where id=t.source_location;
   select department_id into v_dst from public.locations where id=t.target_location;
   insert into public.notifications(recipient_id,transfer_id,title,body,urgency)
   select distinct x.id,t.id,'Transferencia sin recibir ('||v_urgency||')',
     'Transferencia '||t.id::text||' pendiente hace más de '||floor(extract(epoch from(now()-t.handed_at))/3600)::int||' horas.',
     v_urgency
   from public.actors x where x.active and
    (x.role in('ADMIN','ASISTENTE') or (x.role='SUPERVISOR' and x.department_id in(v_src,v_dst))
    or x.location_id in(t.source_location,t.target_location));
   update public.transfers set last_alert_at=now() where id=t.id;
   v_count:=v_count+1;
 end loop;
 return v_count;
end $$;

revoke all on function public.pulso_process_batch(text,jsonb), public.pulso_request_transfer(text,uuid),
 public.pulso_transfer_action(uuid,text), public.pulso_send_due_alerts() from public;
grant execute on function public.pulso_process_batch(text,jsonb), public.pulso_request_transfer(text,uuid),
 public.pulso_transfer_action(uuid,text), public.pulso_send_due_alerts() to authenticated;
