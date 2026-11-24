-- Chiusura ("controllata") delle fatture carburante importate.
--
-- Una fattura chiusa è bloccata:
--   * le sue righe non si possono più collegare, scollegare o modificare;
--   * i rifornimenti collegati non possono cambiare data, litri, importo,
--     fornitore o distributore, non possono essere respinti né eliminati.
-- Per correggere serve riaprirla (solo admin, con motivo).
-- Il blocco è nel database, non solo nelle API, così nessun percorso lo aggira.

alter table public.fuel_invoice_imports
  add column if not exists status text not null default 'open',
  add column if not exists closed_at timestamptz null,
  add column if not exists closed_by uuid null references auth.users(id) on delete set null,
  add column if not exists close_outcome text null,
  add column if not exists close_note text null;

alter table public.fuel_invoice_imports
  drop constraint if exists fuel_invoice_imports_status_check,
  add constraint fuel_invoice_imports_status_check check (status in ('open', 'closed')),
  drop constraint if exists fuel_invoice_imports_close_outcome_check,
  add constraint fuel_invoice_imports_close_outcome_check
    check (close_outcome is null or close_outcome in ('ok', 'with_notes')),
  drop constraint if exists fuel_invoice_imports_close_note_check,
  add constraint fuel_invoice_imports_close_note_check
    check (close_note is null or char_length(close_note) <= 2000),
  -- Chiusa => sappiamo quando e con che esito; "con note" => la nota c'è.
  drop constraint if exists fuel_invoice_imports_closed_consistency,
  add constraint fuel_invoice_imports_closed_consistency check (
    status = 'open'
    or (closed_at is not null and close_outcome is not null
        and (close_outcome = 'ok' or nullif(btrim(close_note), '') is not null))
  );

-- Storico di ogni chiusura e riapertura (chi, quando, perché, con quali numeri).
create table if not exists public.fuel_invoice_reviews (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  import_id uuid not null references public.fuel_invoice_imports(id) on delete cascade,
  event text not null check (event in ('closed', 'reopened')),
  outcome text null check (outcome is null or outcome in ('ok', 'with_notes')),
  note text null check (note is null or char_length(note) <= 2000),
  invoice_total numeric(12,2) null,
  linked_total numeric(12,2) null,
  lines_count integer null,
  lines_linked integer null,
  user_id uuid null references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  check (event <> 'reopened' or nullif(btrim(note), '') is not null)
);
create index if not exists fuel_invoice_reviews_import_idx
  on public.fuel_invoice_reviews(tenant_id, import_id, created_at desc);

alter table public.fuel_invoice_reviews enable row level security;
revoke all on public.fuel_invoice_reviews from anon, authenticated;
grant select on public.fuel_invoice_reviews to authenticated;
drop policy if exists fuel_invoice_reviews_read on public.fuel_invoice_reviews;
create policy fuel_invoice_reviews_read on public.fuel_invoice_reviews for select to authenticated
  using (exists (select 1 from public.memberships m where m.tenant_id = fuel_invoice_reviews.tenant_id
    and m.user_id = auth.uid() and m.role in ('admin', 'operator', 'supervisor')));

-- Blocco righe di una fattura chiusa.
create or replace function public.guard_closed_fuel_invoice_line()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.fuel_invoice_imports i where i.id = old.import_id and i.status = 'closed')
    and (new.matched_fuel_id is distinct from old.matched_fuel_id
      or new.match_method is distinct from old.match_method
      or new.fuel_date is distinct from old.fuel_date
      or new.liters is distinct from old.liters
      or new.amount is distinct from old.amount
      or new.station is distinct from old.station) then
    raise exception 'Fattura carburante chiusa: riaprila per modificare i collegamenti.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
drop trigger if exists guard_closed_fuel_invoice_line on public.fuel_invoice_lines;
create trigger guard_closed_fuel_invoice_line before update on public.fuel_invoice_lines
  for each row execute function public.guard_closed_fuel_invoice_line();

-- Blocco rifornimenti collegati a una fattura chiusa.
create or replace function public.guard_closed_fuel_invoice_refuel()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (
    select 1 from public.fuel_invoice_lines l
    join public.fuel_invoice_imports i on i.id = l.import_id
    -- tenant_id + matched_fuel_id: usa l'indice fuel_invoice_lines_unique_match.
    where l.tenant_id = old.tenant_id and l.matched_fuel_id = old.id and i.status = 'closed'
  ) then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Rifornimento di una fattura carburante chiusa: riapri la fattura per eliminarlo.'
      using errcode = 'check_violation';
  end if;
  if new.fuel_date is distinct from old.fuel_date
    or new.liters is distinct from old.liters
    or new.cost is distinct from old.cost
    or new.gross_cost is distinct from old.gross_cost
    or new.invoice_supplier is distinct from old.invoice_supplier
    or new.station is distinct from old.station
    or (new.approval_status = 'rejected' and old.approval_status is distinct from 'rejected') then
    raise exception 'Rifornimento di una fattura carburante chiusa: riapri la fattura per modificare data, litri, importo, fornitore o distributore, o per respingerlo.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
drop trigger if exists guard_closed_fuel_invoice_refuel on public.vehicle_fuel;
create trigger guard_closed_fuel_invoice_refuel before update or delete on public.vehicle_fuel
  for each row execute function public.guard_closed_fuel_invoice_refuel();
