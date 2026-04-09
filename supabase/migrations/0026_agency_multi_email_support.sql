-- Migration: supporto email multiple su agencies mantenendo compatibilita con i campi singoli

alter table public.agencies
  add column if not exists contact_emails jsonb not null default '[]'::jsonb;

alter table public.agencies
  add column if not exists booking_emails jsonb not null default '[]'::jsonb;

update public.agencies
set contact_emails = jsonb_build_array(contact_email)
where contact_email is not null
  and contact_email <> ''
  and contact_emails = '[]'::jsonb;

update public.agencies
set booking_emails = jsonb_build_array(booking_email)
where booking_email is not null
  and booking_email <> ''
  and booking_emails = '[]'::jsonb;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'agencies_contact_emails_is_array'
      and conrelid = 'public.agencies'::regclass
  ) then
    alter table public.agencies
      add constraint agencies_contact_emails_is_array
      check (jsonb_typeof(contact_emails) = 'array');
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'agencies_booking_emails_is_array'
      and conrelid = 'public.agencies'::regclass
  ) then
    alter table public.agencies
      add constraint agencies_booking_emails_is_array
      check (jsonb_typeof(booking_emails) = 'array');
  end if;
end $$;
