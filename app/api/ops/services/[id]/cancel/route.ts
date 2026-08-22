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
    if (before.status === "cancelled") {
      return NextResponse.json({ ok: true, already_cancelled: true });
    }

    const operatorName = await getOperatorName(auth);
    const nowIso = new Date().toISOString();
    const note = parsed.data.note.trim();
    const linkedId = typeof before.linked_service_id === "string" ? before.linked_service_id : null;
    const linkedBefore = linkedId ? await readServiceSnapshot(auth, tenantId, linkedId) : null;
    const targetSnapshots = [before, linkedBefore]
      .filter((snapshot): snapshot is ServiceSnapshot => Boolean(snapshot?.id))
      .filter((snapshot, index, all) => all.findIndex((item) => item.id === snapshot.id) === index);
    const targetIds = targetSnapshots.map((snapshot) => snapshot.id);

    const { error: updateError } = await auth.admin
      .from("services")
      .update({ status: "cancelled" })
      .in("id", targetIds)
      .eq("tenant_id", tenantId);
    if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

    const { count: assignmentsCleared, error: assignmentError } = await auth.admin
      .from("assignments")
      .delete({ count: "exact" })
      .eq("tenant_id", tenantId)
      .in("service_id", targetIds);
    if (assignmentError) {
      auditLog({
        event: "service_cancel_assignments_clear_failed",
        level: "warn",
        tenantId,
        userId: auth.user.id,
        role: auth.membership.role,
        serviceId,
        details: { message: assignmentError.message },
      });
    }

    await auth.admin.from("status_events").insert(targetIds.map((targetId) => ({
      tenant_id: tenantId,
      service_id: targetId,
      status: "cancelled",
      by_user_id: auth.user.id,
      notes: [
        `Motivo: ${parsed.data.reason}`,
        note ? `Nota: ${note}` : "",
      ].filter(Boolean).join(" | "),
    })));

    for (const snapshot of targetSnapshots) {
      const after = cancelAfterData(snapshot, parsed.data.reason, note, assignmentsCleared ?? null);
      await logServiceChange({
        auth,
        tenantId,
        serviceId: snapshot.id,
        rootServiceId: serviceId,
        before: snapshot,
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
      details: { reason: parsed.data.reason, assignments_cleared: assignmentsCleared ?? null, service_ids: targetIds },
    });

    return NextResponse.json({
      ok: true,
      cancelled_at: nowIso,
      operator_name: operatorName,
      reason: parsed.data.reason,
      note,
      assignments_cleared: assignmentsCleared ?? null,
      service_ids: targetIds,
    });
  } catch {
    return NextResponse.json({ error: "Errore interno." }, { status: 500 });
  }
}
