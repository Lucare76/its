create table if not exists public.whatsapp_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  meta_template_id text not null,
  name text not null,
  language_code text not null,
  status text not null,
  category text null,
  header_format text null,
  body_text text null,
  body_parameter_count integer not null default 0 check (body_parameter_count >= 0 and body_parameter_count <= 50),
  raw_json jsonb not null default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (tenant_id, meta_template_id),
  unique (tenant_id, name, language_code)
);

create index if not exists idx_whatsapp_templates_tenant_name on public.whatsapp_templates (tenant_id, name, language_code);
create index if not exists idx_whatsapp_templates_tenant_synced on public.whatsapp_templates (tenant_id, synced_at desc);

alter table public.whatsapp_templates enable row level security;

drop policy if exists whatsapp_templates_tenant_all on public.whatsapp_templates;
create policy whatsapp_templates_tenant_all on public.whatsapp_templates
for all
using (tenant_id = public.current_tenant_id())
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator', 'supervisor')
);
