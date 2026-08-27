-- Migration 0254: ferry_pickup_rules diventa bidirezionale (ARRIVO + PARTENZA)
--
-- Oggi la tabella copre solo ARRIVI (mainland -> Ischia, vedi
-- resolveFerrySbarco/findFerryPickupRule). Questa migration aggiunge le
-- colonne necessarie per rappresentare anche regole di PARTENZA
-- (Ischia -> mainland), con supporto a override hotel-specifici che battono
-- le regole di zona generiche (vedi lib/operational-connection-resolver.ts).
--
-- Additiva, nessuna perdita dati: le 60 righe esistenti (seed 0187) restano
-- invariate e assumono direction='to_ischia' via DEFAULT, senza bisogno di
-- backfill esplicito.

alter table public.ferry_pickup_rules
  add column if not exists direction text not null default 'to_ischia'
    check (direction in ('to_ischia', 'from_ischia')),
  add column if not exists hotel_id uuid references public.hotels(id) on delete set null,
  add column if not exists zone text,
  add column if not exists pickup_time time,
  add column if not exists embark_port text;

comment on column public.ferry_pickup_rules.direction is
  'to_ischia = ARRIVO (mainland -> Ischia, comportamento legacy). from_ischia = PARTENZA (Ischia -> mainland, nuovo).';
comment on column public.ferry_pickup_rules.hotel_id is
  'Solo direction=from_ischia. Regola hotel-specifica: batte sempre una regola di zona/generale per lo stesso hotel. NULL = non specifica per hotel.';
comment on column public.ferry_pickup_rules.zone is
  'Solo direction=from_ischia. NULL = jolly (qualunque zona, o regola generale se hotel_id è anche NULL). Valori canonici osservati in hotels.zone (case-insensitive): forio, lacco ameno, casamicciola, ischia porto/ischia ponte (-> "ischia").';
comment on column public.ferry_pickup_rules.pickup_time is
  'Solo direction=from_ischia. Orario di prelievo hotel.';
comment on column public.ferry_pickup_rules.embark_port is
  'Solo direction=from_ischia. Porto di imbarco su Ischia (ischia_porto | casamicciola).';
comment on column public.ferry_pickup_rules.arrival_port is
  'Porto di destinazione della corsa: per direction=to_ischia è un porto su Ischia (ischia_porto|casamicciola); per direction=from_ischia è un porto sul continente (napoli_beverello|pozzuoli).';

create index if not exists ferry_pickup_rules_departure_lookup_idx
  on public.ferry_pickup_rules (agency_logic, direction, transport_type, hotel_id, zone, boat_type, transport_from);

-- ─── Rollback (da eseguire manualmente se necessario, NON incluso nell'apply) ──
-- drop index if exists public.ferry_pickup_rules_departure_lookup_idx;
-- alter table public.ferry_pickup_rules
--   drop column if exists embark_port,
--   drop column if exists pickup_time,
--   drop column if exists zone,
--   drop column if exists hotel_id,
--   drop column if exists direction;
