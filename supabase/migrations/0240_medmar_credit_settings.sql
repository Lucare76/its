-- Credito Medmar gestito manualmente da impostazioni (sostituisce/integra il
-- fallback env MEDMAR_MANUAL_CREDIT_CENTS, che resta solo un fallback
-- opzionale/transitorio quando manca il setting DB).
--
-- credito_disponibile_stimato =
--   initial_credit_cents + somma(medmar_credit_topups.amount_cents)
--   - somma(medmar_issuing_attempts.final_total_cents dove status='completed')
--
-- Il credito si scala all'emissione/pagamento del biglietto (medmar_issuing_attempts
-- completed), non alla consegna email (medmar_delivery_attempts).

create table if not exists public.medmar_credit_settings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  initial_credit_cents integer not null default 0 check (initial_credit_cents >= 0),
  safety_threshold_cents integer not null default 20000 check (safety_threshold_cents >= 0),
  notes text null,
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now()),
  updated_by uuid null references auth.users(id) on delete set null,
  unique (tenant_id)
);

create table if not exists public.medmar_credit_topups (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  amount_cents integer not null check (amount_cents > 0),
  topup_date date not null default current_date,
  notes text null,
  created_at timestamptz not null default timezone('utc'::text, now()),
  created_by uuid null references auth.users(id) on delete set null
);

create index if not exists idx_medmar_credit_topups_tenant_date
  on public.medmar_credit_topups(tenant_id, topup_date desc);

create or replace function public.touch_medmar_credit_settings_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc'::text, now());
  return new;
end;
$$;

drop trigger if exists trg_medmar_credit_settings_updated_at on public.medmar_credit_settings;
create trigger trg_medmar_credit_settings_updated_at
before update on public.medmar_credit_settings
for each row execute function public.touch_medmar_credit_settings_updated_at();

alter table public.medmar_credit_settings enable row level security;
alter table public.medmar_credit_topups enable row level security;

-- Lettura: tutti i ruoli operativi del tenant (admin/operator/supervisor).
drop policy if exists medmar_credit_settings_select_ops on public.medmar_credit_settings;
create policy medmar_credit_settings_select_ops on public.medmar_credit_settings
for select using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator', 'supervisor')
);

-- Scrittura: solo admin/supervisor (operator legge, non modifica).
drop policy if exists medmar_credit_settings_insert_admin on public.medmar_credit_settings;
create policy medmar_credit_settings_insert_admin on public.medmar_credit_settings
for insert with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'supervisor')
);

drop policy if exists medmar_credit_settings_update_admin on public.medmar_credit_settings;
create policy medmar_credit_settings_update_admin on public.medmar_credit_settings
for update using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'supervisor')
) with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'supervisor')
);

drop policy if exists medmar_credit_topups_select_ops on public.medmar_credit_topups;
create policy medmar_credit_topups_select_ops on public.medmar_credit_topups
for select using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator', 'supervisor')
);

drop policy if exists medmar_credit_topups_insert_admin on public.medmar_credit_topups;
create policy medmar_credit_topups_insert_admin on public.medmar_credit_topups
for insert with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'supervisor')
);
