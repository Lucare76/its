-- Aggiunge le tabelle usate dalla pianificazione giornaliera alla publication
-- supabase_realtime. Senza questo, Postgres non invia mai eventi al server
-- Realtime e le subscription postgres_changes lato client non ricevono nulla.
--
-- Tabelle necessarie:
--   services        → aggiornata dalla scan route (status=completato) e dai trip ops
--   assignments     → modificata dall'assegnazione autista/veicolo
--   trip_groups     → creata/aggiornata dal raggruppamento corse
--   status_events   → inserita dallo smarcamento QR (/api/scan/[serviceId])
--
-- Idempotente: il blocco DO salta la tabella se già presente nella publication.

do $$
declare
  t text;
begin
  foreach t in array array['services', 'assignments', 'trip_groups', 'status_events']
  loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end;
$$;
