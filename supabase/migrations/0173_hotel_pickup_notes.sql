-- Aggiunge colonna pickup_note agli hotel per indicare il punto di carico/scarico specifico
alter table public.hotels
  add column if not exists pickup_note text null;

-- Inserisce i punti di carico per gli hotel noti
update public.hotels set pickup_note = 'Angolo strada autoscuola San Lorenzo'
  where lower(name) like '%colella%';

update public.hotels set pickup_note = 'AM Motori'
  where lower(name) like '%rosa%' and lower(name) like '%la%';

update public.hotels set pickup_note = 'Strada principale'
  where lower(name) like '%villa teresa%';

update public.hotels set pickup_note = 'Discesa hotel'
  where lower(name) like '%royal palm%';

update public.hotels set pickup_note = 'Hotel Nettuno'
  where lower(name) like '%punta del sole%' or lower(name) like '%punta sole%';

update public.hotels set pickup_note = 'Bar Campo'
  where lower(name) like '%augusto%';
