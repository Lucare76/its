-- Numero pratica leggibile per l'operatore (formato ITS-YYYY-N), condiviso
-- da entrambe le gambe di una prenotazione A/R (le due righe `services`
-- restano collegate come oggi via `linked_service_id`, nessun nuovo parent
-- model: qui aggiungiamo solo l'etichetta umana condivisa).
--
-- Generazione atomica via INSERT ... ON CONFLICT DO UPDATE ... RETURNING:
-- Postgres serializza gli aggiornamenti concorrenti sulla stessa riga
-- (tenant_id, year) con un row lock, quindi due creazioni simultanee non
-- possono mai ricevere lo stesso progressivo (a differenza di un
-- MAX(...)+1 letto e riscritto in due passi separati, vulnerabile a race
-- condition). Il progressivo non decresce mai: eliminare una pratica non
-- libera il numero, che resta consumato per sempre.

create table if not exists public.booking_practice_counters (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  year integer not null,
  last_value integer not null default 0,
  updated_at timestamptz not null default timezone('utc'::text, now()),
  primary key (tenant_id, year)
);

alter table public.booking_practice_counters enable row level security;
-- Nessuna policy per i ruoli applicativi: la generazione avviene SOLO
-- tramite la funzione SECURITY DEFINER sotto, invocata dal service role
-- (che bypassa comunque RLS) — coerente con gli altri ledger interni
-- (vedi medmar_ticket_resends, 0241) dove la scrittura resta server-side.

-- Anno solare in timezone operativa (Europe/Rome), cosi' il reset annuale
-- avviene alla mezzanotte locale e non a quella UTC.
create or replace function public.next_booking_practice_number(p_tenant_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_year integer := extract(year from timezone('Europe/Rome', now()))::integer;
  v_seq integer;
begin
  insert into public.booking_practice_counters (tenant_id, year, last_value)
  values (p_tenant_id, v_year, 1)
  on conflict (tenant_id, year)
  do update set
    last_value = public.booking_practice_counters.last_value + 1,
    updated_at = timezone('utc'::text, now())
  returning last_value into v_seq;

  return 'ITS-' || v_year || '-' || v_seq;
end;
$$;

alter table public.services
  add column if not exists practice_number text null;

comment on column public.services.practice_number is
  'Numero pratica leggibile (ITS-YYYY-N), generato server-side via next_booking_practice_number(). Condiviso da entrambe le gambe A/R (stesso valore su andata e ritorno) — la relazione tra le due righe resta linked_service_id, non un nuovo parent model.';

create index if not exists idx_services_tenant_practice_number
  on public.services(tenant_id, practice_number) where practice_number is not null;
