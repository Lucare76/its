-- 1. Azzera billing_party_name che non sono agenzie: parcheggi, vie, fermate, hotel, piazze, ecc.
--    Il vecchio parser metteva a volte la città/destinazione al posto del nome agenzia.
update public.services
set billing_party_name = null
where billing_party_name is not null
  and (
    billing_party_name ilike 'parcheggio%'
    or billing_party_name ilike 'via %'
    or billing_party_name ilike 'fermata%'
    or billing_party_name ilike 'stazione%'
    or billing_party_name ilike 'piazza%'
    or billing_party_name ilike 'corso %'
    or billing_party_name ilike 'hotel%'
    or billing_party_name ilike 'grand hotel%'
    or billing_party_name ilike 'residence%'
    or billing_party_name ilike 'villa %'
    or billing_party_name ilike 'porto%'
    or billing_party_name ilike 'aeroporto%'
    or billing_party_name ilike '% metropolitana %'
    or billing_party_name ilike 'metropolitana%'
  );

-- 2. Normalizza i valori rimasti TUTTO MAIUSCOLO in Title Case.
update public.services
set billing_party_name = initcap(lower(billing_party_name))
where billing_party_name is not null
  and billing_party_name <> ''
  and billing_party_name = upper(billing_party_name);
