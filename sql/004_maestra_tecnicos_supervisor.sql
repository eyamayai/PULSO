-- Ampliación no destructiva de la maestra de técnicos
alter table public.locations add column if not exists supervisor_name text not null default '';
comment on column public.locations.supervisor_name is 'Supervisor de referencia para técnicos; las restricciones de acceso siguen definidas por departamento y rol.';
