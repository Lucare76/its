-- Identify the physical card by an office alias and last four digits only.
-- Never store PIN, verification code or full prepaid-card number here.
create table if not exists public.fuel_cards (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  label text not null,
  last_four text check (last_four is null or last_four ~ '^[0-9]{4}$'),
  supplier text,
  assigned_driver_id uuid references public.driver_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (tenant_id, label)
);
create table if not exists public.fuel_card_assignments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  card_id uuid not null references public.fuel_cards(id) on delete cascade,
  driver_id uuid not null references public.driver_profiles(id) on delete cascade,
  assigned_at timestamptz not null default now(),
  returned_at timestamptz,
  changed_by uuid references auth.users(id) on delete set null
);
create unique index if not exists fuel_card_assignments_one_current
  on public.fuel_card_assignments(card_id) where returned_at is null;
create index if not exists fuel_card_assignments_tenant_idx on public.fuel_card_assignments(tenant_id, assigned_at desc);
alter table public.fuel_cards enable row level security;
alter table public.fuel_card_assignments enable row level security;
revoke all on public.fuel_cards, public.fuel_card_assignments from anon, authenticated;
grant select on public.fuel_cards, public.fuel_card_assignments to authenticated;
create policy fuel_cards_read on public.fuel_cards for select to authenticated
  using (exists (select 1 from public.memberships m where m.tenant_id = fuel_cards.tenant_id
    and m.user_id = auth.uid() and m.role in ('admin', 'operator', 'supervisor')));
create policy fuel_card_assignments_read on public.fuel_card_assignments for select to authenticated
  using (exists (select 1 from public.memberships m where m.tenant_id = fuel_card_assignments.tenant_id
    and m.user_id = auth.uid() and m.role in ('admin', 'operator', 'supervisor')));

create or replace function public.assign_fuel_card(
  p_tenant_id uuid, p_card_id uuid, p_driver_id uuid, p_actor_id uuid
) returns void language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.fuel_cards where id = p_card_id and tenant_id = p_tenant_id for update;
  if not found then raise exception 'Carta non trovata'; end if;
  if p_driver_id is not null and not exists (
    select 1 from public.driver_profiles where id = p_driver_id and tenant_id = p_tenant_id
  ) then raise exception 'Autista non trovato'; end if;
  update public.fuel_card_assignments set returned_at = now()
    where tenant_id = p_tenant_id and card_id = p_card_id and returned_at is null;
  update public.fuel_cards set assigned_driver_id = p_driver_id
    where id = p_card_id and tenant_id = p_tenant_id;
  if p_driver_id is not null then
    insert into public.fuel_card_assignments(tenant_id, card_id, driver_id, changed_by)
      values (p_tenant_id, p_card_id, p_driver_id, p_actor_id);
  end if;
end;
$$;
revoke all on function public.assign_fuel_card(uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.assign_fuel_card(uuid, uuid, uuid, uuid) to service_role;
