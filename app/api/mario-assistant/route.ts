/**
 * POST /api/mario-assistant — Sprint 6.
 *
 * Endpoint interno per la Mario Interface: prende un messaggio in linguaggio
 * naturale, lo instrada su un intent deterministico (nessun LLM) e chiama il
 * tool MCP READ Sprint 5 corrispondente tramite la stessa pipeline centrale
 * (runTool: policy -> rate limit -> validazione -> handler -> audit). Il
 * client non sceglie mai il tool, non passa mai tenantId/userId/role, e
 * nessun WRITE e' raggiungibile da qui.
 */
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { checkRateLimit } from "@/lib/server/rate-limit";
import { parseRole } from "@/lib/rbac";
import type { McpContext } from "@/lib/mcp/context";
import { runMarioAssistant } from "@/lib/server/mario-assistant/orchestrator";

export const runtime = "nodejs";

const RATE_LIMIT = { maxAttempts: 20, windowMs: 60 * 1000 };

const bodySchema = z.object({ message: z.string().min(1).max(500) }).strict();

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const role = parseRole(auth.membership.role);
  if (!role) {
    return NextResponse.json({ ok: false, error: "Ruolo non riconosciuto." }, { status: 403 });
  }

  const rateLimitId = `${auth.membership.tenant_id}:${auth.user.id}`;
  const rateLimitResult = await checkRateLimit("mario-assistant", rateLimitId, RATE_LIMIT);
  if (!rateLimitResult.allowed) {
    return NextResponse.json({ ok: false, error: "Troppe richieste, riprova tra poco." }, { status: 429 });
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Corpo della richiesta non valido." }, { status: 400 });
  }

  const parsedBody = bodySchema.safeParse(rawBody);
  if (!parsedBody.success) {
    return NextResponse.json({ ok: false, error: "Messaggio non valido." }, { status: 400 });
  }

  // Tenant/utente/ruolo risolti SOLO server-side dalla sessione autenticata —
  // mai da un campo del body (bodySchema e' .strict(), un eventuale
  // tenantId/userId/role/toolName nel payload viene rifiutato a monte).
  const context: McpContext = {
    requestId: randomUUID(),
    userId: auth.user.id,
    userEmail: auth.user.email,
    tenantId: auth.membership.tenant_id,
    role,
    admin: auth.admin,
  };

  const result = await runMarioAssistant(context, parsedBody.data.message);

  return NextResponse.json({
    ok: true,
    intent: result.intent,
    answer: result.answer,
    actions: result.actions,
    data: result.data ?? null,
  });
}
