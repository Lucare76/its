alter table public.memberships
  add column if not exists suspended boolean not null default false;
