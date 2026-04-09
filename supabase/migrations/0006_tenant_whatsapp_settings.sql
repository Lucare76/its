-- Migration: tenant-level WhatsApp template settings
create table if not exists public.tenant_whatsapp_settings (
  tenant_id uuid primary key references public.tenants (id) on delete cascade,
  default_template text not null default 'transfer_reminder',
  template_language text not null default 'it',
  enable_2h_reminder boolean not null default false,
  allow_text_fallback boolean not null default false,
  updated_at timestamptz not null default now()
);

create index if not exists idx_tenant_whatsapp_settings_updated_at on public.tenant_whatsapp_settings (updated_at desc);

alter table public.tenant_whatsapp_settings enable row level security;

drop policy if exists tenant_whatsapp_settings_tenant_all on public.tenant_whatsapp_settings;
create policy tenant_whatsapp_settings_tenant_all on public.tenant_whatsapp_settings
for all
using (tenant_id = public.current_tenant_id())
with check (tenant_id = public.current_tenant_id());
