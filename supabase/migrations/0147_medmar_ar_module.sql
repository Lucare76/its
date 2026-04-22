-- ═══════════════════════════════════════════════════════════════════════════
-- Medmar A/R Module — tabelle separate, prefisso medmar_ar_*
-- NON modifica nulla della sezione "Biglietti Medmar" esistente
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Tariffe storicizzate ──────────────────────────────────────────────────
create table if not exists public.medmar_ar_prices (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  price_type   text not null check (price_type in (
                 'round_trip_per_leg',
                 'single_trip_under_12',
                 'single_trip_12_or_more'
               )),
  price_cents  integer not null check (price_cents > 0),
  valid_from   date not null,
  valid_to     date,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  constraint medmar_ar_prices_dates_check check (valid_to is null or valid_to >= valid_from)
);

comment on table public.medmar_ar_prices is 'Tariffe Medmar A/R storicizzate — mai sovrascrivere, sempre nuovo record';
comment on column public.medmar_ar_prices.price_cents is 'Prezzo in centesimi (es. 1025 = 10,25€)';

create index if not exists idx_medmar_ar_prices_tenant_type
  on public.medmar_ar_prices(tenant_id, price_type, valid_from desc);

alter table public.medmar_ar_prices enable row level security;

create policy medmar_ar_prices_select on public.medmar_ar_prices
  for select using (tenant_id = public.current_tenant_id());

create policy medmar_ar_prices_insert on public.medmar_ar_prices
  for insert with check (
    tenant_id = public.current_tenant_id()
    and public.current_user_role() in ('admin', 'operator', 'supervisor')
  );

-- ── 2. Biglietti ────────────────────────────────────────────────────────────
create table if not exists public.medmar_ar_tickets (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenants(id) on delete cascade,
  voucher_number       text not null,
  travel_date          date not null,
  route                text not null check (route in (
                         'pozzuoli_ischia',
                         'pozzuoli_casamicciola',
                         'napoli_ischia',
                         'napoli_casamicciola'
                       )),
  pax_count            integer not null check (pax_count > 0),
  ticket_mode          text not null check (ticket_mode in (
                         'round_trip',
                         'single_outbound',
                         'single_return'
                       )),
  outbound_time        time,
  return_time          time,
  unit_price_cents     integer not null check (unit_price_cents > 0),
  total_price_cents    integer not null check (total_price_cents > 0),
  issuing_operator_id  uuid references auth.users(id) on delete set null,
  notes                text,
  is_test_data         boolean not null default false,
  created_at           timestamptz not null default now(),
  constraint medmar_ar_tickets_voucher_date_unique unique (tenant_id, voucher_number, travel_date),
  constraint medmar_ar_tickets_outbound_required check (
    ticket_mode = 'single_return' or outbound_time is not null
  ),
  constraint medmar_ar_tickets_return_required check (
    ticket_mode != 'round_trip' or return_time is not null
  )
);

comment on table public.medmar_ar_tickets is 'Biglietti Medmar A/R emessi manualmente con voucher — modulo separato da Biglietti Medmar';
comment on column public.medmar_ar_tickets.unit_price_cents is 'Prezzo unitario a tratta in centesimi';
comment on column public.medmar_ar_tickets.total_price_cents is 'Totale = unit_price_cents × pax_count × n_tratte';

create index if not exists idx_medmar_ar_tickets_tenant_date
  on public.medmar_ar_tickets(tenant_id, travel_date desc);
create index if not exists idx_medmar_ar_tickets_tenant_route_date
  on public.medmar_ar_tickets(tenant_id, route, travel_date desc);

alter table public.medmar_ar_tickets enable row level security;

create policy medmar_ar_tickets_select on public.medmar_ar_tickets
  for select using (tenant_id = public.current_tenant_id());

create policy medmar_ar_tickets_insert on public.medmar_ar_tickets
  for insert with check (
    tenant_id = public.current_tenant_id()
    and public.current_user_role() in ('admin', 'operator', 'supervisor')
  );

create policy medmar_ar_tickets_update on public.medmar_ar_tickets
  for update using (
    tenant_id = public.current_tenant_id()
    and public.current_user_role() in ('admin', 'operator', 'supervisor')
  );

-- ── 3. Tratte del biglietto ──────────────────────────────────────────────────
create table if not exists public.medmar_ar_ticket_legs (
  id                      uuid primary key default gen_random_uuid(),
  tenant_id               uuid not null references public.tenants(id) on delete cascade,
  ticket_id               uuid not null references public.medmar_ar_tickets(id) on delete cascade,
  leg_type                text not null check (leg_type in ('outbound', 'return')),
  leg_time                time,
  leg_route               text not null,
  price_per_pax_cents     integer not null check (price_per_pax_cents > 0),
  status                  text not null default 'used' check (status in (
                            'used',
                            'available_for_reassignment',
                            'reassigned',
                            'lost',
                            'not_applicable'
                          )),
  original_booking_id     uuid references public.services(id) on delete set null,
  reassigned_booking_id   uuid references public.services(id) on delete set null,
  status_changed_at       timestamptz,
  status_changed_by       uuid references auth.users(id) on delete set null,
  created_at              timestamptz not null default now()
);

comment on table public.medmar_ar_ticket_legs is 'Singole tratte del biglietto A/R — permette tracking stato e riassegnazioni';

create index if not exists idx_medmar_ar_legs_ticket
  on public.medmar_ar_ticket_legs(ticket_id);
create index if not exists idx_medmar_ar_legs_tenant_status
  on public.medmar_ar_ticket_legs(tenant_id, status)
  where status in ('available_for_reassignment', 'reassigned');
create index if not exists idx_medmar_ar_legs_booking
  on public.medmar_ar_ticket_legs(original_booking_id) where original_booking_id is not null;

alter table public.medmar_ar_ticket_legs enable row level security;

create policy medmar_ar_legs_select on public.medmar_ar_ticket_legs
  for select using (tenant_id = public.current_tenant_id());

create policy medmar_ar_legs_insert on public.medmar_ar_ticket_legs
  for insert with check (
    tenant_id = public.current_tenant_id()
    and public.current_user_role() in ('admin', 'operator', 'supervisor')
  );

create policy medmar_ar_legs_update on public.medmar_ar_ticket_legs
  for update using (
    tenant_id = public.current_tenant_id()
    and public.current_user_role() in ('admin', 'operator', 'supervisor')
  );

-- ── 4. Gruppi in attesa (pending grouping) ───────────────────────────────────
create table if not exists public.medmar_ar_pending_groups (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  travel_date         date not null,
  route               text not null,
  outbound_time       time,
  current_pax_count   integer not null default 0,
  target_threshold    integer not null default 12,
  booking_ids         uuid[] not null default '{}',
  status              text not null default 'pending' check (status in (
                        'pending',
                        'reached_threshold',
                        'expired',
                        'converted_to_ticket'
                      )),
  converted_ticket_id uuid references public.medmar_ar_tickets(id) on delete set null,
  expires_at          timestamptz not null,
  created_by          uuid references auth.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists idx_medmar_ar_pending_tenant_status
  on public.medmar_ar_pending_groups(tenant_id, status)
  where status = 'pending';

alter table public.medmar_ar_pending_groups enable row level security;

create policy medmar_ar_pending_select on public.medmar_ar_pending_groups
  for select using (tenant_id = public.current_tenant_id());

create policy medmar_ar_pending_insert on public.medmar_ar_pending_groups
  for insert with check (
    tenant_id = public.current_tenant_id()
    and public.current_user_role() in ('admin', 'operator', 'supervisor')
  );

create policy medmar_ar_pending_update on public.medmar_ar_pending_groups
  for update using (
    tenant_id = public.current_tenant_id()
    and public.current_user_role() in ('admin', 'operator', 'supervisor')
  );

create or replace function public.set_medmar_ar_pending_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

drop trigger if exists trg_medmar_ar_pending_updated_at on public.medmar_ar_pending_groups;
create trigger trg_medmar_ar_pending_updated_at
  before update on public.medmar_ar_pending_groups
  for each row execute function public.set_medmar_ar_pending_updated_at();

-- ── 5. Seed tariffe iniziali (tenant-agnostic: inserite dal seeding applicativo)
-- Le tariffe vengono inserite via API al primo accesso del modulo se assenti.
-- Questo migration non inserisce dati tenant-specifici.
