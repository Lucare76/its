-- Fix del bug confermato nell'audit "verifica mirata cancellazione bus"
-- (commit 5ea764205693ec1ec713b74cb4459f8c6c, migration 0244): la funzione
-- cancel_service_practice cancellava assignments e bus_ischia_dist_allocations
-- (smistamento Ischia post-sbarco, migration 0107) ma non toccava MAI
-- tenant_bus_allocations (Rete Bus continentale — Linea Italia/Centro/
-- Adriatica, migration 0036). Poiche' la cancellazione fa
-- UPDATE services.status='cancelled' e mai un DELETE della riga services,
-- l'ON DELETE CASCADE su tenant_bus_allocations.service_id non scatta mai:
-- il posto restava occupato per sempre dopo ogni cancellazione di una
-- prenotazione sulla Rete Bus continentale.
--
-- 0244 NON viene modificata (e' gia' applicata in produzione): questa
-- migration ridefinisce la funzione con CREATE OR REPLACE, stesso pattern
-- gia' usato da 0244 stessa per sostituire una versione precedente.
--
-- Contratto RPC invariato: la colonna bus_allocations_cleared del risultato
-- resta un conteggio totale, ma ora somma le righe rimosse da ENTRAMBE le
-- tabelle di allocazione bus (tenant_bus_allocations + bus_ischia_dist_
-- allocations) per ciascuna tratta, cosi' da non richiedere modifiche alla
-- route ne' al contratto JSON gia' esposto ai chiamanti.

create or replace function public.cancel_service_practice(
  p_service_id uuid,
  p_tenant_id uuid,
  p_scope text,
  p_reason text,
  p_note text default null,
  p_user_id uuid default null
)
returns table(out_service_id uuid, assignments_cleared integer, bus_allocations_cleared integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_service public.services%rowtype;
  v_linked public.services%rowtype;
  v_target_ids uuid[];
  v_id uuid;
  v_now timestamptz := now();
  v_assignments_cleared integer;
  v_bus_ischia_cleared integer;
  v_tenant_bus_cleared integer;
  v_total_assignments integer := 0;
  v_total_bus integer := 0;
begin
  if p_scope not in ('leg', 'practice') then
    raise exception 'Unsupported cancellation scope: %', p_scope
      using errcode = '22023';
  end if;

  select * into v_service
  from public.services
  where id = p_service_id
    and tenant_id = p_tenant_id
  for update;

  if not found then
    raise exception 'Service not found'
      using errcode = 'P0002';
  end if;

  v_target_ids := array[v_service.id];

  if p_scope = 'practice' and v_service.linked_service_id is not null then
    select * into v_linked
    from public.services
    where id = v_service.linked_service_id
      and tenant_id = p_tenant_id
    for update;

    if found then
      v_target_ids := array[v_service.id, v_linked.id];
    end if;
  end if;

  foreach v_id in array v_target_ids loop
    update public.services
      set status = 'cancelled'
    where id = v_id
      and tenant_id = p_tenant_id;

    delete from public.assignments
    where tenant_id = p_tenant_id
      and service_id = v_id;
    get diagnostics v_assignments_cleared = row_count;
    v_total_assignments := v_total_assignments + v_assignments_cleared;

    -- Rete Bus continentale (Linea Italia/Centro/Adriatica, migration 0036).
    -- Prima di questa migration nessuna cancellazione toccava questa
    -- tabella: era il gap confermato dall'audit.
    delete from public.tenant_bus_allocations
    where tenant_id = p_tenant_id
      and service_id = v_id;
    get diagnostics v_tenant_bus_cleared = row_count;

    -- Smistamento locale Ischia post-sbarco (migration 0107).
    delete from public.bus_ischia_dist_allocations
    where tenant_id = p_tenant_id
      and service_id = v_id;
    get diagnostics v_bus_ischia_cleared = row_count;

    v_total_bus := v_total_bus + v_tenant_bus_cleared + v_bus_ischia_cleared;

    insert into public.status_events (tenant_id, service_id, status, by_user_id, notes)
    values (
      p_tenant_id,
      v_id,
      'cancelled',
      p_user_id,
      concat_ws(
        ' | ',
        concat('Motivo: ', p_reason),
        case when p_note is not null and p_note <> '' then concat('Nota: ', p_note) end,
        case when p_scope = 'practice' then 'Cancellazione intera pratica A/R' else 'Cancellazione singola tratta' end
      )
    );

    out_service_id := v_id;
    assignments_cleared := v_assignments_cleared;
    bus_allocations_cleared := v_tenant_bus_cleared + v_bus_ischia_cleared;
    return next;
  end loop;

  insert into public.ops_audit_events (tenant_id, event, level, user_id, service_id, details, created_at)
  values (
    p_tenant_id,
    'service_cancelled_operationally',
    'info',
    p_user_id,
    p_service_id,
    jsonb_build_object(
      'scope', p_scope,
      'reason', p_reason,
      'service_ids', to_jsonb(v_target_ids),
      'assignments_cleared', v_total_assignments,
      'bus_allocations_cleared', v_total_bus,
      'happened_at', v_now
    ),
    v_now
  );
end;
$$;

notify pgrst, 'reload schema';
