import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { auditLog } from "@/lib/server/ops-audit";

export const runtime = "nodejs";

const bodySchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(5000)
});

function chunkIds(ids: string[], size = 500) {
  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += size) {
    chunks.push(ids.slice(index, index + size));
  }
  return chunks;
}

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator"]);
  if (auth instanceof NextResponse) return auth;

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Payload non valido." }, { status: 400 });
  }

  const { ids } = parsed.data;
  const tenantId = auth.membership.tenant_id;
  const userId = auth.user.id;
  const idChunks = chunkIds(ids);

  let deleted = 0;

  // Data Integrity Sprint 9: sequenza per-chunk, non più due loop separati
  // su tutti i chunk. Prima (bug P1 dell'Audit Finale): TUTTI gli
  // status_events/assignments di TUTTI i chunk venivano cancellati in un
  // primo loop, e SOLO DOPO iniziava un secondo loop che cancellava i
  // services chunk per chunk — un fallimento di services.delete su un
  // chunk qualsiasi lasciava orfani (status invariato, zero assignment,
  // stessa firma dei 36 record storici) anche i chunk successivi mai
  // raggiunti dal secondo loop, oltre al chunk che aveva fallito. Ora ogni
  // chunk esegue l'intera sequenza (snapshot → status_events.delete →
  // assignments.delete → services.delete) prima di passare al chunk
  // successivo: un fallimento compensa/interrompe solo sul chunk corrente,
  // i chunk successivi non vengono nemmeno toccati.
  for (const chunk of idChunks) {
    // FASE 4: snapshot batch (non per-servizio) degli assignment del
    // chunk corrente, letto PRIMA di qualunque delete — necessario per un
    // eventuale ripristino se services.delete fallisce più sotto.
    // assignments ha un unique index su (service_id, tenant_id)
    // (0137_assignments_nullable_driver_unique.sql): cardinalità massima 1
    // per servizio, verificata — non assunta.
    const { data: assignmentSnapshotRows, error: snapshotError } = await auth.admin
      .from("assignments")
      .select("*")
      .in("service_id", chunk)
      .eq("tenant_id", tenantId);

    if (snapshotError) {
      auditLog({
        event: "bulk_delete_services_write_failed",
        level: "error",
        tenantId,
        userId,
        details: { step: "ASSIGNMENTS_SNAPSHOT_FAILED", service_count: chunk.length },
      });
      return NextResponse.json({ error: "Errore lettura assegnazioni preesistenti." }, { status: 500 });
    }

    const assignmentSnapshotByServiceId = new Map<string, Record<string, unknown>>(
      (assignmentSnapshotRows ?? []).map((row) => [row.service_id as string, row as Record<string, unknown>])
    );

    const { error: statusEventsError } = await auth.admin
      .from("status_events")
      .delete()
      .in("service_id", chunk)
      .eq("tenant_id", tenantId);
    if (statusEventsError) {
      // Nulla è ancora stato cancellato per questo chunk (assignments
      // incluso): nessuna compensazione necessaria, fail-closed e basta.
      auditLog({
        event: "bulk_delete_services_write_failed",
        level: "error",
        tenantId,
        userId,
        details: { step: "STATUS_EVENTS_DELETE_FAILED", service_count: chunk.length },
      });
      return NextResponse.json({ error: "Errore cancellazione eventi stato." }, { status: 500 });
    }

    const { error: assignmentsError } = await auth.admin
      .from("assignments")
      .delete()
      .in("service_id", chunk)
      .eq("tenant_id", tenantId);
    if (assignmentsError) {
      // assignments.delete è una singola istruzione SQL: se fallisce,
      // nessuna riga è stata rimossa (atomica per statement) — i services
      // di questo chunk restano coerenti con gli assignment esistenti,
      // nessuna compensazione necessaria.
      auditLog({
        event: "bulk_delete_services_write_failed",
        level: "error",
        tenantId,
        userId,
        details: { step: "ASSIGNMENTS_DELETE_FAILED", service_count: chunk.length },
      });
      return NextResponse.json({ error: "Errore cancellazione assegnazioni." }, { status: 500 });
    }

    // FASE 10: un solo retry prima di compensare. Nessun vincolo FK reale
    // può bloccare services.delete (tutte le FK verso services.id nelle
    // migrazioni sono ON DELETE CASCADE o ON DELETE SET NULL, mai
    // RESTRICT/NO ACTION) — un fallimento qui è quindi tipicamente
    // transitorio (rete/timeout), lo stesso motivo già usato per gli altri
    // retry introdotti negli sprint precedenti.
    let servicesRes = await auth.admin
      .from("services")
      .delete({ count: "exact" })
      .in("id", chunk)
      .eq("tenant_id", tenantId);

    if (servicesRes.error) {
      servicesRes = await auth.admin
        .from("services")
        .delete({ count: "exact" })
        .in("id", chunk)
        .eq("tenant_id", tenantId);
    }

    if (servicesRes.error) {
      // FASE 6: assignments/status_events di questo chunk già cancellati,
      // ma services.delete persiste nel fallire — mai lasciare
      // "status='assigned' senza assignment" (stessa firma dei 36 record
      // storici, vedi Audit Finale §7). Ripristina SOLO gli assignment del
      // chunk corrente dallo snapshot preso sopra: tenant+service scoped,
      // batch (un solo insert per l'intero chunk, mai per-riga), id
      // omesso (nuovo id generato dal DB, stesso pattern già in uso in
      // assign-service-core.ts/restoreDeletedOrphanAssignment).
      // status_events NON viene ripristinato qui (FASE 7): la loro perdita
      // su questo path è una perdita di storico audit, non un rischio
      // sull'invariante primario assignment/status — espandere lo scope al
      // restore di status_events non ha evidenza di necessità operativa
      // reale.
      const restoreRows = Array.from(assignmentSnapshotByServiceId.values()).map((row) => {
        const { id: _id, ...rest } = row;
        return rest;
      });

      let compensationFailed = false;
      if (restoreRows.length > 0) {
        const restoreRes = await auth.admin.from("assignments").insert(restoreRows);
        compensationFailed = Boolean(restoreRes.error);
      }

      auditLog({
        event: "bulk_delete_services_write_failed",
        level: "error",
        tenantId,
        userId,
        details: {
          step: compensationFailed ? "BULK_DELETE_COMPENSATION_FAILED" : "SERVICES_DELETE_FAILED",
          service_count: chunk.length,
          assignment_count: restoreRows.length,
          compensation_result: restoreRows.length === 0 ? "not_needed" : compensationFailed ? "failed" : "restored",
        },
      });

      return NextResponse.json(
        {
          error: compensationFailed
            ? "Errore cancellazione servizi: incoerenza NON risolta automaticamente, richiede verifica manuale."
            : "Errore cancellazione servizi: assegnazioni ripristinate, cancellazione annullata per questo gruppo."
        },
        { status: 500 }
      );
    }

    deleted += servicesRes.count ?? 0;
  }

  return NextResponse.json({ ok: true, deleted: deleted || ids.length });
}
