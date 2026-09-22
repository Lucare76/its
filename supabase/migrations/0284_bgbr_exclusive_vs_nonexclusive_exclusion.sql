-- Migration 0284: booking_group_bus_reservations — chiude il gap residuo tra
-- prenotazioni ESCLUSIVE e NON esclusive sullo stesso (tenant_id, bus_unit_id,
-- service_date).
--
-- STATO PRIMA DI QUESTA MIGRATION:
-- - idx_bgbr_tenant_bus_date_exclusive (migration 0282, partial unique su
--   (tenant_id, bus_unit_id, service_date) WHERE exclusive = true) impedisce
--   SOLO due reservation entrambe esclusive in conflitto tra loro.
-- - Resta possibile che una reservation NON esclusiva venga creata/spostata
--   sullo stesso bus/data di una reservation ESCLUSIVA gia' attiva (di un
--   gruppo diverso), e viceversa: una reservation ESCLUSIVA puo' essere
--   creata quando esistono gia' una o piu' reservation NON esclusive sullo
--   stesso bus/data. Nessuno dei due casi e' catturato da un semplice unique
--   index, perche' la regola dipende dal valore di `exclusive` di TUTTE le
--   righe del bucket (tenant_id, bus_unit_id, service_date), non solo dalla
--   riga in scrittura — serve una regola cross-row, non un vincolo di
--   unicita' su una singola combinazione di colonne.
--
-- VERIFICA DATI LIVE (pre-migration, sola SELECT, eseguita su progetto
-- ischia-transfer): nessun bucket (tenant_id, bus_unit_id, service_date) con
-- reservation esclusive+non-esclusive miste ne' con piu' di una reservation
-- esclusiva. Nessuna remediation di dati necessaria prima di applicare il
-- vincolo.
--
-- REGOLA DI BUSINESS:
-- 1) se esiste UNA reservation exclusive=true per (tenant, bus, data), non
--    puo' esisterne nessun'altra (ne' exclusive ne' non-exclusive) per lo
--    stesso bucket;
-- 2) se esistono una o piu' reservation exclusive=false per (tenant, bus,
--    data), altre non-exclusive restano ammesse, ma NON puo' essere aggiunta
--    una exclusive=true finche' quelle non-exclusive esistono;
-- 3) tenant/bus/data diversi restano indipendenti (nessuna cross-contaminazione).
-- La regola vale sia in INSERT sia in UPDATE (incluso lo spostamento di una
-- riga su un bus/data diverso, o il passaggio exclusive false -> true).
--
-- SOLUZIONE SCELTA: trigger BEFORE INSERT/UPDATE, concurrency-safe tramite
-- pg_advisory_xact_lock sul bucket (tenant_id, bus_unit_id, service_date).
-- Un semplice SELECT-poi-decide nel trigger non basterebbe da solo: due
-- transazioni concorrenti potrebbero eseguire entrambe il SELECT prima che
-- l'altra abbia fatto INSERT/COMMIT (stessa classe di race del gap
-- applicativo che questa migration chiude). L'advisory lock e' per-XACT
-- (rilasciato automaticamente a COMMIT/ROLLBACK) e serializza SOLO i writer
-- che toccano lo stesso identico bucket: la seconda transazione attende che
-- la prima definisca il proprio stato (commit o rollback) prima di eseguire
-- il proprio SELECT di verifica, eliminando la finestra di race. Un unique
-- index da solo non basta perche' la regola non e' "una combinazione di
-- colonne univoca", ma "compatibilita' del valore booleano exclusive tra
-- righe diverse dello stesso bucket".
--
-- Idempotente: create or replace function + drop/create trigger. Additiva e
-- non distruttiva: non tocca dati esistenti, non rimuove l'indice 0282 (che
-- resta come difesa aggiuntiva, ormai ridondante ma innocua).

create or replace function public.enforce_bgbr_exclusive_exclusion()
returns trigger
language plpgsql
as $$
declare
  v_lock_key bigint;
  v_conflict_id uuid;
begin
  -- Serializza tutti i writer sullo stesso bucket (tenant_id, bus_unit_id,
  -- service_date) per la durata della transazione corrente, cosi' il check
  -- sottostante e' race-free anche con due richieste concorrenti reali.
  v_lock_key := hashtextextended(
    NEW.tenant_id::text || '|' || NEW.bus_unit_id::text || '|' || NEW.service_date::text,
    0
  );
  perform pg_advisory_xact_lock(v_lock_key);

  if NEW.exclusive then
    -- Una reservation esclusiva deve essere l'UNICA per questo bucket.
    -- Marker distinto a seconda del TIPO di riga che blocca, cosi' il
    -- layer applicativo puo' restituire un messaggio 409 differenziato
    -- (vedi reserveBookingGroupBus in lib/server/booking-groups-service.ts).
    select id into v_conflict_id
    from public.booking_group_bus_reservations
    where tenant_id = NEW.tenant_id
      and bus_unit_id = NEW.bus_unit_id
      and service_date = NEW.service_date
      and exclusive = true
      and id <> NEW.id
    limit 1;
    if v_conflict_id is not null then
      raise exception 'bgbr_conflict_exclusive_exists: bus % gia riservato in esclusiva per la data %', NEW.bus_unit_id, NEW.service_date
        using errcode = '23505';
    end if;

    select id into v_conflict_id
    from public.booking_group_bus_reservations
    where tenant_id = NEW.tenant_id
      and bus_unit_id = NEW.bus_unit_id
      and service_date = NEW.service_date
      and id <> NEW.id
    limit 1;
    if v_conflict_id is not null then
      raise exception 'bgbr_conflict_occupied: bus % gia occupato da prenotazioni non esclusive per la data %', NEW.bus_unit_id, NEW.service_date
        using errcode = '23505';
    end if;
  else
    -- Una reservation NON esclusiva non puo' coesistere con una reservation
    -- esclusiva gia' presente sullo stesso bucket.
    select id into v_conflict_id
    from public.booking_group_bus_reservations
    where tenant_id = NEW.tenant_id
      and bus_unit_id = NEW.bus_unit_id
      and service_date = NEW.service_date
      and exclusive = true
      and id <> NEW.id
    limit 1;
    if v_conflict_id is not null then
      raise exception 'bgbr_conflict_exclusive_exists: bus % gia riservato in esclusiva per la data %', NEW.bus_unit_id, NEW.service_date
        using errcode = '23505';
    end if;
  end if;

  return NEW;
end;
$$;

drop trigger if exists trg_bgbr_enforce_exclusivity on public.booking_group_bus_reservations;
create trigger trg_bgbr_enforce_exclusivity
  before insert or update of tenant_id, bus_unit_id, service_date, exclusive
  on public.booking_group_bus_reservations
  for each row
  execute function public.enforce_bgbr_exclusive_exclusion();

-- ROLLBACK logico (non eseguito qui, solo documentato):
--   drop trigger if exists trg_bgbr_enforce_exclusivity on public.booking_group_bus_reservations;
--   drop function if exists public.enforce_bgbr_exclusive_exclusion();
-- Sicuro: rimuove solo il trigger/funzione aggiunti qui, nessuna colonna o
-- dato toccato, idx_bgbr_tenant_bus_date_exclusive (0282) resta invariato.
