alter table public.vehicles
  add column if not exists blocked_from timestamptz null;
