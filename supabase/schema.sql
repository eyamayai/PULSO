-- PULSO v0.1
-- Plataforma Unificada de Logística, Seguimiento y Operaciones
-- Modelo inicial preparado para Supabase/PostgreSQL.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  role text not null default 'OPERADOR' check (role in ('ADMIN','OPERADOR','CONSULTA')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  organization_type text not null default 'ALIADO',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);

create table if not exists public.sap_centers (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);

create table if not exists public.locations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  department text,
  center_id uuid references public.sap_centers(id),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  unique (name, department)
);

create table if not exists public.sap_warehouses (
  id uuid primary key default gen_random_uuid(),
  center_id uuid not null references public.sap_centers(id),
  code text not null,
  name text not null,
  organization_id uuid references public.organizations(id),
  location_id uuid references public.locations(id),
  warehouse_type text not null default 'OTRO' check (warehouse_type in ('A','U','OTRO')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  unique (center_id, code)
);

create table if not exists public.materials (
  id uuid primary key default gen_random_uuid(),
  sap_code text not null unique,
  description text not null,
  category text,
  serialized boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);

-- Un serial existe una sola vez en PULSO, aunque tenga múltiples ingresos o ciclos.
create table if not exists public.equipment (
  id uuid primary key default gen_random_uuid(),
  serial text not null unique,
  material_id uuid not null references public.materials(id),
  current_status text not null default 'SIN_DETERMINAR',
  current_warehouse_id uuid references public.sap_warehouses(id),
  active boolean not null default true,
  first_seen_at date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);

create table if not exists public.receipts (
  id uuid primary key default gen_random_uuid(),
  pulso_code text not null unique,
  effective_date date not null,
  record_origin text not null default 'OPERATIVO'
    check (record_origin in ('OPERATIVO','HISTORICO','IMPORTACION')),
  info_status text not null default 'COMPLETO'
    check (info_status in ('COMPLETO','INCOMPLETO','REVISION')),
  source_organization_id uuid references public.organizations(id),
  source_warehouse_id uuid references public.sap_warehouses(id),
  destination_warehouse_id uuid not null references public.sap_warehouses(id),
  source_document text,
  notes text,
  registered_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

create table if not exists public.receipt_items (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null references public.receipts(id) on delete cascade,
  material_id uuid not null references public.materials(id),
  equipment_id uuid references public.equipment(id),
  serial_snapshot text,
  quantity numeric(12,3) not null default 1 check (quantity > 0),
  reception_type text not null check (reception_type in ('Nuevo','Remanufacturado')),
  lot_type text not null check (lot_type in ('VALORADO','NOVALORADO')),
  created_at timestamptz not null default now(),
  constraint receipt_item_serial_logic check (
    (equipment_id is not null and quantity = 1)
    or
    (equipment_id is null)
  )
);

-- Un movimiento representa un hecho logístico con fecha efectiva.
-- La fecha de creación indica cuándo fue incorporado a PULSO.
create table if not exists public.movements (
  id uuid primary key default gen_random_uuid(),
  pulso_code text unique,
  movement_type text not null,
  effective_at timestamptz not null,
  record_origin text not null default 'OPERATIVO'
    check (record_origin in ('OPERATIVO','HISTORICO','IMPORTACION')),
  source_warehouse_id uuid references public.sap_warehouses(id),
  destination_warehouse_id uuid references public.sap_warehouses(id),
  source_organization_id uuid references public.organizations(id),
  destination_organization_id uuid references public.organizations(id),
  source_document text,
  related_receipt_id uuid references public.receipts(id),
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);

create table if not exists public.movement_items (
  id uuid primary key default gen_random_uuid(),
  movement_id uuid not null references public.movements(id) on delete cascade,
  material_id uuid not null references public.materials(id),
  equipment_id uuid references public.equipment(id),
  quantity numeric(12,3) not null default 1 check (quantity > 0),
  status_after text,
  created_at timestamptz not null default now(),
  constraint movement_item_serial_logic check (
    (equipment_id is not null and quantity = 1)
    or
    (equipment_id is null)
  )
);

create table if not exists public.audit_log (
  id bigint generated always as identity primary key,
  table_name text not null,
  record_id text,
  action text not null,
  changed_at timestamptz not null default now(),
  changed_by uuid references auth.users(id),
  old_data jsonb,
  new_data jsonb
);

create index if not exists idx_receipts_effective_date on public.receipts(effective_date desc);
create index if not exists idx_receipts_record_origin on public.receipts(record_origin);
create index if not exists idx_equipment_serial on public.equipment(serial);
create index if not exists idx_movements_effective_at on public.movements(effective_at desc);
create index if not exists idx_movement_items_equipment on public.movement_items(equipment_id);
create index if not exists idx_receipt_items_equipment on public.receipt_items(equipment_id);

-- Auditoría genérica para maestros y hechos críticos.
create or replace function public.pulso_audit_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.audit_log(table_name, record_id, action, changed_by, old_data, new_data)
  values (
    TG_TABLE_NAME,
    coalesce((case when TG_OP = 'DELETE' then OLD.id else NEW.id end)::text, null),
    TG_OP,
    auth.uid(),
    case when TG_OP in ('UPDATE','DELETE') then to_jsonb(OLD) else null end,
    case when TG_OP in ('INSERT','UPDATE') then to_jsonb(NEW) else null end
  );
  return case when TG_OP = 'DELETE' then OLD else NEW end;
end;
$$;

drop trigger if exists trg_audit_receipts on public.receipts;
create trigger trg_audit_receipts after insert or update or delete on public.receipts
for each row execute function public.pulso_audit_trigger();

drop trigger if exists trg_audit_warehouses on public.sap_warehouses;
create trigger trg_audit_warehouses after insert or update or delete on public.sap_warehouses
for each row execute function public.pulso_audit_trigger();

drop trigger if exists trg_audit_materials on public.materials;
create trigger trg_audit_materials after insert or update or delete on public.materials
for each row execute function public.pulso_audit_trigger();

drop trigger if exists trg_audit_equipment on public.equipment;
create trigger trg_audit_equipment after insert or update or delete on public.equipment
for each row execute function public.pulso_audit_trigger();

-- RLS. En v0.1 cualquier usuario autenticado puede operar.
-- En una iteración posterior se restringirá por rol y ubicación.
alter table public.profiles enable row level security;
alter table public.organizations enable row level security;
alter table public.sap_centers enable row level security;
alter table public.locations enable row level security;
alter table public.sap_warehouses enable row level security;
alter table public.materials enable row level security;
alter table public.equipment enable row level security;
alter table public.receipts enable row level security;
alter table public.receipt_items enable row level security;
alter table public.movements enable row level security;
alter table public.movement_items enable row level security;
alter table public.audit_log enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array[
    'profiles','organizations','sap_centers','locations','sap_warehouses',
    'materials','equipment','receipts','receipt_items','movements','movement_items'
  ]
  loop
    execute format('drop policy if exists authenticated_all on public.%I', t);
    execute format(
      'create policy authenticated_all on public.%I for all to authenticated using (true) with check (true)',
      t
    );
  end loop;
end $$;

drop policy if exists authenticated_read_audit on public.audit_log;
create policy authenticated_read_audit on public.audit_log
for select to authenticated using (true);

-- Datos maestros conocidos al inicio del proyecto.
insert into public.organizations(name, organization_type)
values ('Dominion','ALIADO')
on conflict (name) do nothing;

insert into public.sap_centers(code, name)
values ('C903','Costa'), ('C901','Centro')
on conflict (code) do update set name = excluded.name;

insert into public.locations(name, department, center_id)
values
  ('Riohacha','La Guajira',(select id from public.sap_centers where code='C903')),
  ('Valledupar','Cesar',(select id from public.sap_centers where code='C903')),
  ('Aguachica','Cesar',(select id from public.sap_centers where code='C903')),
  ('San Andrés','San Andrés, Providencia y Santa Catalina',(select id from public.sap_centers where code='C901'))
on conflict (name, department) do update set center_id = excluded.center_id;

insert into public.sap_warehouses(center_id, code, name, organization_id, location_id, warehouse_type)
values
(
  (select id from public.sap_centers where code='C903'),
  'A221',
  'Riohacha A',
  (select id from public.organizations where name='Dominion'),
  (select id from public.locations where name='Riohacha'),
  'A'
),
(
  (select id from public.sap_centers where code='C903'),
  'U020',
  'Riohacha U',
  (select id from public.organizations where name='Dominion'),
  (select id from public.locations where name='Riohacha'),
  'U'
)
on conflict (center_id, code) do update
set name = excluded.name,
    organization_id = excluded.organization_id,
    location_id = excluded.location_id,
    warehouse_type = excluded.warehouse_type;


-- Permisos explícitos para Data API.
-- La creación automática de privilegios está desactivada en el proyecto PULSO.
grant usage on schema public to authenticated;
grant select, insert, update, delete on
  public.profiles,
  public.organizations,
  public.sap_centers,
  public.locations,
  public.sap_warehouses,
  public.materials,
  public.equipment,
  public.receipts,
  public.receipt_items,
  public.movements,
  public.movement_items
to authenticated;

grant select on public.audit_log to authenticated;
grant usage, select on all sequences in schema public to authenticated;
