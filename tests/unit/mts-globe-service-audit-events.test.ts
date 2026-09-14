import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { confirmMtsGlobeImport } from "@/lib/server/agency-imports/mts-globe-import";

/**
 * Integrazione MTS Globe — Timeline per-servizio: un service_audit_events
 * per ogni servizio REALMENTE creato (event_type=service_imported,
 * source=import_mts_globe), mai per un import fallito o non confermabile.
 * Stesso fake admin/fixtures di tests/unit/mts-globe-import.test.ts
 * (duplicato qui deliberatamente: quel file non esporta l'harness, e
 * aggiungere qui una dipendenza da un file di test esterno sarebbe fragile).
 */

const TENANT_ID = "tenant-1";
const HOTEL_ID = "hotel-royal-palm";

function baseRow(overrides: Record<string, unknown> = {}) {
  return {
    "Voucher No": "1000001",
    "Grouping Id": "9000001",
    "Start Date": "30.08.2026",
    "Service Base Code": "Arrivi",
    "Flight": "W43428",
    "Dep Airport": "DUS",
    "Dep Time": "06:40:00",
    "Arr Airport": "NAP",
    "Arr Time": "08:50:00",
    "Pick-Up": "DUS-NAP W43428 06:40-08:50",
    "Drop-Off": "AMTSIT1JQK - Hotel Terme Royal Palm",
    "Resort": "Forio d Ischia",
    "Provider Name": "SUN AND SEA SRLS",
    "Lead Pax": "Mr. Rossi, Mario",
    "Adults": "2",
    "Children": "0",
    "Infants": "0",
    "Service Unit": "Shared",
    "Cost SCY": "78.40",
    ...overrides,
  };
}

function createFakeAdmin(opts: { forceServicesInsertError?: boolean } = {}) {
  const state = {
    hotels: [
      { id: HOTEL_ID, tenant_id: TENANT_ID, name: "Hotel Terme Royal Palm", normalized_name: "hotel terme royal palm", zone: "forio", city: "Forio" },
    ] as Array<Record<string, unknown>>,
    hotel_aliases: [] as Array<Record<string, unknown>>,
    agency_bookings: [] as Array<Record<string, unknown>>,
    services: [] as Array<Record<string, unknown>>,
    ferry_pickup_rules: [] as Array<Record<string, unknown>>,
    ferry_schedules: [] as Array<Record<string, unknown>>,
    service_audit_events: [] as Array<Record<string, unknown>>,
  };

  function from(table: keyof typeof state) {
    const rows = () => state[table];
    const filters: Array<[string, unknown]> = [];

    const builder = {
      select() {
        return builder;
      },
      eq(column: string, value: unknown) {
        filters.push([column, value]);
        return builder;
      },
      limit() {
        return builder;
      },
      then(resolve: (value: { data: Array<Record<string, unknown>>; error: null }) => unknown) {
        const matched = rows().filter((row) => filters.every(([col, val]) => row[col] === val));
        return Promise.resolve(resolve({ data: matched, error: null }));
      },
      async maybeSingle() {
        const match = rows().find((row) => filters.every(([col, val]) => row[col] === val));
        return { data: match ?? null, error: null };
      },
      insert(payload: Record<string, unknown> | Array<Record<string, unknown>>) {
        if (table === "services" && opts.forceServicesInsertError) {
          const errBuilder = {
            select() {
              return errBuilder;
            },
            then(resolve: (value: { data: null; error: { message: string } }) => unknown) {
              return Promise.resolve(resolve({ data: null, error: { message: "insert servizi rifiutato (simulato)" } }));
            },
          };
          return errBuilder;
        }
        const items = Array.isArray(payload) ? payload : [payload];
        const inserted = items.map((item) => ({ id: `${table}-${rows().length}-${Math.random().toString(36).slice(2)}`, ...item }));
        state[table] = [...rows(), ...inserted] as never;
        const insertBuilder = {
          select() {
            return insertBuilder;
          },
          async single() {
            return { data: inserted[0] ?? null, error: null };
          },
          then(resolve: (value: { data: typeof inserted; error: null }) => unknown) {
            return Promise.resolve(resolve({ data: inserted, error: null }));
          },
        };
        return insertBuilder;
      },
      delete() {
        const deleteFilters: Array<[string, unknown]> = [];
        const deleteBuilder = {
          eq(column: string, value: unknown) {
            deleteFilters.push([column, value]);
            if (deleteFilters.length === 2) {
              state[table] = rows().filter((row) => !deleteFilters.every(([col, val]) => row[col] === val)) as never;
              return Promise.resolve({ error: null });
            }
            return deleteBuilder;
          },
        };
        return deleteBuilder;
      },
    };
    return builder;
  }

  return { admin: { from } as never, state };
}

// recordServiceAuditEventsBatch è "fire and forget" (void, non awaited dal
// chiamante) — un piccolo flush dei microtask basta a farla completare
// prima delle assertion, stesso pattern già in uso altrove in questa sessione.
async function flushMicrotasks() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("MTS Globe — service_audit_events scritto SOLO quando il servizio è realmente creato", () => {
  it("import riuscito (booking ready, hotel matchato): un evento per servizio, con service_id/tenant_id corretti e metadata minimi", async () => {
    const { admin, state } = createFakeAdmin();
    const rows = [baseRow({ "Voucher No": "V1" })];

    const result = await confirmMtsGlobeImport(admin, TENANT_ID, "user-1", rows, "import-run-1");
    await flushMicrotasks();

    expect(result.importedServiceCount).toBe(1);
    expect(state.services).toHaveLength(1);
    expect(state.service_audit_events).toHaveLength(1);

    const event = state.service_audit_events[0]!;
    expect(event.tenant_id).toBe(TENANT_ID);
    expect(event.service_id).toBe(state.services[0]!.id);
    expect(event.event_type).toBe("service_imported");
    expect(event.source).toBe("import_mts_globe");
    expect(event.actor_user_id).toBe("user-1");
    expect(event.booking_id).toBe(state.agency_bookings[0]!.id);
  });

  it("metadata minimi: solo voucher_no + source_import_id, nessuna riga Excel grezza (Drop-Off/Lead Pax/Pick-Up/...)", async () => {
    const { admin, state } = createFakeAdmin();
    const rows = [baseRow({ "Voucher No": "V1B" })];
    await confirmMtsGlobeImport(admin, TENANT_ID, "user-1", rows, "import-run-2");
    await flushMicrotasks();

    const newData = state.service_audit_events[0]!.new_data as Record<string, unknown>;
    expect(newData).toEqual({ voucher_no: "V1B", source_import_id: "import-run-2" });
    expect(JSON.stringify(newData)).not.toMatch(/Drop-Off|Lead Pax|Pick-Up|Resort|Provider Name/);
  });

  it("booking non confermabile (hotel sconosciuto, status warning): nessun servizio creato -> nessun evento", async () => {
    const { admin, state } = createFakeAdmin();
    const rows = [baseRow({ "Voucher No": "V2", "Drop-Off": "AXXX - Hotel Mai Visto Prima" })];

    const result = await confirmMtsGlobeImport(admin, TENANT_ID, "user-1", rows, null);
    await flushMicrotasks();

    expect(result.importedBookingCount).toBe(0);
    expect(state.services).toHaveLength(0);
    expect(state.service_audit_events).toHaveLength(0);
  });

  it("stesso file reimportato (status duplicate): saltato, nessun evento", async () => {
    const { admin, state } = createFakeAdmin();
    const rows = [baseRow({ "Voucher No": "V3" })];
    await confirmMtsGlobeImport(admin, TENANT_ID, "user-1", rows, null);
    await flushMicrotasks();
    expect(state.service_audit_events).toHaveLength(1);

    const secondResult = await confirmMtsGlobeImport(admin, TENANT_ID, "user-1", rows, null);
    await flushMicrotasks();
    expect(secondResult.skippedDuplicateCount).toBe(1);
    expect(state.service_audit_events).toHaveLength(1); // invariato, nessun nuovo evento per il duplicate
  });

  it("fallimento nella creazione dei servizi (rollback del booking): NESSUN evento scritto", async () => {
    const { admin, state } = createFakeAdmin({ forceServicesInsertError: true });
    const rows = [baseRow({ "Voucher No": "V4" })];

    const result = await confirmMtsGlobeImport(admin, TENANT_ID, "user-1", rows, null);
    await flushMicrotasks();

    expect(result.failedBookings).toHaveLength(1);
    expect(state.agency_bookings).toHaveLength(0); // rollbackato
    expect(state.services).toHaveLength(0);
    expect(state.service_audit_events).toHaveLength(0);
  });
});

describe("Source contract — la scrittura è posizionata DOPO il check di successo, mai prima", () => {
  it("recordServiceAuditEventsBatch appare dopo 'importedServiceCount +=' e dentro lo stesso blocco del loop (non nel ramo di errore)", () => {
    const source = readFileSync(join(process.cwd(), "lib/server/agency-imports/mts-globe-import.ts"), "utf8");

    const errorBranchStart = source.indexOf("if (servicesInsert.error) {");
    const errorBranchEnd = source.indexOf("continue;", errorBranchStart);
    const errorBranch = source.slice(errorBranchStart, errorBranchEnd);
    expect(errorBranch).not.toMatch(/recordServiceAuditEventsBatch/);

    const successPoint = source.indexOf("importedServiceCount += servicesInsert.data?.length ?? 0;");
    const nextLoopEnd = source.indexOf("\n  }\n\n  return { importedBookingCount", successPoint);
    const successBranch = source.slice(successPoint, nextLoopEnd);
    expect(successBranch).toMatch(/recordServiceAuditEventsBatch/);
    expect(successBranch).toMatch(/SERVICE_AUDIT_SOURCES\.IMPORT_MTS_GLOBE/);
  });
});
