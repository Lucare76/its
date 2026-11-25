-- Dismissione mezzi (vendita, rottamazione, altro) al posto dell'eliminazione.
-- Eliminare un mezzo cancella a cascata tutto il suo storico (rifornimenti,
-- manutenzioni, km, documenti, anomalie...): i costi degli anni passati
-- cambierebbero. Un mezzo dismesso resta nel database con tutto lo storico,
-- esce dalle liste operative (active = false) e il suo QR smette di funzionare
-- (qr_token = null, impostato dall'API).
alter table public.vehicles
  add column if not exists decommissioned_at date null,
  add column if not exists decommission_reason text null,
  add column if not exists decommission_note text null,
  add column if not exists decommissioned_by uuid null references auth.users(id) on delete set null,
  add column if not exists decommission_recorded_at timestamptz null;

alter table public.vehicles
  drop constraint if exists vehicles_decommission_check,
  add constraint vehicles_decommission_check check (
    (decommissioned_at is null and decommission_reason is null and decommission_note is null
      and decommissioned_by is null and decommission_recorded_at is null)
    -- "is not null" esplicito: con NULL, "in (...)" non fallisce e il check passerebbe.
    or (decommissioned_at is not null and decommission_reason is not null
      and decommission_reason in ('sold', 'scrapped', 'other')
      and decommission_recorded_at is not null
      and (decommission_note is null or char_length(decommission_note) <= 1000)
      -- "altro" va spiegato
      and (decommission_reason <> 'other' or nullif(btrim(decommission_note), '') is not null))
  ),
  -- Un mezzo dismesso non può tornare operativo senza essere prima riattivato.
  drop constraint if exists vehicles_decommissioned_inactive_check,
  add constraint vehicles_decommissioned_inactive_check check (decommissioned_at is null or active = false);
