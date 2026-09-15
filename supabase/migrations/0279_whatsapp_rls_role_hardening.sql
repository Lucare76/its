-- FIX P0-1 (audit pre-go-live) — WhatsApp RLS senza controllo ruolo.
--
-- Verificato comportamentalmente in produzione (non solo staticamente sulla
-- migration 0175): un account autenticato con ruolo NON amministrativo
-- (testato con "supervisor", generalizza a qualunque ruolo perché la
-- policy precedente non referenzia MAI current_user_role()) poteva
-- leggere, modificare e cancellare whatsapp_contacts/threads/messages/
-- message_statuses di tutto il tenant — CONFIRMED EXPLOITABLE.
--
-- Requisito prodotto aggiornato: supervisor deve avere accesso operativo
-- pieno a WhatsApp (SELECT/INSERT/UPDATE/DELETE), driver e agency mai.
--
-- Sostituisce la singola policy "for all" per tabella con 4 policy
-- distinte (select/insert/update/delete) — deliberato, non un FOR ALL:
-- rende esplicito e verificabile ogni singolo comando invece di un'unica
-- espressione che li copre tutti implicitamente (la stessa ambiguità che
-- ha reso questo bug possibile: un FOR ALL con USING senza ruolo lascia
-- SELECT/DELETE scoperti anche quando WITH CHECK sembra corretto per
-- INSERT/UPDATE — vedi 0280 per il caso reale sulle tabelle bus).
--
-- Nessuna modifica a struttura tabelle, a GRANT (nessun GRANT/REVOKE
-- esplicito risulta mai scritto su queste tabelle nella storia delle
-- migration — restano sui default di progetto, invariati) né alla service
-- role, che bypassa RLS per definizione e non è governata da queste
-- policy in nessun caso (webhook WhatsApp server-side, route
-- app/api/ops/whatsapp-*, tutte già su service role — invariate).
--
-- Idempotente: ogni policy nuova è preceduta da un DROP IF EXISTS sia del
-- vecchio nome "_tenant_all" sia del proprio nuovo nome, così la migration
-- può essere rieseguita senza errori.

-- ── whatsapp_contacts ───────────────────────────────────────────────────
drop policy if exists whatsapp_contacts_tenant_all on public.whatsapp_contacts;
drop policy if exists whatsapp_contacts_select on public.whatsapp_contacts;
drop policy if exists whatsapp_contacts_insert on public.whatsapp_contacts;
drop policy if exists whatsapp_contacts_update on public.whatsapp_contacts;
drop policy if exists whatsapp_contacts_delete on public.whatsapp_contacts;

create policy whatsapp_contacts_select on public.whatsapp_contacts
for select to authenticated
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator', 'supervisor')
);

create policy whatsapp_contacts_insert on public.whatsapp_contacts
for insert to authenticated
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator', 'supervisor')
);

create policy whatsapp_contacts_update on public.whatsapp_contacts
for update to authenticated
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator', 'supervisor')
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator', 'supervisor')
);

create policy whatsapp_contacts_delete on public.whatsapp_contacts
for delete to authenticated
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator', 'supervisor')
);

-- ── whatsapp_threads ────────────────────────────────────────────────────
drop policy if exists whatsapp_threads_tenant_all on public.whatsapp_threads;
drop policy if exists whatsapp_threads_select on public.whatsapp_threads;
drop policy if exists whatsapp_threads_insert on public.whatsapp_threads;
drop policy if exists whatsapp_threads_update on public.whatsapp_threads;
drop policy if exists whatsapp_threads_delete on public.whatsapp_threads;

create policy whatsapp_threads_select on public.whatsapp_threads
for select to authenticated
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator', 'supervisor')
);

create policy whatsapp_threads_insert on public.whatsapp_threads
for insert to authenticated
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator', 'supervisor')
);

create policy whatsapp_threads_update on public.whatsapp_threads
for update to authenticated
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator', 'supervisor')
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator', 'supervisor')
);

create policy whatsapp_threads_delete on public.whatsapp_threads
for delete to authenticated
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator', 'supervisor')
);

-- ── whatsapp_messages ───────────────────────────────────────────────────
drop policy if exists whatsapp_messages_tenant_all on public.whatsapp_messages;
drop policy if exists whatsapp_messages_select on public.whatsapp_messages;
drop policy if exists whatsapp_messages_insert on public.whatsapp_messages;
drop policy if exists whatsapp_messages_update on public.whatsapp_messages;
drop policy if exists whatsapp_messages_delete on public.whatsapp_messages;

create policy whatsapp_messages_select on public.whatsapp_messages
for select to authenticated
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator', 'supervisor')
);

create policy whatsapp_messages_insert on public.whatsapp_messages
for insert to authenticated
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator', 'supervisor')
);

create policy whatsapp_messages_update on public.whatsapp_messages
for update to authenticated
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator', 'supervisor')
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator', 'supervisor')
);

create policy whatsapp_messages_delete on public.whatsapp_messages
for delete to authenticated
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator', 'supervisor')
);

-- ── whatsapp_message_statuses ───────────────────────────────────────────
drop policy if exists whatsapp_message_statuses_tenant_all on public.whatsapp_message_statuses;
drop policy if exists whatsapp_message_statuses_select on public.whatsapp_message_statuses;
drop policy if exists whatsapp_message_statuses_insert on public.whatsapp_message_statuses;
drop policy if exists whatsapp_message_statuses_update on public.whatsapp_message_statuses;
drop policy if exists whatsapp_message_statuses_delete on public.whatsapp_message_statuses;

create policy whatsapp_message_statuses_select on public.whatsapp_message_statuses
for select to authenticated
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator', 'supervisor')
);

create policy whatsapp_message_statuses_insert on public.whatsapp_message_statuses
for insert to authenticated
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator', 'supervisor')
);

create policy whatsapp_message_statuses_update on public.whatsapp_message_statuses
for update to authenticated
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator', 'supervisor')
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator', 'supervisor')
);

create policy whatsapp_message_statuses_delete on public.whatsapp_message_statuses
for delete to authenticated
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator', 'supervisor')
);
