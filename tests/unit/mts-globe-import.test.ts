import { describe, expect, it } from "vitest";
import { buildMtsGlobePreview, confirmMtsGlobeImport } from "@/lib/server/agency-imports/mts-globe-import";

const TENANT_ID = "tenant-1";
const HOTEL_ID = "hotel-royal-palm";
const HOTEL_ID_2 = "hotel-best-western";
const HOTEL_ID_NAPOLI = "hotel-ramada-napoli";

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
    ...overrides
  };
}

/**
 * Fake minimale del client Supabase, sufficiente a guidare
 * buildMtsGlobePreview/confirmMtsGlobeImport senza un DB reale.
 * Stato in-memory per tenant: hotels, hotel_aliases, agency_bookings, services.
 */
function createFakeAdmin() {
  const state = {
    hotels: [
      { id: HOTEL_ID, tenant_id: TENANT_ID, name: "Hotel Terme Royal Palm", normalized_name: "hotel terme royal palm", zone: "forio", city: "Forio" },
      { id: HOTEL_ID_2, tenant_id: TENANT_ID, name: "Best Western Plus Hotel Plaza Napoli", normalized_name: "best western plus hotel plaza napoli", zone: "ischia", city: "Ischia" },
      { id: HOTEL_ID_NAPOLI, tenant_id: TENANT_ID, name: "Ramada by Wyndham Naples", normalized_name: "ramada by wyndham naples", zone: "Napoli", city: "Napoli" }
    ] as Array<Record<string, unknown>>,
    hotel_aliases: [] as Array<Record<string, unknown>>,
    agency_bookings: [] as Array<Record<string, unknown>>,
    services: [] as Array<Record<string, unknown>>,
    ferry_pickup_rules: [] as Array<Record<string, unknown>>,
    ferry_schedules: [] as Array<Record<string, unknown>>
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
          }
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
          }
        };
        return deleteBuilder;
      }
    };
    return builder;
  }

  return { admin: { from } as never, state };
}

describe("buildMtsGlobePreview / confirmMtsGlobeImport", () => {
  it("prima import: booking READY con hotel matchato, genera 1 servizio", async () => {
    const { admin } = createFakeAdmin();
    const rows = [baseRow({ "Voucher No": "V1" })];
    const preview = await buildMtsGlobePreview(admin, TENANT_ID, rows);
    expect(preview.bookings).toHaveLength(1);
    expect(preview.bookings[0].status).toBe("ready");
    expect(preview.bookings[0].generatedServices).toHaveLength(1);
  });

  it("hotel sconosciuto produce status warning in preview, ma NON e' confermabile: confirm non scrive nulla", async () => {
    const { admin, state } = createFakeAdmin();
    const rows = [baseRow({ "Voucher No": "V2", "Drop-Off": "AXXX - Hotel Mai Visto Prima" })];

    const preview = await buildMtsGlobePreview(admin, TENANT_ID, rows);
    expect(preview.bookings[0].status).toBe("warning");
    expect(preview.bookings[0].generatedServices[0].hotelId).toBeNull();

    const result = await confirmMtsGlobeImport(admin, TENANT_ID, null, rows, null);
    expect(result.importedBookingCount).toBe(0);
    expect(state.agency_bookings).toHaveLength(0);
    expect(state.services).toHaveLength(0);
  });

  it("correzione hotel dell'operatore risolve il WARNING: preview diventa ready e il confirm crea il booking", async () => {
    const { admin, state } = createFakeAdmin();
    const rows = [baseRow({ "Voucher No": "V2B", "Drop-Off": "AXXX - Hotel Mai Visto Prima" })];
    const rowIndex = (await buildMtsGlobePreview(admin, TENANT_ID, rows)).bookings[0];
    expect(rowIndex.status).toBe("warning");

    const legRowIndex = 2; // prima (e unica) riga dati del file, header = riga 1
    const corrections = { [`V2B#${legRowIndex}`]: HOTEL_ID };

    const correctedPreview = await buildMtsGlobePreview(admin, TENANT_ID, rows, corrections);
    expect(correctedPreview.bookings[0].status).toBe("ready");
    expect(correctedPreview.bookings[0].generatedServices[0].hotelId).toBe(HOTEL_ID);

    const result = await confirmMtsGlobeImport(admin, TENANT_ID, null, rows, null, corrections);
    expect(result.importedBookingCount).toBe(1);
    expect(state.agency_bookings).toHaveLength(1);
    expect(state.services).toHaveLength(1);
    expect(state.services[0].hotel_id).toBe(HOTEL_ID);
  });

  it("stesso file importato due volte: la seconda volta il booking risulta duplicate e non crea nulla", async () => {
    const { admin, state } = createFakeAdmin();
    const rows = [baseRow({ "Voucher No": "V3" })];

    const first = await confirmMtsGlobeImport(admin, TENANT_ID, null, rows, null);
    expect(first.importedBookingCount).toBe(1);
    expect(first.importedServiceCount).toBe(1);
    expect(state.agency_bookings).toHaveLength(1);
    expect(state.services).toHaveLength(1);

    const second = await confirmMtsGlobeImport(admin, TENANT_ID, null, rows, null);
    expect(second.importedBookingCount).toBe(0);
    expect(second.skippedDuplicateCount).toBe(1);
    expect(state.agency_bookings).toHaveLength(1);
    expect(state.services).toHaveLength(1);
  });

  it("pratica modificata dopo il primo import risulta status update e non viene sovrascritta automaticamente", async () => {
    const { admin, state } = createFakeAdmin();
    const rows = [baseRow({ "Voucher No": "V4" })];
    await confirmMtsGlobeImport(admin, TENANT_ID, null, rows, null);
    expect(state.agency_bookings).toHaveLength(1);

    const changedRows = [baseRow({ "Voucher No": "V4", "Adults": "4" })];
    const preview = await buildMtsGlobePreview(admin, TENANT_ID, changedRows);
    expect(preview.bookings[0].status).toBe("update");

    const confirmAgain = await confirmMtsGlobeImport(admin, TENANT_ID, null, changedRows, null);
    expect(confirmAgain.importedBookingCount).toBe(0);
    expect(state.agency_bookings).toHaveLength(1);
    expect(state.services).toHaveLength(1);
  });

  it("agenzia Sun&Sea (da Provider Name) non ha logica nave mappata: nessun fallback silenzioso, warning di trasparenza esplicito", async () => {
    const { admin } = createFakeAdmin();
    const rows = [
      baseRow({ "Voucher No": "V5", "Service Base Code": "Arrivi" }),
      baseRow({
        "Voucher No": "V5",
        "Service Base Code": "Partenza",
        "Start Date": "06.09.2026",
        "Pick-Up": "AMTSIT1JQK - Hotel Terme Royal Palm",
        "Drop-Off": "NAP-DUS W43429 10:10-12:25",
        "Dep Time": "10:10:00"
      })
    ];
    const preview = await buildMtsGlobePreview(admin, TENANT_ID, rows);
    expect(preview.bookings[0].reasons.join(" ")).toContain('Agenzia "SUN AND SEA SRLS" non mappata');
    // Nessun mapping silenzioso a un'altra agenzia: il pickup calcolato usa
    // comunque la policy di default (nessun crash, nessun blocco), ma il
    // warning informa l'operatore che non e' una regola dedicata Sun&Sea.
    const departureService = preview.bookings[0].generatedServices.find((s) => s.direction === "departure");
    expect(departureService?.pickupHotel).not.toBeNull();
  });

  it("Intermedio con orario reale in riga (Dep Time valorizzato) usa quell'orario, nessun warning", async () => {
    const { admin } = createFakeAdmin();
    const rows = [
      baseRow({
        "Voucher No": "V6",
        "Service Base Code": "Intermedio",
        "Pick-Up": "AMTSIT1JQK - Hotel Terme Royal Palm",
        "Drop-Off": "AITNAPKI08 - Best Western Plus Hotel Plaza Napoli",
        "Dep Time": "09:15:00"
      })
    ];
    const preview = await buildMtsGlobePreview(admin, TENANT_ID, rows);
    expect(preview.bookings[0].status).toBe("ready");
    expect(preview.bookings[0].generatedServices[0].time).toBe("09:15");
    expect(preview.bookings[0].reasons).not.toContain("Orario transfer Intermedio mancante.");
  });

  it("Intermedio senza alcun orario in riga produce WARNING bloccante: confirm non scrive nulla", async () => {
    const { admin, state } = createFakeAdmin();
    const rows = [
      baseRow({
        "Voucher No": "V7",
        "Service Base Code": "Intermedio",
        "Flight": " ",
        "Dep Airport": " ",
        "Dep Time": " ",
        "Arr Airport": " ",
        "Arr Time": " ",
        "Pick-Up": "AMTSIT1JQK - Hotel Terme Royal Palm",
        "Drop-Off": "AITNAPKI08 - Best Western Plus Hotel Plaza Napoli"
      })
    ];
    const preview = await buildMtsGlobePreview(admin, TENANT_ID, rows);
    expect(preview.bookings[0].status).toBe("warning");
    expect(preview.bookings[0].reasons).toContain("Orario transfer Intermedio mancante.");
    expect(preview.bookings[0].generatedServices[0].time).toBe("");

    const result = await confirmMtsGlobeImport(admin, TENANT_ID, null, rows, null);
    expect(result.importedBookingCount).toBe(0);
    expect(state.agency_bookings).toHaveLength(0);
    expect(state.services).toHaveLength(0);
  });

  it("correzione manuale dell'orario Intermedio sblocca il WARNING: preview diventa ready, confirm crea, reimport diventa duplicate", async () => {
    const { admin, state } = createFakeAdmin();
    const rows = [
      baseRow({
        "Voucher No": "V8",
        "Service Base Code": "Intermedio",
        "Flight": " ",
        "Dep Airport": " ",
        "Dep Time": " ",
        "Arr Airport": " ",
        "Arr Time": " ",
        "Pick-Up": "AMTSIT1JQK - Hotel Terme Royal Palm",
        "Drop-Off": "AITNAPKI08 - Best Western Plus Hotel Plaza Napoli"
      })
    ];
    const legRowIndex = 2; // unica riga dati, header = riga 1
    const timeCorrections = { [`V8#${legRowIndex}#time`]: "14:30" };

    const correctedPreview = await buildMtsGlobePreview(admin, TENANT_ID, rows, {}, timeCorrections);
    expect(correctedPreview.bookings[0].status).toBe("ready");
    expect(correctedPreview.bookings[0].generatedServices[0].time).toBe("14:30");

    const result = await confirmMtsGlobeImport(admin, TENANT_ID, null, rows, null, {}, timeCorrections);
    expect(result.importedBookingCount).toBe(1);
    expect(state.agency_bookings).toHaveLength(1);
    expect(state.services).toHaveLength(1);
    expect(state.services[0].time).toBe("14:30");

    const reimport = await confirmMtsGlobeImport(admin, TENANT_ID, null, rows, null, {}, timeCorrections);
    expect(reimport.importedBookingCount).toBe(0);
    expect(reimport.skippedDuplicateCount).toBe(1);
    expect(state.agency_bookings).toHaveLength(1);
  });

  it("regressione: source_payload con chiavi in ordine diverso (come da round-trip Postgres JSONB reale) risulta comunque duplicate, non update", async () => {
    // Bug reale osservato in test live contro Supabase: JSONB non preserva
    // l'ordine di inserimento delle chiavi. Un JSON.stringify() ingenuo tra
    // l'oggetto appena costruito e quello riletto dal DB falliva sempre il
    // confronto anche a parita' di contenuto. Qui simuliamo lo stesso
    // scenario senza un DB reale: stesso contenuto, ordine chiavi diverso.
    const { admin, state } = createFakeAdmin();
    const rows = [baseRow({ "Voucher No": "V9" })];

    const first = await confirmMtsGlobeImport(admin, TENANT_ID, null, rows, null);
    expect(first.importedBookingCount).toBe(1);
    expect(state.agency_bookings).toHaveLength(1);

    const stored = state.agency_bookings[0] as { source_payload: { voucher_no: string; customer_name: string; legs: Record<string, unknown>[] } };
    const originalLeg = stored.source_payload.legs[0];
    // Ricostruisce lo stesso contenuto con le chiavi in un ordine diverso,
    // esattamente come farebbe Postgres JSONB in lettura.
    stored.source_payload = {
      legs: [
        Object.fromEntries(Object.entries(originalLeg).reverse())
      ],
      customer_name: stored.source_payload.customer_name,
      voucher_no: stored.source_payload.voucher_no
    };

    const preview = await buildMtsGlobePreview(admin, TENANT_ID, rows);
    expect(preview.bookings[0].status).toBe("duplicate");

    const second = await confirmMtsGlobeImport(admin, TENANT_ID, null, rows, null);
    expect(second.importedBookingCount).toBe(0);
    expect(second.skippedDuplicateCount).toBe(1);
    expect(state.agency_bookings).toHaveLength(1);
    expect(state.services).toHaveLength(1);
  });

  it("agency_bookings.hotel_id viene popolato con l'hotel risolto del primo leg (prima restava sempre null)", async () => {
    const { admin, state } = createFakeAdmin();
    const rows = [baseRow({ "Voucher No": "V10" })];
    await confirmMtsGlobeImport(admin, TENANT_ID, null, rows, null);
    expect(state.agency_bookings[0].hotel_id).toBe(HOTEL_ID);
  });

  it("correzione hotel destinazione Intermedio: notes/hotelToNameRaw riflettono il nome hotel risolto, non il testo grezzo errato", async () => {
    const { admin } = createFakeAdmin();
    const rows = [
      baseRow({
        "Voucher No": "V11",
        "Service Base Code": "Intermedio",
        "Flight": " ",
        "Dep Airport": " ",
        "Dep Time": " ",
        "Arr Airport": " ",
        "Arr Time": " ",
        "Pick-Up": "AMTSIT1JQK - Hotel Terme Royal Palm",
        "Drop-Off": "AXXX - Hotel Sbagliato Nel File"
      })
    ];
    const legRowIndex = 2;
    const corrections = { [`V11#${legRowIndex}#to`]: HOTEL_ID_2 };
    const timeCorrections = { [`V11#${legRowIndex}#time`]: "12:00" };

    const preview = await buildMtsGlobePreview(admin, TENANT_ID, rows, corrections, timeCorrections);
    expect(preview.bookings[0].status).toBe("ready");
    const service = preview.bookings[0].generatedServices[0];
    expect(service.hotelToNameRaw).toBe("Best Western Plus Hotel Plaza Napoli");
    expect(service.hotelToNameRaw).not.toBe("Hotel Sbagliato Nel File");
    expect(service.notes).toContain("Best Western Plus Hotel Plaza Napoli");
    expect(service.notes).not.toContain("Hotel Sbagliato Nel File");
  });

  it("partenza con hotel su comune di Ischia: applyPickupCalc viene applicato (pickup_hotel/vessel calcolati)", async () => {
    const { admin } = createFakeAdmin();
    const rows = [
      baseRow({
        "Voucher No": "V12",
        "Service Base Code": "Partenza",
        "Pick-Up": "AMTSIT1JQK - Hotel Terme Royal Palm",
        "Drop-Off": "NAP-DUS W43429 10:10-12:25",
        "Dep Time": "10:10:00"
      })
    ];
    const preview = await buildMtsGlobePreview(admin, TENANT_ID, rows);
    const service = preview.bookings[0].generatedServices[0];
    expect(service.hotelId).toBe(HOTEL_ID);
    // Nessuna regola canonica nel fixture -> fallback statico calcPickupTime,
    // ma il punto e' che il motore VIENE invocato (risultato non tutto null).
    expect(service.pickupHotel).not.toBeNull();
    expect(service.warnings).not.toContain(
      "Transfer continente non coperto dalla logica pickup automatica — verifica operatore."
    );
  });

  it("partenza con hotel su Napoli (continente): applyPickupCalc NON viene applicato, nessun pickup/nave/porto inventato, WARNING bloccante", async () => {
    const { admin, state } = createFakeAdmin();
    const rows = [
      baseRow({
        "Voucher No": "V13",
        "Service Base Code": "Partenza",
        "Pick-Up": "AMTSIT1JC4 - Ramada by Wyndham Naples",
        "Drop-Off": "NAP-DUS W43429 10:10-12:25",
        "Dep Time": "10:10:00"
      })
    ];
    const preview = await buildMtsGlobePreview(admin, TENANT_ID, rows);
    expect(preview.bookings[0].status).toBe("warning");
    const service = preview.bookings[0].generatedServices[0];
    expect(service.hotelId).toBe(HOTEL_ID_NAPOLI);
    expect(service.pickupHotel).toBeNull();
    expect(service.barcaCompagnia).toBeNull();
    expect(service.orarioBarca).toBeNull();
    expect(service.portoBruno).toBeNull();
    expect(service.warnings).toContain(
      "Transfer continente non coperto dalla logica pickup automatica — verifica operatore."
    );
    expect(preview.bookings[0].reasons).toContain(
      "Transfer continente non coperto dalla logica pickup automatica — verifica operatore."
    );

    const result = await confirmMtsGlobeImport(admin, TENANT_ID, null, rows, null);
    expect(result.importedBookingCount).toBe(0);
    expect(state.agency_bookings).toHaveLength(0);
    expect(state.services).toHaveLength(0);
  });
});
