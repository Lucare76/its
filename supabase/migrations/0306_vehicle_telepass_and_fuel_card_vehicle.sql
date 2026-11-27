-- Flotta: Telepass per mezzo (dispositivo + fatture) e carte carburante
-- abbinate al mezzo, tutto con storico.
--
-- Accesso SOLO dalle API (service role + filtro tenant): RLS attiva senza
-- policy per anon/authenticated. Le fatture Telepass stanno nel bucket
-- privato vehicle-documents sotto
--   <tenant_id>/telepass/<invoice_id>/<timestamp>_<nome>
-- caricate con link firmato dal server, come le fatture di manutenzione.

-- 1. Dispositivi Telepass: una riga per periodo di installazione su un mezzo.
--    Spostare il dispositivo = chiudere la riga (removed_on) e aprirne un'altra.
create table if not exists public.vehicle_telepass_devices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  vehicle_id uuid not null references public.vehicles(id) on delete cascade,
  device_code text not null check (device_code ~ '^[A-Za-z0-9][A-Za-z0-9 -]{2,38}[A-Za-z0-9]$'),
  contract_ref text null check (contract_ref is null or char_length(contract_ref) <= 80),
  assigned_on date not null default current_date,
  removed_on date null,
  note text null check (note is null or char_length(note) <= 500),
  created_by uuid null references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint vehicle_telepass_devices_period_check check (removed_on is null or removed_on >= assigned_on)
);
-- Lo stesso dispositivo può essere attivo su un solo mezzo alla volta.
create unique index if not exists vehicle_telepass_devices_one_active
  on public.vehicle_telepass_devices(tenant_id, upper(replace(device_code, ' ', ''))) where removed_on is null;
create index if not exists vehicle_telepass_devices_vehicle_idx
  on public.vehicle_telepass_devices(tenant_id, vehicle_id, assigned_on desc);

-- 2. Fatture Telepass: una per mezzo (Telepass fattura ogni dispositivo a parte).
create table if not exists public.vehicle_telepass_invoices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  vehicle_id uuid not null references public.vehicles(id) on delete cascade,
  device_id uuid null references public.vehicle_telepass_devices(id) on delete set null,
  invoice_number text not null check (char_length(btrim(invoice_number)) between 1 and 60),
  invoice_date date not null,
  period_from date null,
  period_to date null,
  amount numeric(10,2) null check (amount is null or amount >= 0),
  note text null check (note is null or char_length(note) <= 500),
  document_path text null,
  document_name text null,
  document_uploaded_at timestamptz null,
  created_by uuid null references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint vehicle_telepass_invoices_period_check
    check (period_from is null or period_to is null or period_to >= period_from),
  -- "is not null" espliciti: una CHECK che vale NULL passa.
  constraint vehicle_telepass_invoices_document_check check (
    (document_path is null and document_name is null and document_uploaded_at is null)
    or (document_path is not null and document_name is not null and document_uploaded_at is not null
        and document_path like tenant_id::text || '/telepass/' || id::text || '/%'
        and char_length(document_path) <= 500 and char_length(document_name) <= 240)
  )
);
create unique index if not exists vehicle_telepass_invoices_number_unique
  on public.vehicle_telepass_invoices(tenant_id, vehicle_id, upper(btrim(invoice_number)));
create index if not exists vehicle_telepass_invoices_vehicle_idx
  on public.vehicle_telepass_invoices(tenant_id, vehicle_id, invoice_date desc);

-- 3. Carte carburante abbinate al mezzo (l'abbinamento all'autista resta).
alter table public.fuel_cards
  add column if not exists assigned_vehicle_id uuid null references public.vehicles(id) on delete set null;
create index if not exists fuel_cards_assigned_vehicle_idx
  on public.fuel_cards(tenant_id, assigned_vehicle_id) where assigned_vehicle_id is not null;

create table if not exists public.fuel_card_vehicle_assignments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  card_id uuid not null references public.fuel_cards(id) on delete cascade,
  vehicle_id uuid not null references public.vehicles(id) on delete cascade,
  assigned_at timestamptz not null default now(),
  returned_at timestamptz null,
  changed_by uuid null references auth.users(id) on delete set null
);
create unique index if not exists fuel_card_vehicle_assignments_one_current
  on public.fuel_card_vehicle_assignments(card_id) where returned_at is null;
create index if not exists fuel_card_vehicle_assignments_vehicle_idx
  on public.fuel_card_vehicle_assignments(tenant_id, vehicle_id, assigned_at desc);

create or replace function public.assign_fuel_card_vehicle(
  p_tenant_id uuid, p_card_id uuid, p_vehicle_id uuid, p_actor_id uuid
) returns void language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.fuel_cards where id = p_card_id and tenant_id = p_tenant_id for update;
  if not found then raise exception 'Carta non trovata'; end if;
  if p_vehicle_id is not null and not exists (
    select 1 from public.vehicles where id = p_vehicle_id and tenant_id = p_tenant_id and decommissioned_at is null
  ) then raise exception 'Mezzo non trovato o dismesso'; end if;
  update public.fuel_card_vehicle_assignments set returned_at = now()
    where tenant_id = p_tenant_id and card_id = p_card_id and returned_at is null;
  update public.fuel_cards set assigned_vehicle_id = p_vehicle_id
    where id = p_card_id and tenant_id = p_tenant_id;
  if p_vehicle_id is not null then
    insert into public.fuel_card_vehicle_assignments(tenant_id, card_id, vehicle_id, changed_by)
      values (p_tenant_id, p_card_id, p_vehicle_id, p_actor_id);
  end if;
end;
$$;
revoke all on function public.assign_fuel_card_vehicle(uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.assign_fuel_card_vehicle(uuid, uuid, uuid, uuid) to service_role;

alter table public.vehicle_telepass_devices enable row level security;
alter table public.vehicle_telepass_invoices enable row level security;
alter table public.fuel_card_vehicle_assignments enable row level security;
revoke all on public.vehicle_telepass_devices, public.vehicle_telepass_invoices,
  public.fuel_card_vehicle_assignments from anon, authenticated;
