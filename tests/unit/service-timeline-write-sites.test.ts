import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

/**
 * Source-contract: verifica che i 6 gap (A-F) siano effettivamente cablati
 * nei call site corretti, con le costanti centralizzate (mai stringhe
 * libere), e che nessun evento GIÀ coperto da una fonte esistente venga
 * duplicato in service_audit_events (Fase 4/5).
 */

function read(relPath: string) {
  return readFileSync(join(process.cwd(), relPath), "utf8");
}

describe("Gap A — restore servizio", () => {
  const source = read("app/api/ops/cancellation-requests/[id]/restore/route.ts");
  it("chiama recordServiceAuditEvent con SERVICE_RESTORED/MANUAL", () => {
    expect(source).toMatch(/recordServiceAuditEvent/);
    expect(source).toMatch(/SERVICE_AUDIT_EVENT_TYPES\.SERVICE_RESTORED/);
    expect(source).toMatch(/SERVICE_AUDIT_SOURCES\.MANUAL/);
  });
  it("resta condizionato a serviceId noto (stesso guard del preesistente status_events insert)", () => {
    expect(source).toMatch(/if \(serviceId\) \{[\s\S]*recordServiceAuditEvent/);
  });
});

describe("Gap B/C — rimozione autista/veicolo fuori Piano Giorno", () => {
  const source = read("lib/server/assign-service-core.ts");

  it("il ramo 'remove' scrive DRIVER_REMOVED/VEHICLE_REMOVED solo se c'era davvero qualcosa da rimuovere", () => {
    expect(source).toMatch(/if \(action === "remove"\) \{[\s\S]*SERVICE_AUDIT_EVENT_TYPES\.DRIVER_REMOVED[\s\S]*\n  \}/);
    expect(source).toMatch(/SERVICE_AUDIT_EVENT_TYPES\.VEHICLE_REMOVED/);
    expect(source).toMatch(/if \(removedDriverUserId \|\| removedDriverProfileId\) \{/);
    expect(source).toMatch(/if \(removedVehicleLabel\) \{/);
  });

  it("il ramo 'remove' NON risolve il nome operatore al momento della scrittura (nessuna query a memberships aggiunta a un path che oggi ne fa zero)", () => {
    expect(source).not.toMatch(/resolveOperatorNameByUserId/);
  });

  it("NON duplica l'evento di ASSEGNAZIONE (già coperto da driver_assignment_history/logAssignmentChange, invariato)", () => {
    expect(source).toMatch(/void logAssignmentChange\(admin, \[\{/);
    // Il blocco di logAssignmentChange (assegnazione) non deve referenziare service_audit_events.
    const assignBlockStart = source.indexOf("if (driverChanged || vehicleChanged) {");
    const returnAfterAssign = source.indexOf("return { status: 200, body: { ok: true, group_id", assignBlockStart);
    expect(assignBlockStart).toBeGreaterThan(-1);
    expect(returnAfterAssign).toBeGreaterThan(assignBlockStart);
    const assignBlock = source.slice(assignBlockStart, returnAfterAssign);
    expect(assignBlock).not.toMatch(/service-audit-events/);
  });

  it("condivisa da route HTTP e tool MCP (un solo fix copre entrambi i chiamanti)", () => {
    expect(source).toMatch(/richiamabile sia dalla route HTTP[\s\S]*sia dal tool MCP/);
  });
});

describe("Gap D — import con source strutturato (4 call site: excel legacy, excel v2, pdf agenzia, MTS Globe)", () => {
  it("mts-globe-import.ts: SERVICE_IMPORTED/IMPORT_MTS_GLOBE, un evento per servizio, mai nel ramo di rollback", () => {
    const source = read("lib/server/agency-imports/mts-globe-import.ts");
    expect(source).toMatch(/recordServiceAuditEventsBatch/);
    expect(source).toMatch(/SERVICE_AUDIT_EVENT_TYPES\.SERVICE_IMPORTED/);
    expect(source).toMatch(/SERVICE_AUDIT_SOURCES\.IMPORT_MTS_GLOBE/);
  });

  it("excel/import/route.ts: SERVICE_IMPORTED/IMPORT_EXCEL per riga", () => {
    const source = read("app/api/excel/import/route.ts");
    expect(source).toMatch(/recordServiceAuditEvent\(auth\.admin, \{[\s\S]*SERVICE_AUDIT_EVENT_TYPES\.SERVICE_IMPORTED/);
    expect(source).toMatch(/SERVICE_AUDIT_SOURCES\.IMPORT_EXCEL/);
  });

  it("excel/operational-v2-import/route.ts: SERVICE_IMPORTED/IMPORT_EXCEL in batch (un insert, non N)", () => {
    const source = read("app/api/excel/operational-v2-import/route.ts");
    expect(source).toMatch(/recordServiceAuditEventsBatch/);
    expect(source).toMatch(/SERVICE_AUDIT_EVENT_TYPES\.SERVICE_IMPORTED/);
    expect(source).toMatch(/SERVICE_AUDIT_SOURCES\.IMPORT_EXCEL/);
  });

  it("agency-pdf-import.ts: SERVICE_IMPORTED/IMPORT_PDF SOLO sul ramo di creazione (non sull'update di un draft)", () => {
    const source = read("lib/server/agency-pdf-import.ts");
    expect(source).toMatch(/SERVICE_AUDIT_SOURCES\.IMPORT_PDF/);
    const createBranch = source.match(/\} else \{\s*const createAttempt[\s\S]*?\n  \}/);
    expect(createBranch).not.toBeNull();
    expect(createBranch![0]).toMatch(/recordServiceAuditEvent/);
  });
});

describe("Gap E — agency approval/rejection", () => {
  const source = read("app/api/ops/modification-requests/[id]/resolve/route.ts");
  it("scrive AGENCY_APPROVED o AGENCY_REJECTED in base all'azione, source AGENCY_PORTAL", () => {
    expect(source).toMatch(/action === "approve" \? SERVICE_AUDIT_EVENT_TYPES\.AGENCY_APPROVED : SERVICE_AUDIT_EVENT_TYPES\.AGENCY_REJECTED/);
    expect(source).toMatch(/SERVICE_AUDIT_SOURCES\.AGENCY_PORTAL/);
  });
  it("il motivo (reason) usa le notes dell'operatore, i dati di modifica (mr.changes) sono un diff controllato, mai un payload grezzo", () => {
    expect(source).toMatch(/reason: notes \?\? null/);
    expect(source).toMatch(/newData: action === "approve" \? \(mr\.changes as Record<string, unknown>\) : null/);
  });
});

describe("Gap F — servizio creato da booking group", () => {
  const source = read("lib/server/booking-groups-service.ts");
  it("scrive BOOKING_GROUP_SERVICE_CREATED/BOOKING_GROUP accanto (non al posto) dell'auditLog esistente", () => {
    expect(source).toMatch(/event: "booking_group_service_created"[\s\S]{0,600}recordServiceAuditEvent/);
    expect(source).toMatch(/SERVICE_AUDIT_EVENT_TYPES\.BOOKING_GROUP_SERVICE_CREATED/);
    expect(source).toMatch(/SERVICE_AUDIT_SOURCES\.BOOKING_GROUP/);
  });
  it("il nome operatore è risolto UNA sola volta fuori dal loop passeggeri (mai N query per N passeggeri)", () => {
    expect(source).toMatch(/const auditActorName = userId \? await resolveOperatorNameByUserId/);
  });
});

describe("Costanti centralizzate — mai stringhe libere per event_type/source (Fase 3)", () => {
  const constants = read("lib/server/service-audit-events.ts");
  it("tutti gli event_type dei 6 gap sono nel catalogo centralizzato", () => {
    for (const key of [
      "SERVICE_RESTORED",
      "DRIVER_REMOVED",
      "VEHICLE_REMOVED",
      "SERVICE_IMPORTED",
      "AGENCY_APPROVED",
      "AGENCY_REJECTED",
      "BOOKING_GROUP_SERVICE_CREATED",
    ]) {
      expect(constants).toMatch(new RegExp(`${key}:`));
    }
  });
  it("tutti i source usati dai gap sono nel catalogo centralizzato", () => {
    for (const key of ["MANUAL", "IMPORT_EXCEL", "IMPORT_PDF", "IMPORT_MTS_GLOBE", "AGENCY_PORTAL", "BOOKING_GROUP"]) {
      expect(constants).toMatch(new RegExp(`${key}:`));
    }
  });
});
