-- Bucket privato per i backup automatici notturni
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'backups',
  'backups',
  false,
  52428800, -- 50 MB max per file
  array['application/json']
)
on conflict (id) do nothing;

-- Solo il service role può leggere/scrivere (nessun accesso da client)
create policy "service_role_only_backups"
  on storage.objects
  for all
  to service_role
  using (bucket_id = 'backups')
  with check (bucket_id = 'backups');
