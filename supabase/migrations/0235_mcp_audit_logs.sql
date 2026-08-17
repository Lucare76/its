-- Migration: MCP ITS Sprint 1 — audit log dedicato per le esecuzioni tool MCP.
--
-- PROPOSTA — NON applicata automaticamente. lib/mcp/audit.ts scrive
-- (fire-and-forget) su questa tabella se configurata; se la tabella non
-- esiste ancora l'audit degrada silenziosamente ai soli log su console
-- (stesso pattern difensivo di lib/server/ops-audit.ts).
--
-- Distinta da ops_audit_events (eventi di dominio email/servizi) perche' qui
-- ogni riga corrisponde a UNA esecuzione di un tool MCP, con campi stabili
-- richiesti dalla Fase 14 dello sprint (request_id, duration_ms, category,
-- error_code, input_summary sanitizzato — mai payload completo).

CREATE TABLE IF NOT EXISTS public.mcp_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,
  role TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('READ', 'WRITE', 'DESTRUCTIVE', 'EXTERNAL_ACTION')),
  success BOOLEAN NOT NULL,
  duration_ms INTEGER NOT NULL,
  error_code TEXT,
  input_summary JSONB
);

CREATE INDEX IF NOT EXISTS mcp_audit_logs_tenant_created_idx
  ON public.mcp_audit_logs (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS mcp_audit_logs_tool_created_idx
  ON public.mcp_audit_logs (tool_name, created_at DESC);

ALTER TABLE public.mcp_audit_logs ENABLE ROW LEVEL SECURITY;

-- Solo il service role (usato da lib/mcp/audit.ts) scrive/legge questa
-- tabella: nessuna policy per anon/authenticated, coerente con
-- ops_audit_events che non espone RLS policy ai client.
