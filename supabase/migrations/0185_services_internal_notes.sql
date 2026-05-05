alter table public.services
  add column if not exists internal_notes text,
  add column if not exists internal_notes_updated_at timestamptz,
  add column if not exists internal_notes_updated_by uuid references auth.users(id);
