import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { auditLog } from "@/lib/server/ops-audit";
import { getOperatorName } from "@/lib/server/service-audit-log";
import { recordServiceAuditEventsBatch, SERVICE_AUDIT_EVENT_TYPES, SERVICE_AUDIT_SOURCES } from "@/lib/server/service-audit-events";

export const runtime = "nodejs";

const bodySchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(5000),
  reason: z.string().trim().max(500).optional(),
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

  const { ids, reason } = parsed.data;
  const tenantId = auth.membership.tenant_id;
  const userId = auth.user.id;
  const idChunks = chunkIds(ids);

  // Fix P1-5 (audit pre-go-live): la cancellazione bulk riuscita non
  // lasciava alcuna traccia persistente — e un evento scritto solo DOPO il
  // delete lascia comunque una cancellazione reale invisibile se quello
  // stesso insert fallisce. Modello a due fasi: REQUESTED viene scritto
  // PRIMA di qualunque delete distruttivo del chunk (se fallisce, il chunk
  // non viene toccato); COMPLETED viene scritto DOPO, solo per gli id
  // realmente cancellati. Se COMPLETED fallisce, REQUESTED resta comunque
  // come traccia forense: la cancellazione non è mai completamente
  // invisibile. operationId correla tutti gli eventi (di tutti i chunk)
  // della stessa richiesta bulk; operatorName è risolto una sola volta.
  const operationId = crypto.randomUUID();
  const operatorName = await getOperatorName(auth).catch(() => null);

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
  for (const [chunkIndex, chunk] of idChunks.entries()) {
    // Fix P1-5, fase A/B: scrive la traccia "richiesta" PRIMA di qualunque
    // delete distruttivo. Se questo insert fallisce, il chunk NON viene
    // toccato affatto (nessuna cancellazione senza almeno l'intenzione
    // persistita prima). Un solo insert batched per chunk (max 500 righe).
    const requestedResult = await recordServiceAuditEventsBatch(
      auth.admin,
      chunk.map((serviceId) => ({
        tenantId,
        serviceId,
        eventType: SERVICE_AUDIT_EVENT_TYPES.BULK_DELETE_REQUESTED,
        source: SERVICE_AUDIT_SOURCES.BULK_DELETE,
        actorUserId: userId,
        actorName: operatorName,
        actorEmail: auth.user.email ?? null,
        reason: reason ?? null,
        metadata: {
          operation_id: operationId,
          chunk_index: chunkIndex,
          total_requested: ids.length,
          requested_service_id: serviceId,
        },
      }))
    );

    if (!requestedResult.ok) {
      auditLog({
        event: "bulk_delete_services_write_failed",
        level: "error",
        tenantId,
        userId,
        details: { step: "AUDIT_REQUESTED_FAILED", service_count: chunk.length, operation_id: operationId, chunk_index: chunkIndex },
      });
      return NextResponse.json(
        { error: "Impossibile registrare la traccia di audit pre-cancellazione: nessun servizio cancellato.", deleted },
        { status: 500 }
      );
    }

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
    // .select("id") (RETURNING) sugli id EFFETTIVAMENTE cancellati: serve
    // per l'audit qui sotto, che deve tracciare i servizi davvero rimossi —
    // non semplicemente "richiesti in questo chunk" (un id cross-tenant o
    // già inesistente non produce errore, ma non viene toccato dal delete:
    // scriverne comunque un evento "cancellato" sarebbe un audit inesatto).
    let servicesRes = await auth.admin
      .from("services")
      .delete({ count: "exact" })
      .in("id", chunk)
      .eq("tenant_id", tenantId)
      .select("id");

    if (servicesRes.error) {
      servicesRes = await auth.admin
        .from("services")
        .delete({ count: "exact" })
        .in("id", chunk)
        .eq("tenant_id", tenantId)
        .select("id");
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

    // Fix P1-5, fase D: traccia "completata" SOLO ora che questo chunk è
    // stato DAVVERO cancellato con successo (mai prima, mai sul ramo
    // compensation/errore sopra). Un evento per servizio EFFETTIVAMENTE
    // cancellato (id da .select("id") sopra, non l'intero chunk richiesto —
    // un id cross-tenant o già inesistente non riceve mai un COMPLETED),
    // un solo insert batched per chunk. Scritta su service_audit_events —
    // non ha FK/cascade su services (0278), sopravvive all'hard delete
    // appena eseguito.
    const deletedIdsInChunk = (servicesRes.data ?? []).map((row) => (row as { id: string }).id);
    const completedResult = await recordServiceAuditEventsBatch(
      auth.admin,
      deletedIdsInChunk.map((serviceId) => ({
        tenantId,
        serviceId,
        eventType: SERVICE_AUDIT_EVENT_TYPES.BULK_DELETE_COMPLETED,
        source: SERVICE_AUDIT_SOURCES.BULK_DELETE,
        actorUserId: userId,
        actorName: operatorName,
        actorEmail: auth.user.email ?? null,
        reason: reason ?? null,
        metadata: {
          operation_id: operationId,
          chunk_index: chunkIndex,
          requested_count: chunk.length,
          deleted_count: deletedIdsInChunk.length,
          deleted_at: new Date().toISOString(),
        },
      }))
    );

    if (!completedResult.ok) {
      // Trade-off esplicito (Step 5, confermato): i servizi di QUESTO
      // chunk sono già stati cancellati con successo e non vengono
      // ripristinati (nessuna transazione/RPC che copra delete+audit —
      // fuori scope). A differenza della prima versione di questo fix,
      // però, la cancellazione NON è mai completamente invisibile: la
      // traccia BULK_DELETE_REQUESTED per questi stessi id è già stata
      // persistita con successo PRIMA del delete (fase A/B sopra) — resta
      // il record forense minimo (actor, operation_id, service_id, reason)
      // anche se il completamento fallisce.
      auditLog({
        event: "bulk_delete_services_write_failed",
        level: "error",
        tenantId,
        userId,
        details: { step: "AUDIT_COMPLETED_FAILED", service_count: chunk.length, operation_id: operationId, chunk_index: chunkIndex },
      });
      return NextResponse.json(
        {
          error: "Servizi cancellati (traccia richiesta già persistita) ma impossibile completare l'audit: richiede verifica manuale.",
          deleted,
        },
        { status: 500 }
      );
    }
  }

  return NextResponse.json({ ok: true, deleted: deleted || ids.length });
}
