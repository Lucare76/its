-- Bucket pubblico per foto segnalazioni danni via QR
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'vehicle-damage-photos',
  'vehicle-damage-photos',
  true,
  10485760,  -- 10 MB
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
)
on conflict (id) do nothing;

-- Chiunque può caricare (link QR pubblico)
drop policy if exists "public_upload_vehicle_damage_photos" on storage.objects;
create policy "public_upload_vehicle_damage_photos"
  on storage.objects for insert
  with check (bucket_id = 'vehicle-damage-photos');

-- Tutti possono leggere (bucket pubblico)
drop policy if exists "public_read_vehicle_damage_photos" on storage.objects;
create policy "public_read_vehicle_damage_photos"
  on storage.objects for select
  using (bucket_id = 'vehicle-damage-photos');
