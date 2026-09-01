-- ============================================================
-- Import agenzia strutturato (Sun&Sea / MTS Globe e futuri import simili).
--
-- Modello: SOURCE ROW(S) -> agency_bookings (contenitore commerciale) ->
-- services (uno o piu' record operativi generati). Distinto da booking_groups
-- (0263, contenitore per i giri bus Mario) e da import_id/inbound_emails
-- (flusso PDF agenzia): qui la "pratica" agenzia e' la riga primaria e i
-- services sono sempre derivati da una regola, mai inventati.
-- ============================================================

create table if not exists public.agency_bookings (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants(id) on delete cascade,

  source                text not null,                 -- es. 'mts_globe'
  source_import_id      uuid null,                      -- batch di import (audit, non FK per restare import-tool agnostico)
  source_booking_key    text not null,                  -- chiave idempotenza stabile (es. mts_globe:<voucher_no>)
  source_payload        jsonb not null default '{}'::jsonb,  -- righe originali grezze, per audit/debug

  agency_name           text null,
  booking_kind          text not null default 'transfer'
                           check (booking_kind in ('transfer', 'excursion')),
  service_scope         text not null default 'round_trip'
                           check (service_scope in ('round_trip', 'outbound_only', 'return_only')),

  customer_name         text null,
  pax                   integer not null default 1 check (pax > 0 and pax <= 60),
  hotel_id              uuid null references public.hotels(id) on delete set null,
  hotel_name_raw        text null,

  status                text not null default 'ready'
                           check (status in ('ready', 'warning', 'error', 'duplicate', 'update')),
  status_reasons        jsonb not null default '[]'::jsonb,

  created_by_user_id    uuid null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  unique (tenant_id, source, source_booking_key)
);

create index if not exists idx_agency_bookings_tenant
  on public.agency_bookings (tenant_id, created_at desc);
create index if not exists idx_agency_bookings_tenant_source
  on public.agency_bookings (tenant_id, source);

alter table public.agency_bookings enable row level security;

drop policy if exists agency_bookings_select_admin_operator on public.agency_bookings;
create policy agency_bookings_select_admin_operator on public.agency_bookings
  for select
  using (
    tenant_id = public.current_tenant_id()
    and public.current_user_role() in ('admin', 'operator', 'supervisor')
  );

drop policy if exists agency_bookings_write_admin_operator on public.agency_bookings;
create policy agency_bookings_write_admin_operator on public.agency_bookings
  for all
  using (
    tenant_id = public.current_tenant_id()
    and public.current_user_role() in ('admin', 'operator')
  )
  with check (
    tenant_id = public.current_tenant_id()
    and public.current_user_role() in ('admin', 'operator')
  );

-- services.agency_booking_id ------------------------------------------------
-- FK nullable verso il contenitore commerciale agenzia. Concetto diverso da
-- booking_group_id (giri bus), linked_service_id (2 gambe A/R manuali),
-- inbound_email_id (flusso PDF). ON DELETE SET NULL: eliminare la
-- prenotazione agenzia NON cancella i services operativi gia' generati.
alter table public.services
  add column if not exists agency_booking_id uuid null
    references public.agency_bookings(id) on delete set null;

create index if not exists idx_services_tenant_agency_booking
  on public.services (tenant_id, agency_booking_id)
  where agency_booking_id is not null;

comment on column public.services.agency_booking_id is
  'FK nullable verso agency_bookings (import agenzia strutturato, es. Sun&Sea/MTS Globe). Distinto da booking_group_id/linked_service_id/inbound_email_id.';
