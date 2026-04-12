-- Push subscriptions per notifiche web push (driver + admin)
create table if not exists public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  user_id     uuid not null,
  endpoint    text not null,
  p256dh      text not null,
  auth_key    text not null,
  user_agent  text,
  created_at  timestamptz not null default now(),
  constraint push_subscriptions_endpoint_unique unique (endpoint)
);

create index if not exists idx_push_subs_user   on public.push_subscriptions(user_id);
create index if not exists idx_push_subs_tenant on public.push_subscriptions(tenant_id);

-- Log per evitare notifiche duplicate (es. reminder 2h non va inviato due volte)
create table if not exists public.push_notification_log (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  user_id     uuid not null,
  service_id  uuid references public.services(id) on delete cascade,
  kind        text not null,   -- 'reminder_2h' | 'assignment' | 'service_update' | 'inbound_booking'
  sent_at     timestamptz not null default now(),
  constraint push_log_unique unique (service_id, user_id, kind)
);

create index if not exists idx_push_log_service on public.push_notification_log(service_id);

-- RLS: il service role bypassa tutto; l'utente autenticato gestisce solo le proprie
alter table public.push_subscriptions enable row level security;

create policy "push_subs_own_select" on public.push_subscriptions
  for select using (user_id = auth.uid());

create policy "push_subs_own_insert" on public.push_subscriptions
  for insert with check (user_id = auth.uid());

create policy "push_subs_own_delete" on public.push_subscriptions
  for delete using (user_id = auth.uid());

alter table public.push_notification_log enable row level security;
-- Solo service role accede al log (via API server-side)
