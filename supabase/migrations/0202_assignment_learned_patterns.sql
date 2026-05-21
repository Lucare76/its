-- Pattern appresi dalle correzioni operatore.
-- Aggregazione di driver_assignment_history per (tenant, pattern_key, driver).
-- Popolato da updateLearnedPatterns() — non scrivere direttamente da applicazione.

create table if not exists public.assignment_learned_patterns (
  id                  uuid        primary key default gen_random_uuid(),
  tenant_id           uuid        not null,
  pattern_key         text        not null,
  driver_profile_id   uuid        not null,
  total_count         int         not null default 0,
  correction_count    int         not null default 0,
  last_updated_at     timestamptz not null default now(),
  constraint assignment_learned_patterns_unique
    unique (tenant_id, pattern_key, driver_profile_id)
);

create index if not exists alp_tenant_pattern
  on public.assignment_learned_patterns (tenant_id, pattern_key);

create index if not exists alp_tenant_driver
  on public.assignment_learned_patterns (tenant_id, driver_profile_id);

alter table public.assignment_learned_patterns enable row level security;
create policy "tenant_rw" on public.assignment_learned_patterns for all using (true);
