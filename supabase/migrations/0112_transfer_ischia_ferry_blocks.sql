-- Migration 0112: Transfer Ischia — blocchi traghetto e passeggeri
--
-- Estende il sistema pickup_runs per gestire:
-- 1. Blocchi traghetto colorati per linea bus (Centro/Adriatica/Italia)
-- 2. Collegamento diretto tra servizi Formula Medmar/SNAV e blocchi traghetto
-- 3. Direzione arrivo/partenza per ciascun blocco
-- 4. Tracciamento passeggero spostato su bus smistamento (alert accettato)
--
-- Logica blocchi:
--   Linea Centro   → Pozzuoli → Casamicciola 12:00  🔵 blu
--   Linea Adriatica → Pozzuoli → Ischia Porto 13:30  🟠 arancio
--   Linea Italia   → Pozzuoli → Casamicciola 18:30  🟣 viola
--   Altri traghetti → blocchi autonomi creati automaticamente
--   Regola raggruppamento: stesso porto + arrivo entro 30 min → stesso blocco

-- ── 1. Estendi pickup_runs con linea bus e direzione ──────────────────────────

alter table public.pickup_runs
  add column if not exists direction            text not null default 'arrival'
    check (direction in ('arrival', 'departure')),
  add column if not exists bus_line_family_code text null,   -- 'centro' | 'adriatica' | 'italia' | null
  add column if not exists line_color           text null;   -- es. '#3b82f6' | '#f97316' | '#8b5cf6' | null

comment on column public.pickup_runs.direction is
  'arrival = traghetto in arrivo a Ischia, departure = traghetto in partenza da Ischia';

comment on column public.pickup_runs.bus_line_family_code is
  'Se il blocco coincide con una linea bus organizzata (centro/adriatica/italia), codice famiglia. Null per blocchi autonomi Transfer Ischia.';

comment on column public.pickup_runs.line_color is
  'Colore HEX assegnato alla linea bus per la UI. Null per blocchi autonomi.';

-- ── 2. Tabella pickup_run_services ────────────────────────────────────────────
-- Collega un servizio Formula Medmar/SNAV (dalla tabella services) a un blocco
-- traghetto. Creata automaticamente all'import del servizio.
-- Quando l'operatore accetta l'alert e sposta il passeggero su un bus di
-- smistamento linea, il campo moved_to_dist_bus_id viene valorizzato.

create table if not exists public.pickup_run_services (
  id                   uuid    primary key default gen_random_uuid(),
  tenant_id            uuid    not null references public.tenants (id) on delete cascade,
  run_id               uuid    not null references public.pickup_runs (id) on delete cascade,
  service_id           uuid    null references public.services (id) on delete set null,

  -- Dati passeggero copiati al momento del collegamento (per export Excel e UI)
  passenger_name       text    not null,
  passenger_phone      text    null,
  hotel_id             uuid    null references public.hotels (id) on delete set null,
  hotel_name           text    not null,
  hotel_zone           text    null,   -- zona hotel per matching alert (es. 'forio', 'ischia')
  pax                  integer not null default 1 check (pax > 0),

  -- Se l'operatore accetta l'alert e sposta il passeggero su un bus smistamento
  -- linea, questo campo viene valorizzato con l'id del bus di destinazione.
  moved_to_dist_bus_id uuid    null references public.bus_ischia_dist_buses (id) on delete set null,

  created_at           timestamptz not null default now()
);

create index if not exists idx_pickup_run_services_run
  on public.pickup_run_services (run_id);

create index if not exists idx_pickup_run_services_service
  on public.pickup_run_services (service_id);

create index if not exists idx_pickup_run_services_tenant_date
  on public.pickup_run_services (tenant_id);

-- Vincolo: stesso servizio non può stare in due blocchi diversi
create unique index if not exists pickup_run_services_service_unique
  on public.pickup_run_services (service_id)
  where service_id is not null;

alter table public.pickup_run_services enable row level security;

drop policy if exists pickup_run_services_select on public.pickup_run_services;
create policy pickup_run_services_select on public.pickup_run_services
  for select using (tenant_id = public.current_tenant_id());

drop policy if exists pickup_run_services_admin_all on public.pickup_run_services;
create policy pickup_run_services_admin_all on public.pickup_run_services
  for all
  using (
    tenant_id = public.current_tenant_id()
    and public.current_user_role() in ('admin', 'operator')
  )
  with check (
    tenant_id = public.current_tenant_id()
    and public.current_user_role() in ('admin', 'operator')
  );

-- ── 3. Seed: mappa linee bus → blocchi traghetto fissi ────────────────────────
-- I 3 blocchi principali vengono creati automaticamente ogni domenica dal
-- backend quando si accede alla pagina. Questa tabella di config permette
-- di sapere quale family_code corrisponde a quale orario/porto/colore.

create table if not exists public.bus_line_ferry_config (
  id                   uuid    primary key default gen_random_uuid(),
  tenant_id            uuid    not null references public.tenants (id) on delete cascade,
  bus_line_family_code text    not null,          -- 'centro' | 'adriatica' | 'italia'
  departure_port       text    not null,          -- 'pozzuoli'
  arrival_port         text    not null,          -- 'ischia_porto' | 'casamicciola'
  departure_time       time    not null,          -- orario partenza da Pozzuoli
  line_color           text    not null,          -- colore HEX per la UI
  line_label           text    not null,          -- etichetta UI es. 'Linea Centro'
  sort_order           integer not null default 0,
  unique (tenant_id, bus_line_family_code)
);

alter table public.bus_line_ferry_config enable row level security;

drop policy if exists bus_line_ferry_config_select on public.bus_line_ferry_config;
create policy bus_line_ferry_config_select on public.bus_line_ferry_config
  for select using (tenant_id = public.current_tenant_id());

drop policy if exists bus_line_ferry_config_admin_all on public.bus_line_ferry_config;
create policy bus_line_ferry_config_admin_all on public.bus_line_ferry_config
  for all
  using (
    tenant_id = public.current_tenant_id()
    and public.current_user_role() in ('admin', 'supervisor')
  )
  with check (
    tenant_id = public.current_tenant_id()
    and public.current_user_role() in ('admin', 'supervisor')
  );

-- Seed per tenant Ischia Transfer Service
insert into public.bus_line_ferry_config
  (tenant_id, bus_line_family_code, departure_port, arrival_port, departure_time, line_color, line_label, sort_order)
values
  ('d200b89a-64c7-4f8d-a430-95a33b83047a', 'centro',    'pozzuoli', 'casamicciola', '12:00', '#3b82f6', 'Linea Centro',    1),
  ('d200b89a-64c7-4f8d-a430-95a33b83047a', 'adriatica', 'pozzuoli', 'ischia_porto', '13:30', '#f97316', 'Linea Adriatica', 2),
  ('d200b89a-64c7-4f8d-a430-95a33b83047a', 'italia',    'pozzuoli', 'casamicciola', '18:30', '#8b5cf6', 'Linea Italia',    3)
on conflict (tenant_id, bus_line_family_code) do update set
  departure_port = excluded.departure_port,
  arrival_port   = excluded.arrival_port,
  departure_time = excluded.departure_time,
  line_color     = excluded.line_color,
  line_label     = excluded.line_label,
  sort_order     = excluded.sort_order;
