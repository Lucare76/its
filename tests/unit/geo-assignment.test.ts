import { describe, expect, it } from "vitest";
import { validateDriverGeographicBatch, validateGeographicCompatibility, type TripGeoServiceRow } from "@/lib/server/geo-assignment";
import type { SupabaseClient } from "@supabase/supabase-js";

describe("geo assignment compatibility", () => {
  it("blocca il bug originale: Casamicciola e Ischia Porto allo stesso orario", () => {
    const result = validateGeographicCompatibility(
      { startTime: "09:30", endZone: "Casamicciola" },
      { startTime: "09:30", startZone: "Ischia Porto" }
    );

    expect(result.severity).toBe("block");
    expect(result.compatible).toBe(false);
  });

  it("accetta stessa macro-area con margine sufficiente", () => {
    const result = validateGeographicCompatibility(
      { startTime: "09:30", endZone: "Ischia Porto" },
      { startTime: "09:45", startZone: "Ischia Porto" }
    );

    expect(result.severity).toBe("ok");
    expect(result.compatible).toBe(true);
  });

  it("accetta macro-aree diverse con tempo sufficiente", () => {
    const result = validateGeographicCompatibility(
      { startTime: "09:00", endZone: "Casamicciola" },
      { startTime: "10:00", startZone: "Ischia Porto" }
    );

    expect(result.severity).toBe("ok");
    expect(result.compatible).toBe(true);
  });

  it("segnala warning per margine borderline", () => {
    const result = validateGeographicCompatibility(
      { startTime: "09:00", endZone: "Casamicciola" },
      { startTime: "09:22", startZone: "Ischia Porto" }
    );

    expect(result.requiredMinutes).toBe(20);
    expect(result.availableMinutes).toBe(22);
    expect(result.severity).toBe("warning");
    expect(result.compatible).toBe(true);
  });

  it("gestisce zona mancante senza crash", () => {
    const result = validateGeographicCompatibility(
      { startTime: "09:00", endZone: null },
      { startTime: "09:20", startZone: "Ischia Porto" }
    );

    expect(result.severity).toBe("warning");
    expect(result.compatible).toBe(true);
  });
});

// ─── validateDriverGeographicBatch — FUNC-01 (group_id=null residuo) ─────────
// Le assegnazioni scritte da departure-bus-assign hanno sempre group_id=null
// (quella route non usa trip_groups). Prima del fix, la query interna a
// validateDriverGeographicBatch filtrava esplicitamente group_id IS NOT NULL:
// un giro bus già assegnato allo stesso driver era invisibile a qualunque
// controllo geografico successivo, sia da departure-bus-assign sia da
// assign-service. Questi test esercitano l'helper condiviso direttamente
// (senza passare da una route HTTP), con un fake Supabase minimale dedicato.
type Row = Record<string, unknown>;

function createGeoFakeAdmin(seed: { assignments?: Row[]; services?: Row[]; hotels?: Row[]; memberships?: Row[] } = {}) {
  const assignments = seed.assignments ?? [];
  const services = seed.services ?? [];
  const hotels = seed.hotels ?? [];
  const memberships = seed.memberships ?? [];
  let assignmentsError: { message: string } | null = null;
  const calls = { assignmentsQueried: 0, hotelsQueried: 0 };

  function makeAssignmentsSelectBuilder() {
    let filtered = assignments;
    const builder = {
      eq(field: string, value: unknown) {
        filtered = filtered.filter((row) => row[field] === value);
        return builder;
      },
      then(resolve: (v: { data: Row[] | null; error: { message: string } | null }) => unknown, reject?: (e: unknown) => unknown) {
        calls.assignmentsQueried++;
        if (assignmentsError) {
          return Promise.resolve({ data: null, error: assignmentsError }).then(resolve, reject);
        }
        const withJoin = filtered.map((row) => ({
          ...row,
          services: services.find((s) => s.id === row.service_id) ?? null,
        }));
        return Promise.resolve({ data: withJoin, error: null }).then(resolve, reject);
      },
    };
    return builder;
  }

  function makeHotelsSelectBuilder() {
    let filtered = hotels;
    const builder = {
      eq(field: string, value: unknown) {
        filtered = filtered.filter((row) => row[field] === value);
        return builder;
      },
      in(field: string, values: unknown[]) {
        filtered = filtered.filter((row) => values.includes(row[field]));
        return builder;
      },
      then(resolve: (v: { data: Row[]; error: null }) => unknown, reject?: (e: unknown) => unknown) {
        calls.hotelsQueried++;
        return Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
      },
    };
    return builder;
  }

  function makeMembershipsSelectBuilder() {
    let filtered = memberships;
    const builder = {
      eq(field: string, value: unknown) {
        filtered = filtered.filter((row) => row[field] === value);
        return builder;
      },
      maybeSingle() {
        return Promise.resolve({ data: filtered[0] ?? null, error: null });
      },
    };
    return builder;
  }

  const admin = {
    from(table: string) {
      if (table === "assignments") return { select: () => makeAssignmentsSelectBuilder() };
      if (table === "hotels") return { select: () => makeHotelsSelectBuilder() };
      if (table === "memberships") return { select: () => makeMembershipsSelectBuilder() };
      throw new Error(`[geo fake] tabella non attesa: ${table}`);
    },
  };

  return {
    admin: admin as unknown as SupabaseClient,
    calls,
    setAssignmentsError(err: { message: string } | null) {
      assignmentsError = err;
    },
  };
}

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DRIVER_A = "d1111111-1111-4111-8111-111111111111";
const DRIVER_B = "d2222222-2222-4222-8222-222222222222";
const DATE_1 = "2026-08-10";
const DATE_2 = "2026-08-11";

function svc(id: string, overrides: Partial<TripGeoServiceRow> = {}): TripGeoServiceRow {
  return {
    id,
    date: DATE_1,
    time: "10:00:00",
    pickup_hotel: null,
    direction: "departure",
    hotel_id: null,
    meeting_point: null,
    ...overrides,
  };
}

describe("validateDriverGeographicBatch — FUNC-01 (group_id=null residuo)", () => {
  it("1. assignment precedente group_id=null con conflitto geografico reale -> block", async () => {
    const fake = createGeoFakeAdmin({
      assignments: [{ tenant_id: TENANT_A, driver_user_id: DRIVER_A, service_id: "old-1", group_id: null }],
      services: [{ id: "old-1", date: DATE_1, time: "09:00:00", direction: "departure", pickup_hotel: null, hotel_id: null, meeting_point: "Forio" }],
    });

    const result = await validateDriverGeographicBatch(fake.admin, TENANT_A, DRIVER_A, [
      svc("new-1", { time: "09:05:00", hotel_id: "hotel-1" }),
    ]);
    // hotel-1 non è seedato tra gli hotels: zona sconosciuta lato batch, ma
    // il lato "old" ha meeting_point "Forio" (nord_ovest) -> zona nota da un
    // lato basta a far scattare il margine cross/unknown insufficiente (5 min).

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("block");
  });

  it("2. assignment precedente group_id=null ma nessun conflitto reale -> ok", async () => {
    const fake = createGeoFakeAdmin({
      assignments: [{ tenant_id: TENANT_A, driver_user_id: DRIVER_A, service_id: "old-1", group_id: null }],
      services: [{ id: "old-1", date: DATE_1, time: "07:00:00", direction: "departure", pickup_hotel: null, hotel_id: null, meeting_point: "Forio" }],
    });

    const result = await validateDriverGeographicBatch(fake.admin, TENANT_A, DRIVER_A, [
      svc("new-1", { time: "14:00:00", meeting_point: "Forio" }),
    ]);

    expect(result).toEqual({ ok: true });
  });

  it("3. due assignment group_id=null dello stesso driver, stesso assigned_at: trattati come un'unica finestra, nessun falso conflitto interno propagato al nuovo batch", async () => {
    const sharedAssignedAt = "2026-01-01T08:00:00.000Z";
    const fake = createGeoFakeAdmin({
      assignments: [
        { tenant_id: TENANT_A, driver_user_id: DRIVER_A, service_id: "old-1", group_id: null, assigned_at: sharedAssignedAt },
        { tenant_id: TENANT_A, driver_user_id: DRIVER_A, service_id: "old-2", group_id: null, assigned_at: sharedAssignedAt },
      ],
      services: [
        { id: "old-1", date: DATE_1, time: "09:00:00", direction: "departure", pickup_hotel: null, hotel_id: "hotel-forio", meeting_point: null },
        { id: "old-2", date: DATE_1, time: "09:05:00", direction: "departure", pickup_hotel: null, hotel_id: "hotel-ischia", meeting_point: null },
      ],
      hotels: [
        { id: "hotel-forio", zone: "Forio" },
        { id: "hotel-ischia", zone: "Ischia Porto" },
      ],
    });

    // Se old-1/old-2 non venissero deduplicati per assigned_at, sarebbero due
    // finestre adiacenti in conflitto TRA LORO (Forio->Ischia Porto in soli 5
    // minuti, sotto i 20 richiesti cross-area): un batch nuovo del tutto
    // scollegato (15:00, ore dopo) verrebbe comunque bloccato per un
    // conflitto "interno" a un vecchio giro multi-tappa, che è esattamente
    // il falso positivo che la deduplica per assigned_at deve evitare.
    const result = await validateDriverGeographicBatch(fake.admin, TENANT_A, DRIVER_A, [
      svc("new-1", { time: "15:00:00", hotel_id: "hotel-ischia" }),
    ]);

    expect(result).toEqual({ ok: true });
  });

  it("3b. due assignment group_id=null con assigned_at DIVERSI: due giri storici distinti, ciascuno valutato indipendentemente", async () => {
    const fake = createGeoFakeAdmin({
      assignments: [
        { tenant_id: TENANT_A, driver_user_id: DRIVER_A, service_id: "old-1", group_id: null, assigned_at: "2026-01-01T08:00:00.000Z" },
        { tenant_id: TENANT_A, driver_user_id: DRIVER_A, service_id: "old-2", group_id: null, assigned_at: "2026-01-01T08:30:00.000Z" },
      ],
      services: [
        { id: "old-1", date: DATE_1, time: "09:00:00", direction: "departure", pickup_hotel: null, hotel_id: null, meeting_point: "Forio" },
        { id: "old-2", date: DATE_1, time: "20:00:00", direction: "departure", pickup_hotel: null, hotel_id: null, meeting_point: "Ischia Porto" },
      ],
    });

    // Nuovo batch alle 09:05, cross-area da Forio: conflitto reale solo con
    // old-1 (giro storico 1), non con old-2 (troppo lontano nel tempo) — le
    // due righe storiche, avendo assigned_at diversi, restano finestre
    // separate e non si fondono in un'unica finestra "media" innocua.
    const result = await validateDriverGeographicBatch(fake.admin, TENANT_A, DRIVER_A, [
      svc("new-1", { time: "09:05:00", hotel_id: "hotel-ischia" }),
    ]);

    expect(result.ok).toBe(false);
  });

  it("4. group_id valorizzato: comportamento invariato (conflitto reale ancora bloccato)", async () => {
    const fake = createGeoFakeAdmin({
      assignments: [{ tenant_id: TENANT_A, driver_user_id: DRIVER_A, service_id: "old-1", group_id: "grp-1" }],
      services: [{ id: "old-1", date: DATE_1, time: "09:00:00", direction: "departure", pickup_hotel: null, hotel_id: null, meeting_point: "Forio" }],
    });

    const result = await validateDriverGeographicBatch(fake.admin, TENANT_A, DRIVER_A, [
      svc("new-1", { time: "09:05:00", meeting_point: "Ischia Porto" }),
    ]);

    expect(result.ok).toBe(false);
  });

  it("5. il batch corrente è escluso dal confronto con sé stesso (riassegnazione stesso service_id, group_id=null)", async () => {
    const fake = createGeoFakeAdmin({
      assignments: [{ tenant_id: TENANT_A, driver_user_id: DRIVER_A, service_id: "svc-1", group_id: null }],
      services: [{ id: "svc-1", date: DATE_1, time: "09:00:00", direction: "departure", pickup_hotel: null, hotel_id: null, meeting_point: "Forio" }],
    });

    const result = await validateDriverGeographicBatch(fake.admin, TENANT_A, DRIVER_A, [
      svc("svc-1", { time: "09:00:00", meeting_point: "Forio" }),
    ]);

    expect(result).toEqual({ ok: true });
  });

  it("6. il service_id corrente è escluso anche quando fa parte di un giro storico multi-tappa (stesso assigned_at)", async () => {
    const sharedAssignedAt = "2026-01-01T08:00:00.000Z";
    const fake = createGeoFakeAdmin({
      assignments: [
        { tenant_id: TENANT_A, driver_user_id: DRIVER_A, service_id: "svc-1", group_id: null, assigned_at: sharedAssignedAt },
        { tenant_id: TENANT_A, driver_user_id: DRIVER_A, service_id: "svc-2", group_id: null, assigned_at: sharedAssignedAt },
      ],
      services: [
        { id: "svc-1", date: DATE_1, time: "09:00:00", direction: "departure", pickup_hotel: null, hotel_id: null, meeting_point: "Forio" },
        { id: "svc-2", date: DATE_1, time: "13:00:00", direction: "departure", pickup_hotel: null, hotel_id: null, meeting_point: "Forio" },
      ],
    });

    // Riassegno solo svc-1: svc-2 resta un "altro giro" (stesso assigned_at
    // ma non incluso nel batch corrente, escluso solo per il proprio
    // service_id) e deve continuare a essere confrontato normalmente — qui
    // compatibile (stessa zona, margine ampio: svc-1 è escluso quindi
    // l'unica finestra "altra" è svc-2 da sola contro il nuovo batch).
    const result = await validateDriverGeographicBatch(fake.admin, TENANT_A, DRIVER_A, [
      svc("svc-1", { time: "09:00:00", meeting_point: "Forio" }),
    ]);

    expect(result).toEqual({ ok: true });
  });

  it("7. data diversa: nessun blocco anche con orario/zona altrimenti in conflitto", async () => {
    const fake = createGeoFakeAdmin({
      assignments: [{ tenant_id: TENANT_A, driver_user_id: DRIVER_A, service_id: "old-1", group_id: null }],
      services: [{ id: "old-1", date: DATE_2, time: "09:05:00", direction: "departure", pickup_hotel: null, hotel_id: null, meeting_point: "Ischia Porto" }],
    });

    const result = await validateDriverGeographicBatch(fake.admin, TENANT_A, DRIVER_A, [
      svc("new-1", { date: DATE_1, time: "09:00:00", meeting_point: "Forio" }),
    ]);

    expect(result).toEqual({ ok: true });
  });

  it("8. driver diverso: nessun blocco (la query è già filtrata per driver_user_id)", async () => {
    const fake = createGeoFakeAdmin({
      assignments: [{ tenant_id: TENANT_A, driver_user_id: DRIVER_B, service_id: "old-1", group_id: null }],
      services: [{ id: "old-1", date: DATE_1, time: "09:05:00", direction: "departure", pickup_hotel: null, hotel_id: null, meeting_point: "Ischia Porto" }],
    });

    const result = await validateDriverGeographicBatch(fake.admin, TENANT_A, DRIVER_A, [
      svc("new-1", { time: "09:00:00", meeting_point: "Forio" }),
    ]);

    expect(result).toEqual({ ok: true });
  });

  it("9. tenant B: nessun blocco (la query è già filtrata per tenant_id)", async () => {
    const fake = createGeoFakeAdmin({
      assignments: [{ tenant_id: TENANT_B, driver_user_id: DRIVER_A, service_id: "old-1", group_id: null }],
      services: [{ id: "old-1", date: DATE_1, time: "09:05:00", direction: "departure", pickup_hotel: null, hotel_id: null, meeting_point: "Ischia Porto" }],
    });

    const result = await validateDriverGeographicBatch(fake.admin, TENANT_A, DRIVER_A, [
      svc("new-1", { time: "09:00:00", meeting_point: "Forio" }),
    ]);

    expect(result).toEqual({ ok: true });
  });

  it("11. warning per zona sconosciuta invariato: non blocca (severity warning, non block)", async () => {
    const fake = createGeoFakeAdmin({
      assignments: [{ tenant_id: TENANT_A, driver_user_id: DRIVER_A, service_id: "old-1", group_id: null }],
      services: [{ id: "old-1", date: DATE_1, time: "09:00:00", direction: "departure", pickup_hotel: null, hotel_id: null, meeting_point: null }],
    });

    // Zone sconosciute su entrambi i lati, margine di 20 min: >= ai 15
    // richiesti per zona sconosciuta -> "ok"/"warning", mai "block".
    const result = await validateDriverGeographicBatch(fake.admin, TENANT_A, DRIVER_A, [
      svc("new-1", { time: "09:20:00" }),
    ]);

    expect(result).toEqual({ ok: true });
  });

  it("12. errore nella query assignments -> fail-closed (kind: query_error)", async () => {
    const fake = createGeoFakeAdmin();
    fake.setAssignmentsError({ message: "connection refused: internal db detail xyz" });

    const result = await validateDriverGeographicBatch(fake.admin, TENANT_A, DRIVER_A, [svc("new-1")]);

    expect(result.ok).toBe(false);
    // Il messaggio grezzo del DB resta nel valore restituito dall'helper: la
    // sanificazione verso il client avviene nel caller (route.ts), non qui —
    // comportamento preesistente, invariato da questo fix.
    if (!result.ok) expect(result.kind).toBe("query_error");
  });

  it("13. nessun falso positivo su batch corrente multi-fermata legittimo (nessun'altra assegnazione)", async () => {
    const fake = createGeoFakeAdmin();

    const result = await validateDriverGeographicBatch(fake.admin, TENANT_A, DRIVER_A, [
      svc("new-1", { time: "09:00:00", hotel_id: "hotel-nord", meeting_point: null }),
      svc("new-2", { time: "09:02:00", hotel_id: "hotel-sud", meeting_point: null }),
    ]);

    expect(result).toEqual({ ok: true });
    expect(fake.calls.assignmentsQueried).toBe(1);
  });
});
