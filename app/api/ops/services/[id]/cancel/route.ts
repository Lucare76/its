import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { auditLog } from "@/lib/server/ops-audit";
import {
  getOperatorName,
  logServiceChange,
  readServiceSnapshot,
  type ServiceSnapshot,
} from "@/lib/server/service-audit-log";

export const runtime = "nodejs";

const cancelReasons = [
  "Cliente ha annullato",
  "Cliente ha modificato autonomamente",
  "Cambio data/orario",
  "Prenotazione duplicata",
  "Errore di inserimento",
  "Altro",
] as const;

const cancelServiceSchema = z.object({
  reason: z.enum(cancelReasons),
  note: z.string().trim().max(500).optional().default(""),
  // "leg" (default, MAI un'assunzione diversa) = cancella solo il servizio richiesto;
  // "practice" = cancella anche la gamba collegata via linked_service_id (stessa
  // pratica A/R). Il default resta "leg" per non cascare mai silenziosamente
  // sull'altra tratta senza una scelta esplicita dell'operatore.
  scope: z.enum(["leg", "practice"]).optional().default("leg"),
}).superRefine((value, ctx) => {
  if (value.reason === "Altro" && value.note.trim().length < 3) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["note"],
      message: "Inserisci una nota per il motivo Altro.",
    });
  }
});

function cancelAfterData(before: ServiceSnapshot, reason: string, note: string, assignmentsCleared: number | null) {
  return {
    ...before,
    status: "cancelled",
    cancellation_reason: reason,
    cancellation_note: note || null,
    assignments_cleared: assignmentsCleared,
  };
}

type CancelServicePracticeRow = {
  out_service_id: string;
  assignments_cleared: number;
  bus_allocations_cleared: number;
};

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
    if (auth instanceof NextResponse) return auth;

    const { id: serviceId } = await params;
    const tenantId = auth.membership.tenant_id;
    const parsed = cancelServiceSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Motivo cancellazione non valido." }, { status: 400 });
    }

    const before = await readServiceSnapshot(auth, tenantId, serviceId);
    if (!before) {
      return NextResponse.json({ error: "Servizio non trovato." }, { status: 404 });
    }

    const scope = parsed.data.scope;
    const linkedId = typeof before.linked_service_id === "string" ? before.linked_service_id : null;

    // Idempotenza per il caso semplice (nessuna gamba collegata da toccare):
    // stesso comportamento di prima, nessuna chiamata RPC ridondante su un
    // doppio click. Per scope="practice" con una gamba collegata si procede
    // sempre: potrebbe essere gia' cancellata solo una delle due tratte.
    if (before.status === "cancelled" && (scope === "leg" || !linkedId)) {
      return NextResponse.json({ ok: true, already_cancelled: true });
    }

    const operatorName = await getOperatorName(auth);
    const nowIso = new Date().toISOString();
    const note = parsed.data.note.trim();

    // Passaggio critico UNICO e ATOMICO: status + assignments + allocazioni
    // Rete Bus + status_events + audit, in una sola transazione Postgres
    // (vedi supabase/migrations/0244_cancel_service_practice_rpc.sql). Se un
    // qualunque passaggio fallisce, l'intera cancellazione viene annullata —
    // mai piu' uno stato parziale (status=cancelled con assignment/bus
    // allocation ancora presenti) mascherato da una risposta di successo.
    const { data: rpcData, error: rpcError } = await auth.admin.rpc("cancel_service_practice", {
      p_service_id: serviceId,
      p_tenant_id: tenantId,
      p_scope: scope,
      p_reason: parsed.data.reason,
      p_note: note || null,
      p_user_id: auth.user.id,
    });

    if (rpcError) {
      auditLog({
        event: "service_cancel_failed",
        level: "error",
        tenantId,
        userId: auth.user.id,
        role: auth.membership.role,
        serviceId,
        details: { message: rpcError.message, scope },
      });
      return NextResponse.json({ error: rpcError.message || "Cancellazione non riuscita." }, { status: 500 });
    }

    const rows = (rpcData ?? []) as CancelServicePracticeRow[];
    if (rows.length === 0) {
      return NextResponse.json({ error: "Cancellazione non riuscita: nessun servizio aggiornato." }, { status: 500 });
    }

    const targetIds = rows.map((row) => row.out_service_id);
    const assignmentsCleared = rows.reduce((sum, row) => sum + (row.assignments_cleared ?? 0), 0);
    const busAllocationsCleared = rows.reduce((sum, row) => sum + (row.bus_allocations_cleared ?? 0), 0);

    // Audit "leggibile" per-campo (service_change_logs): supplementare, best-effort,
    // riusa l'helper esistente — un suo fallimento non deve mai far percepire
    // come fallita una cancellazione gia' commit-ata in DB dalla RPC sopra.
    for (const targetId of targetIds) {
      const snapshotBefore = targetId === serviceId ? before : await readServiceSnapshot(auth, tenantId, targetId);
      if (!snapshotBefore) continue;
      const after = cancelAfterData(snapshotBefore, parsed.data.reason, note, assignmentsCleared);
      await logServiceChange({
        auth,
        tenantId,
        serviceId: targetId,
        rootServiceId: serviceId,
        before: snapshotBefore,
        after,
        fields: ["status", "cancellation_reason", "cancellation_note", "assignments_cleared"],
        action: "CANCELLED",
        operatorName,
      });
    }

    auditLog({
      event: "service_cancelled_operationally",
      tenantId,
      userId: auth.user.id,
      role: auth.membership.role,
      serviceId,
      outcome: "cancelled",
      details: {
        reason: parsed.data.reason,
        scope,
        assignments_cleared: assignmentsCleared,
        bus_allocations_cleared: busAllocationsCleared,
        service_ids: targetIds,
      },
    });

    return NextResponse.json({
      ok: true,
      cancelled_at: nowIso,
      operator_name: operatorName,
      reason: parsed.data.reason,
      note,
      scope,
      assignments_cleared: assignmentsCleared,
      bus_allocations_cleared: busAllocationsCleared,
      service_ids: targetIds,
    });
  } catch {
    return NextResponse.json({ error: "Errore interno." }, { status: 500 });
  }
}
