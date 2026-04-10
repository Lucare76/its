-- Migration: inbound email attachments + service draft status needs_review

do $$
begin
  alter type public.service_status add value if not exists 'needs_review';
exception
  when duplicate_object then null;
end
$$;

alter table public.inbound_emails
  add column if not exists from_email text null,
  add column if not exists subject text null,
  add column if not exists body_text text null,
  add column if not exists body_html text null,
  add column if not exists raw_json jsonb not null default '{}'::jsonb;

create table if not exists public.inbound_email_attachments (
  id uuid primary key default gen_random_uuid(),
  inbound_email_id uuid not null references public.inbound_emails (id) on delete cascade,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  filename text not null,
  mimetype text not null,
  size_bytes integer not null default 0,
  stored boolean not null default true,
  extracted_text text null,
  created_at timestamptz not null default now()
);

create index if not exists idx_inbound_email_attachments_email on public.inbound_email_attachments (inbound_email_id);
create index if not exists idx_inbound_email_attachments_tenant_created on public.inbound_email_attachments (tenant_id, created_at desc);

alter table public.inbound_email_attachments enable row level security;

drop policy if exists inbound_email_attachments_tenant_all on public.inbound_email_attachments;
create policy inbound_email_attachments_tenant_all on public.inbound_email_attachments
for all
using (tenant_id = public.current_tenant_id())
with check (tenant_id = public.current_tenant_id());

