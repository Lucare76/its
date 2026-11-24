-- Keep invoice data separate from the manually entered fuel record. A card's
-- assigned plate is not proof of which vehicle was actually refuelled.
alter table public.vehicle_fuel add column if not exists invoice_supplier text null
  check (invoice_supplier is null or invoice_supplier in ('ENI', 'UTA'));
alter table public.vehicle_fuel add column if not exists last_edited_by uuid null references auth.users(id) on delete set null;

create table if not exists public.vehicle_fuel_manual_history (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  fuel_id uuid not null references public.vehicle_fuel(id) on delete cascade,
  old_cost numeric(10,2), new_cost numeric(10,2),
  old_liters numeric(8,2), new_liters numeric(8,2),
  edited_by uuid references auth.users(id) on delete set null,
  edited_at timestamptz not null default now()
);
alter table public.vehicle_fuel_manual_history enable row level security;
revoke all on public.vehicle_fuel_manual_history from anon, authenticated;
grant select on public.vehicle_fuel_manual_history to authenticated;
create policy vehicle_fuel_manual_history_read on public.vehicle_fuel_manual_history for select to authenticated
  using (exists (select 1 from public.memberships m where m.tenant_id = vehicle_fuel_manual_history.tenant_id
    and m.user_id = auth.uid() and m.role in ('admin', 'operator', 'supervisor')));
create or replace function public.audit_vehicle_fuel_manual_change() returns trigger language plpgsql
  set search_path = '' as $$
begin
  if old.cost is distinct from new.cost or old.liters is distinct from new.liters then
    insert into public.vehicle_fuel_manual_history(tenant_id, fuel_id, old_cost, new_cost, old_liters, new_liters, edited_by)
      values (old.tenant_id, old.id, old.cost, new.cost, old.liters, new.liters, new.last_edited_by);
  end if;
  return new;
end;
$$;
drop trigger if exists audit_vehicle_fuel_manual_change on public.vehicle_fuel;
create trigger audit_vehicle_fuel_manual_change after update on public.vehicle_fuel
  for each row execute function public.audit_vehicle_fuel_manual_change();

create table if not exists public.fuel_invoice_imports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  supplier text not null check (supplier in ('ENI', 'UTA')),
  invoice_number text not null,
  pdf_sha256 text not null,
  filename text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (tenant_id, supplier, pdf_sha256)
);
create table if not exists public.fuel_invoice_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  import_id uuid not null references public.fuel_invoice_imports(id) on delete cascade,
  line_no integer not null,
  fuel_date date not null,
  station text not null,
  liters numeric(8,2) not null,
  amount numeric(10,2) not null,
  reference text not null,
  matched_fuel_id uuid references public.vehicle_fuel(id) on delete set null,
  matched_at timestamptz,
  matched_by uuid references auth.users(id) on delete set null,
  unique (import_id, line_no)
);
create unique index if not exists fuel_invoice_lines_unique_match
  on public.fuel_invoice_lines(tenant_id, matched_fuel_id) where matched_fuel_id is not null;
create index if not exists fuel_invoice_lines_import_idx on public.fuel_invoice_lines(tenant_id, import_id);

alter table public.fuel_invoice_imports enable row level security;
alter table public.fuel_invoice_lines enable row level security;
-- Mutations are guarded in the server routes; keep service role as sole writer.
revoke all on public.fuel_invoice_imports, public.fuel_invoice_lines from anon, authenticated;
grant select on public.fuel_invoice_imports, public.fuel_invoice_lines to authenticated;
create policy fuel_invoice_imports_read on public.fuel_invoice_imports for select to authenticated
  using (exists (select 1 from public.memberships m where m.tenant_id = fuel_invoice_imports.tenant_id
    and m.user_id = auth.uid() and m.role in ('admin', 'operator', 'supervisor')));
create policy fuel_invoice_lines_read on public.fuel_invoice_lines for select to authenticated
  using (exists (select 1 from public.memberships m where m.tenant_id = fuel_invoice_lines.tenant_id
    and m.user_id = auth.uid() and m.role in ('admin', 'operator', 'supervisor')));
