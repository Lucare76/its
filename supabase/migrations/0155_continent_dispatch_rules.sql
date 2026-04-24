alter table public.services
  add column if not exists continent_dispatch_target text null
    check (continent_dispatch_target in ('bruno', 'continent_dispatch'));

alter table public.services
  add column if not exists continent_dispatch_source text null
    check (continent_dispatch_source in ('rule', 'manual'));

alter table public.services
  add column if not exists continent_dispatch_vendor text null;

alter table public.services
  add column if not exists continent_dispatch_override_reason text null;

alter table public.services
  add column if not exists continent_dispatch_updated_at timestamptz null;

alter table public.services
  add column if not exists continent_dispatch_updated_by uuid null references auth.users (id) on delete set null;

create index if not exists idx_services_continent_dispatch_target
  on public.services (tenant_id, continent_dispatch_target, date, departure_date);

comment on column public.services.continent_dispatch_target is
  'Bucket operativo continente: Bruno oppure Smistamento continente.';

comment on column public.services.continent_dispatch_source is
  'Origine dell''assegnazione continente: rule per assegnazione automatica, manual per override operatore.';

comment on column public.services.continent_dispatch_vendor is
  'Vettore assegnato nel bucket Smistamento continente. Campo libero, raggruppato per giornata.';

comment on column public.services.continent_dispatch_override_reason is
  'Motivo opzionale dell''override manuale tra Bruno e Smistamento continente.';
