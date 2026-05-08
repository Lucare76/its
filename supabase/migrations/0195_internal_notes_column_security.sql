-- Protegge le colonne internal_notes da query dirette con JWT agency.
--
-- Contesto: migration 0185 ha aggiunto internal_notes a services senza
-- restrizioni a livello colonna. Tutte le API Next.js usano service_role
-- (bypass RLS + accesso completo) quindi non sono impattate.
-- Il rischio è un'agenzia che interroga direttamente la REST API Supabase
-- con il proprio JWT (ruolo authenticated) e legge note riservate.
--
-- Soluzione: REVOKE column-level SELECT su authenticated.
-- SELECT * da un client JWT fallirà per quelle colonne (comportamento atteso).
-- Rollback: GRANT SELECT (internal_notes, ...) ON public.services TO authenticated;

REVOKE SELECT (
  internal_notes,
  internal_notes_updated_at,
  internal_notes_updated_by
)
ON public.services
FROM authenticated;
