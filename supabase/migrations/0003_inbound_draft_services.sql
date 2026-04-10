-- Migration: inbound email draft support on services
-- Adds link inbound_email_id -> inbound_emails and draft flag.

alter table public.services
  add column if not exists inbound_email_id uuid null,
  add column if not exists is_draft boolean not null default false;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'services_inbound_email_id_fkey'
      and conrelid = 'public.services'::regclass
  ) then
    alter table public.services
      add constraint services_inbound_email_id_fkey
      foreign key (inbound_email_id)
      references public.inbound_emails (id)
      on delete set null;
  end if;
end
$$;

create index if not exists idx_services_inbound_email_id on public.services (inbound_email_id);
