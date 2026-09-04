-- Pulizia catalogo pickup hotel Comune di Ischia + consolidamento duplicati SOLEMARE.
-- Applicato manualmente in produzione il 2026-09-04 (vedi audit in sessione claude).
-- Tutte le operazioni sono idempotenti (safe a rieseguire).

-- 1) Correzione comune errato: questi due hotel sono fisicamente a Lacco Ameno,
--    non a Ischia (confermato dagli orari, coerenti col pattern Lacco Ameno).
update hotel_pickup_times
set comune = 'LACCO AMENO'
where hotel_name in ('GRAND HOTEL TERME DI AUGUSTO', 'HOTEL DON PEPE')
  and comune = 'ISCHIA';

-- 2) Consolidamento SOLEMARE: rimossi due record hotel duplicati/orfani
--    (nessun riferimento in services, hotel_aliases, services_ischia,
--    ferry_pickup_rules, pickup_run_services, agency_rates,
--    hotel_vehicle_limits, booking_groups, agency_bookings).
--    Record mantenuto: 0108557d-e819-4953-8c1a-878d63d3c343 (in uso).
delete from hotels
where id in (
  '7414f57e-9d70-423c-af01-cce347fbc46b', -- SOLEMARE duplicato orfano
  'f744ee67-c884-46ed-b413-644308acd409'  -- SOLEMARF refuso orfano
);

-- 3) Alias verso il record SOLEMARE corretto.
insert into hotel_aliases (tenant_id, hotel_id, alias, alias_normalized, source)
select 'd200b89a-64c7-4f8d-a430-95a33b83047a'::uuid,
       '0108557d-e819-4953-8c1a-878d63d3c343'::uuid,
       v.alias, lower(trim(v.alias)), 'manual_cleanup'
from (values ('SOLEMARE'), ('SOLE MARE'), ('SOLEMARF')) as v(alias)
where not exists (
  select 1 from hotel_aliases ha
  where ha.tenant_id = 'd200b89a-64c7-4f8d-a430-95a33b83047a'::uuid
    and lower(trim(ha.alias)) = lower(trim(v.alias))
);

-- 4) + 5) Pickup mancanti Comune di Ischia (pattern verificato su tutti gli
--    hotel già configurati del comune: 05:15 / 10:10 / 10:10, nessuna eccezione).
--    Esclusi HOTEL TEST OPERATIVO e Hotel vari (dati di test/placeholder).
--    PRINCIPE e HOTEL PINETA NON toccati: nessuna corrispondenza certa con un
--    hotel attivo, non associati per evitare fuzzy-matching automatico.
insert into hotel_pickup_times (hotel_name, comune, pickup_time_linea_italia, pickup_time_linea_centro, pickup_time_linea_adriatica)
select v.hotel_name, 'ISCHIA', '05:15:00'::time, '10:10:00'::time, '10:10:00'::time
from (values
  ('AL BERGO INTERNAZIONALE'),
  ('HOTEL AMBASCIATORI'),
  ('HOTEL ARAGONESE'),
  ('hotel cleopatra'),
  ('Hotel Excelsior'),
  ('HOTEL HERMITAGE'),
  ('Hotel Le Querce'),
  ('Hotel Moresco'),
  ('HOTEL PARCO CARTAROMANA'),
  ('HOTEL REGINA PALACE TERME'),
  ('HOTEL SAN GIOVANNI TERME'),
  ('HOTEL TERME ALEXANDER'),
  ('HOTEL ULISSE'),
  ('Hotel Villa Diana'),
  ('PENSIONE DI LUSTRO'),
  ('SORRISO RESORT'),
  ('SOLEMARE')
) as v(hotel_name)
where not exists (
  select 1 from hotel_pickup_times hpt
  where upper(trim(hpt.hotel_name)) = upper(trim(v.hotel_name))
);
