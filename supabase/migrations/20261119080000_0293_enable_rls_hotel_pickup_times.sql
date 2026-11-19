-- hotel_pickup_times (creata in 0084) non aveva mai la row-level security attiva:
-- con la chiave pubblica (anon) chiunque poteva leggere, modificare o cancellare
-- gli orari di pick-up ritorno degli hotel.
--
-- Tutto il codice dell'app la legge solo lato server con il client service_role
-- (app/api/agency/bus-return-time, app/api/ops/bus-network, app/api/ops/search,
-- lib/server/bus-operational-resolver), che ignora RLS: nessun impatto sull'app.
--
-- È un catalogo condiviso (non ha tenant_id): lasciamo agli utenti autenticati
-- la sola lettura, così la view ops_bus_allocation_details (security_invoker)
-- continua a restituire hotel_pickup_time anche se interrogata da un utente.
-- Le scritture restano solo al server.

alter table public.hotel_pickup_times enable row level security;

revoke all on table public.hotel_pickup_times from public, anon, authenticated;
grant select on table public.hotel_pickup_times to authenticated;
grant all on table public.hotel_pickup_times to service_role;

drop policy if exists hotel_pickup_times_select_authenticated on public.hotel_pickup_times;
create policy hotel_pickup_times_select_authenticated
  on public.hotel_pickup_times
  for select
  to authenticated
  using (true);
