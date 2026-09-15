-- FIX P0-2 (audit pre-go-live) — RLS bus-network: USING senza controllo
-- ruolo lasciava DELETE (e, in teoria, SELECT) aperti a qualunque ruolo
-- autenticato del tenant, mentre WITH CHECK già limitava INSERT/UPDATE ad
-- admin/operator.
--
-- Verificato comportamentalmente in produzione: un account autenticato con
-- ruolo "supervisor" (non incluso nel set admin/operator di WITH CHECK,
-- quindi equivalente a driver/agency ai fini di questo test) ha cancellato
-- con successo una riga tenant_bus_units e una tenant_bus_lines sintetiche
-- senza alcun errore — CONFIRMED EXPLOITABLE.
--
-- Requisito prodotto aggiornato: supervisor deve poter LEGGERE tutti i menu
-- bus (SELECT), ma non modificarli — scrittura (INSERT/UPDATE/DELETE)
-- resta riservata ad admin/operator, invariato rispetto al design
-- originale del WITH CHECK.
--
-- Sostituisce la singola policy "for all" per tabella con 4 policy
-- distinte (select/insert/update/delete), stesso principio di 0279: mai
-- più un'unica espressione che copre implicitamente più comandi con
-- requisiti di ruolo diversi.
--
-- NON modifica: struttura tabelle, GRANT (nessun GRANT/REVOKE esplicito
-- mai scritto su queste tabelle — restano sui default di progetto), le
-- RPC allocate_bus_service/move_bus_allocation (security definer: girano
-- con i privilegi del proprietario della funzione, non sono governate da
-- queste policy RLS in alcun modo — invariate), né la service role.
--
-- ROOT CAUSE aggiuntiva scoperta con smoke test comportamentale: su
-- produzione esistevano ANCHE policy legacy "admin_only_select/insert/
-- update/delete" (nome mai censito nelle migration lette in precedenza),
-- rimaste attive in parallelo alle nuove policy. In Postgres più policy
-- PERMISSIVE sullo stesso comando si combinano in OR, quindi quella legacy
-- (più permissiva) vanificava silenziosamente la restrizione nuova,
-- causando una SELECT cross-tenant riuscita anche per ruoli/tenant che
-- non avrebbero dovuto vedere la riga — CONFIRMED EXPLOITABLE via smoke
-- test diretto (current_tenant_id() corretto, riga di un altro tenant
-- comunque restituita). Questa migration fa ora DROP idempotente anche di
-- queste 4 policy legacy per ciascuna delle 5 tabelle, PRIMA di creare le
-- nuove, cosicché resti attiva una sola policy per comando.

-- ── tenant_bus_lines ────────────────────────────────────────────────────
drop policy if exists tenant_bus_lines_tenant_all on public.tenant_bus_lines;
drop policy if exists tenant_bus_lines_select on public.tenant_bus_lines;
drop policy if exists tenant_bus_lines_insert on public.tenant_bus_lines;
drop policy if exists tenant_bus_lines_update on public.tenant_bus_lines;
drop policy if exists tenant_bus_lines_delete on public.tenant_bus_lines;
drop policy if exists admin_only_select on public.tenant_bus_lines;
drop policy if exists admin_only_insert on public.tenant_bus_lines;
drop policy if exists admin_only_update on public.tenant_bus_lines;
drop policy if exists admin_only_delete on public.tenant_bus_lines;

create policy tenant_bus_lines_select on public.tenant_bus_lines
for select to authenticated
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator', 'supervisor')
);

create policy tenant_bus_lines_insert on public.tenant_bus_lines
for insert to authenticated
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy tenant_bus_lines_update on public.tenant_bus_lines
for update to authenticated
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy tenant_bus_lines_delete on public.tenant_bus_lines
for delete to authenticated
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

-- ── tenant_bus_line_stops ───────────────────────────────────────────────
drop policy if exists tenant_bus_line_stops_tenant_all on public.tenant_bus_line_stops;
drop policy if exists tenant_bus_line_stops_select on public.tenant_bus_line_stops;
drop policy if exists tenant_bus_line_stops_insert on public.tenant_bus_line_stops;
drop policy if exists tenant_bus_line_stops_update on public.tenant_bus_line_stops;
drop policy if exists tenant_bus_line_stops_delete on public.tenant_bus_line_stops;
drop policy if exists admin_only_select on public.tenant_bus_line_stops;
drop policy if exists admin_only_insert on public.tenant_bus_line_stops;
drop policy if exists admin_only_update on public.tenant_bus_line_stops;
drop policy if exists admin_only_delete on public.tenant_bus_line_stops;

create policy tenant_bus_line_stops_select on public.tenant_bus_line_stops
for select to authenticated
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator', 'supervisor')
);

create policy tenant_bus_line_stops_insert on public.tenant_bus_line_stops
for insert to authenticated
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy tenant_bus_line_stops_update on public.tenant_bus_line_stops
for update to authenticated
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy tenant_bus_line_stops_delete on public.tenant_bus_line_stops
for delete to authenticated
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

-- ── tenant_bus_units ────────────────────────────────────────────────────
drop policy if exists tenant_bus_units_tenant_all on public.tenant_bus_units;
drop policy if exists tenant_bus_units_select on public.tenant_bus_units;
drop policy if exists tenant_bus_units_insert on public.tenant_bus_units;
drop policy if exists tenant_bus_units_update on public.tenant_bus_units;
drop policy if exists tenant_bus_units_delete on public.tenant_bus_units;
drop policy if exists admin_only_select on public.tenant_bus_units;
drop policy if exists admin_only_insert on public.tenant_bus_units;
drop policy if exists admin_only_update on public.tenant_bus_units;
drop policy if exists admin_only_delete on public.tenant_bus_units;

create policy tenant_bus_units_select on public.tenant_bus_units
for select to authenticated
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator', 'supervisor')
);

create policy tenant_bus_units_insert on public.tenant_bus_units
for insert to authenticated
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy tenant_bus_units_update on public.tenant_bus_units
for update to authenticated
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy tenant_bus_units_delete on public.tenant_bus_units
for delete to authenticated
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

-- ── tenant_bus_allocations ──────────────────────────────────────────────
drop policy if exists tenant_bus_allocations_tenant_all on public.tenant_bus_allocations;
drop policy if exists tenant_bus_allocations_select on public.tenant_bus_allocations;
drop policy if exists tenant_bus_allocations_insert on public.tenant_bus_allocations;
drop policy if exists tenant_bus_allocations_update on public.tenant_bus_allocations;
drop policy if exists tenant_bus_allocations_delete on public.tenant_bus_allocations;
drop policy if exists admin_only_select on public.tenant_bus_allocations;
drop policy if exists admin_only_insert on public.tenant_bus_allocations;
drop policy if exists admin_only_update on public.tenant_bus_allocations;
drop policy if exists admin_only_delete on public.tenant_bus_allocations;

create policy tenant_bus_allocations_select on public.tenant_bus_allocations
for select to authenticated
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator', 'supervisor')
);

create policy tenant_bus_allocations_insert on public.tenant_bus_allocations
for insert to authenticated
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy tenant_bus_allocations_update on public.tenant_bus_allocations
for update to authenticated
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy tenant_bus_allocations_delete on public.tenant_bus_allocations
for delete to authenticated
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

-- ── tenant_bus_allocation_moves ─────────────────────────────────────────
drop policy if exists tenant_bus_allocation_moves_tenant_all on public.tenant_bus_allocation_moves;
drop policy if exists tenant_bus_allocation_moves_select on public.tenant_bus_allocation_moves;
drop policy if exists tenant_bus_allocation_moves_insert on public.tenant_bus_allocation_moves;
drop policy if exists tenant_bus_allocation_moves_update on public.tenant_bus_allocation_moves;
drop policy if exists tenant_bus_allocation_moves_delete on public.tenant_bus_allocation_moves;
drop policy if exists admin_only_select on public.tenant_bus_allocation_moves;
drop policy if exists admin_only_insert on public.tenant_bus_allocation_moves;
drop policy if exists admin_only_update on public.tenant_bus_allocation_moves;
drop policy if exists admin_only_delete on public.tenant_bus_allocation_moves;

create policy tenant_bus_allocation_moves_select on public.tenant_bus_allocation_moves
for select to authenticated
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator', 'supervisor')
);

create policy tenant_bus_allocation_moves_insert on public.tenant_bus_allocation_moves
for insert to authenticated
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy tenant_bus_allocation_moves_update on public.tenant_bus_allocation_moves
for update to authenticated
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy tenant_bus_allocation_moves_delete on public.tenant_bus_allocation_moves
for delete to authenticated
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);
