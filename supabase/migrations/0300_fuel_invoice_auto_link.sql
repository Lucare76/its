-- Come è stato creato (o tolto) il collegamento riga fattura ↔ rifornimento.
--   null       riga mai toccata: può essere collegata automaticamente
--   'auto'     collegata dal sistema perché tutto corrisponde esattamente
--   'manual'   collegata da un operatore
--   'unlinked' scollegata da un operatore: il sistema non la ricollega più
alter table public.fuel_invoice_lines
  add column if not exists match_method text null
    check (match_method is null or match_method in ('auto', 'manual', 'unlinked'));

-- I collegamenti esistenti sono stati fatti a mano.
update public.fuel_invoice_lines
set match_method = 'manual'
where matched_fuel_id is not null and match_method is null;
