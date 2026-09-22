import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Chiude il gap residuo lasciato esplicitamente fuori scope dalla migration
 * 0282 (vedi commento in quella migration, sezione "AMBIGUITA' NOTE, NON
 * RISOLTE QUI"): oggi una reservation NON esclusiva puo' convivere con una
 * reservation ESCLUSIVA gia' attiva sullo stesso (tenant_id, bus_unit_id,
 * service_date), e viceversa — idx_bgbr_tenant_bus_date_exclusive blocca
 * solo due ESCLUSIVE in conflitto tra loro.
 *
 * Fix: migration 0284, trigger BEFORE INSERT/UPDATE
 * (trg_bgbr_enforce_exclusivity) con pg_advisory_xact_lock sul bucket per
 * serializzare i writer concorrenti prima del check — non un semplice
 * SELECT-poi-INSERT applicativo.
 *
 * Il fake admin qui sotto modella lo STESSO comportamento del trigger reale:
 * - check e scrittura nello stesso tick sincrono (nessun `await` di mezzo),
 *   cosi' anche due chiamate lanciate con Promise.all non vedono mai
 *   entrambe "nessun conflitto" (equivalente all'advisory lock in Postgres);
 * - upsert (onConflict tenant+group+bus+data) per i percorsi raggiungibili
 *   da reserveBookingGroupBus;
 * - un update "grezzo" a livello di riga (per id) per lo scenario che
 *   l'applicazione non espone ancora come endpoint dedicato (spostamento di
 *   una reservation su un bus/data diverso) — verificato direttamente contro
 *   il modello del vincolo DB, come richiesto dal comportamento del trigger
 *   0284 che si applica anche in UPDATE OF bus_unit_id/service_date.
 */

const mocks = vi.hoisted(() => ({ auditLog: vi.fn() }));
vi.mock("@/lib/server/ops-audit", () => ({ auditLog: mocks.auditLog }));

import { reserveBookingGroupBus } from "@/lib/server/booking-groups-service";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const GROUP_1 = "11111111-1111-4111-8111-111111111111";
const GROUP_2 = "22222222-2222-4222-8222-222222222222";
const BUS_A = "33333333-3333-4333-8333-333333333333";
const BUS_B = "44444444-4444-4444-8444-444444444444";
const DATE_1 = "2026-09-20";
const DATE_2 = "2026-09-27";

type Row = Record<string, unknown>;

/** Riproduce esattamente la logica di trg_bgbr_enforce_exclusivity (0284). */
function findTriggerConflict(rows: Row[], candidate: Row, excludeId?: string) {
  const sameBucket = rows.filter(
    (r) =>
      r.id !== excludeId &&
      r.tenant_id === candidate.tenant_id &&
      r.bus_unit_id === candidate.bus_unit_id &&
      r.service_date === candidate.service_date,
  );
  if (candidate.exclusive === true) {
    const exclusiveConflict = sameBucket.find((r) => r.exclusive === true);
    if (exclusiveConflict) return { code: "23505", message: "bgbr_conflict_exclusive_exists" };
    if (sameBucket.length > 0) return { code: "23505", message: "bgbr_conflict_occupied" };
    return null;
  }
  const exclusiveConflict = sameBucket.find((r) => r.exclusive === true);
  if (exclusiveConflict) return { code: "23505", message: "bgbr_conflict_exclusive_exists" };
  return null;
}

function makeAdmin(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {
    booking_groups: [...(seed.booking_groups ?? [])],
    tenant_bus_units: [...(seed.tenant_bus_units ?? [])],
    booking_group_bus_reservations: [...(seed.booking_group_bus_reservations ?? [])],
  };
  let counter = 0;

  function builder(table: string) {
    const filters: Row = {};
    let pending: { kind: "upsert" | "update"; payload: Row } | null = null;

    const rowsForFilters = () => (tables[table] ?? []).filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v));

    const finishUpsert = () => {
      const payload = pending!.payload;
      const existing = (tables[table] ?? []).find(
        (r) =>
          r.tenant_id === payload.tenant_id &&
          r.booking_group_id === payload.booking_group_id &&
          r.bus_unit_id === payload.bus_unit_id &&
          r.service_date === payload.service_date,
      );
      const candidate = { ...(existing ?? {}), ...payload };
      const conflict = findTriggerConflict(tables[table] ?? [], candidate, existing?.id as string | undefined);
      if (conflict) return { data: null, error: conflict };

      if (existing) {
        Object.assign(existing, payload);
        return { data: { ...existing }, error: null };
      }
      const row = { id: `bgbr-${++counter}`, ...payload };
      (tables[table] ??= []).push(row);
      return { data: row, error: null };
    };

    const finishUpdate = () => {
      const payload = pending!.payload;
      const target = (tables[table] ?? []).find((r) => Object.entries(filters).every(([k, v]) => r[k] === v));
      if (!target) return { data: null, error: null };
      const candidate = { ...target, ...payload };
      const conflict = findTriggerConflict(tables[table] ?? [], candidate, target.id as string);
      if (conflict) return { data: null, error: conflict };
      Object.assign(target, payload);
      return { data: { ...target }, error: null };
    };

    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = (col: string, val: unknown) => { filters[col] = val; return b; };
    b.upsert = (payload: Row, _opts?: { onConflict: string }) => { pending = { kind: "upsert", payload }; return b; };
    b.update = (payload: Row) => { pending = { kind: "update", payload }; return b; };
    b.maybeSingle = async () => {
      if (pending?.kind === "upsert") return finishUpsert();
      if (pending?.kind === "update") return finishUpdate();
      return { data: rowsForFilters()[0] ?? null, error: null };
    };
    b.single = b.maybeSingle;
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      if (pending?.kind === "update") {
        return Promise.resolve(finishUpdate()).then(resolve, reject);
      }
      const rows = rowsForFilters();
      return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
    };
    return b;
  }

  return { admin: { from: (t: string) => builder(t) } as never, tables };
}

const actorA = { tenantId: TENANT_A, userId: "u1", role: "operator" };
const actorB = { tenantId: TENANT_B, userId: "u2", role: "operator" };

function baseSeed(overrides: Partial<Record<string, Row[]>> = {}): Record<string, Row[]> {
  return {
    booking_groups: [
      { id: GROUP_1, tenant_id: TENANT_A },
      { id: GROUP_2, tenant_id: TENANT_A },
    ],
    tenant_bus_units: [
      { id: BUS_A, tenant_id: TENANT_A },
      { id: BUS_B, tenant_id: TENANT_A },
    ],
    booking_group_bus_reservations: [],
    ...overrides,
  };
}

beforeEach(() => { vi.clearAllMocks(); });

describe("Migration 0284 — esclusione mista exclusive/non-exclusive per (tenant, bus, data)", () => {
  it("1. non-exclusive + non-exclusive → allowed", async () => {
    const { admin, tables } = makeAdmin(baseSeed());
    const r1 = await reserveBookingGroupBus(admin, actorA, { bookingGroupId: GROUP_1, busUnitId: BUS_A, service_date: DATE_1, reserved_pax: 10, exclusive: false });
    const r2 = await reserveBookingGroupBus(admin, actorA, { bookingGroupId: GROUP_2, busUnitId: BUS_A, service_date: DATE_1, reserved_pax: 12, exclusive: false });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(tables.booking_group_bus_reservations).toHaveLength(2);
  });

  it("2. non-exclusive esistente + tentativo exclusive → denied", async () => {
    const { admin, tables } = makeAdmin(baseSeed());
    const r1 = await reserveBookingGroupBus(admin, actorA, { bookingGroupId: GROUP_1, busUnitId: BUS_A, service_date: DATE_1, reserved_pax: 10, exclusive: false });
    const r2 = await reserveBookingGroupBus(admin, actorA, { bookingGroupId: GROUP_2, busUnitId: BUS_A, service_date: DATE_1, reserved_pax: 12, exclusive: true });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.status).toBe(409);
      expect(r2.error).not.toMatch(/duplicate key value|constraint/i);
    }
    expect(tables.booking_group_bus_reservations).toHaveLength(1);
  });

  it("3. exclusive esistente + tentativo non-exclusive → denied", async () => {
    const { admin, tables } = makeAdmin(baseSeed());
    const r1 = await reserveBookingGroupBus(admin, actorA, { bookingGroupId: GROUP_1, busUnitId: BUS_A, service_date: DATE_1, reserved_pax: 20, exclusive: true });
    const r2 = await reserveBookingGroupBus(admin, actorA, { bookingGroupId: GROUP_2, busUnitId: BUS_A, service_date: DATE_1, reserved_pax: 12, exclusive: false });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.status).toBe(409);
      expect(r2.error).toMatch(/già riservato in esclusiva/i);
    }
    expect(tables.booking_group_bus_reservations).toHaveLength(1);
  });

  it("4. exclusive esistente + tentativo exclusive → denied", async () => {
    const { admin, tables } = makeAdmin(baseSeed());
    const r1 = await reserveBookingGroupBus(admin, actorA, { bookingGroupId: GROUP_1, busUnitId: BUS_A, service_date: DATE_1, reserved_pax: 20, exclusive: true });
    const r2 = await reserveBookingGroupBus(admin, actorA, { bookingGroupId: GROUP_2, busUnitId: BUS_A, service_date: DATE_1, reserved_pax: 12, exclusive: true });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.status).toBe(409);
    expect(tables.booking_group_bus_reservations).toHaveLength(1);
  });

  it("5. altra data → allowed", async () => {
    const { admin, tables } = makeAdmin(baseSeed());
    const r1 = await reserveBookingGroupBus(admin, actorA, { bookingGroupId: GROUP_1, busUnitId: BUS_A, service_date: DATE_1, reserved_pax: 20, exclusive: true });
    const r2 = await reserveBookingGroupBus(admin, actorA, { bookingGroupId: GROUP_2, busUnitId: BUS_A, service_date: DATE_2, reserved_pax: 12, exclusive: false });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(tables.booking_group_bus_reservations).toHaveLength(2);
  });

  it("6. altro bus → allowed", async () => {
    const { admin, tables } = makeAdmin(baseSeed());
    const r1 = await reserveBookingGroupBus(admin, actorA, { bookingGroupId: GROUP_1, busUnitId: BUS_A, service_date: DATE_1, reserved_pax: 20, exclusive: true });
    const r2 = await reserveBookingGroupBus(admin, actorA, { bookingGroupId: GROUP_2, busUnitId: BUS_B, service_date: DATE_1, reserved_pax: 12, exclusive: false });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(tables.booking_group_bus_reservations).toHaveLength(2);
  });

  it("7. altro tenant → allowed", async () => {
    const seed = baseSeed({
      booking_groups: [
        { id: GROUP_1, tenant_id: TENANT_A },
        { id: GROUP_2, tenant_id: TENANT_B },
      ],
      tenant_bus_units: [
        { id: BUS_A, tenant_id: TENANT_A },
        { id: BUS_A, tenant_id: TENANT_B },
      ],
    });
    const { admin, tables } = makeAdmin(seed);
    const r1 = await reserveBookingGroupBus(admin, actorA, { bookingGroupId: GROUP_1, busUnitId: BUS_A, service_date: DATE_1, reserved_pax: 20, exclusive: true });
    const r2 = await reserveBookingGroupBus(admin, actorB, { bookingGroupId: GROUP_2, busUnitId: BUS_A, service_date: DATE_1, reserved_pax: 12, exclusive: false });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(tables.booking_group_bus_reservations).toHaveLength(2);
  });

  it("8. update false→true con altre righe presenti sul bucket → denied", async () => {
    const { admin, tables } = makeAdmin(baseSeed());
    await reserveBookingGroupBus(admin, actorA, { bookingGroupId: GROUP_1, busUnitId: BUS_A, service_date: DATE_1, reserved_pax: 10, exclusive: false });
    await reserveBookingGroupBus(admin, actorA, { bookingGroupId: GROUP_2, busUnitId: BUS_A, service_date: DATE_1, reserved_pax: 12, exclusive: false });
    const res = await reserveBookingGroupBus(admin, actorA, { bookingGroupId: GROUP_1, busUnitId: BUS_A, service_date: DATE_1, reserved_pax: 10, exclusive: true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(409);
    expect(tables.booking_group_bus_reservations).toHaveLength(2);
    expect(tables.booking_group_bus_reservations.find((r) => r.booking_group_id === GROUP_1)?.exclusive).toBe(false);
  });

  it("9. update false→true come unica riga del bucket → allowed", async () => {
    const { admin, tables } = makeAdmin(baseSeed());
    await reserveBookingGroupBus(admin, actorA, { bookingGroupId: GROUP_1, busUnitId: BUS_A, service_date: DATE_1, reserved_pax: 10, exclusive: false });
    const res = await reserveBookingGroupBus(admin, actorA, { bookingGroupId: GROUP_1, busUnitId: BUS_A, service_date: DATE_1, reserved_pax: 10, exclusive: true });
    expect(res.ok).toBe(true);
    expect(tables.booking_group_bus_reservations).toHaveLength(1);
    expect(tables.booking_group_bus_reservations[0]?.exclusive).toBe(true);
  });

  it("10. update (spostamento riga) verso bus/data gia' incompatibile → denied", async () => {
    // Scenario DB-level: l'app non espone oggi un endpoint dedicato per
    // "spostare" una reservation su un altro bus/data (reserveBookingGroupBus
    // aggiorna in place solo a parita' di group+bus+data). Il trigger 0284
    // si applica comunque a QUALSIASI UPDATE di bus_unit_id/service_date/
    // exclusive, quindi verifichiamo direttamente il comportamento del
    // vincolo modellato contro un update grezzo per id.
    const { admin, tables } = makeAdmin(baseSeed());
    await reserveBookingGroupBus(admin, actorA, { bookingGroupId: GROUP_2, busUnitId: BUS_B, service_date: DATE_1, reserved_pax: 20, exclusive: true }); // occupa BUS_B/DATE_1
    const movable = await reserveBookingGroupBus(admin, actorA, { bookingGroupId: GROUP_1, busUnitId: BUS_A, service_date: DATE_1, reserved_pax: 10, exclusive: false });
    expect(movable.ok).toBe(true);
    const movableId = (movable.ok ? movable.data.reservation.id : undefined) as string;

    const { error } = await (admin as { from: (t: string) => { update: (p: Row) => { eq: (c: string, v: unknown) => { eq: (c: string, v: unknown) => Promise<{ data: unknown; error: unknown }> } } } })
      .from("booking_group_bus_reservations")
      .update({ bus_unit_id: BUS_B, exclusive: false })
      .eq("id", movableId)
      .eq("tenant_id", TENANT_A);
    expect(error).toBeTruthy();
    expect((error as { code?: string })?.code).toBe("23505");
    // riga sorgente invariata: nessuna scrittura parziale
    expect(tables.booking_group_bus_reservations.find((r) => r.id === movableId)?.bus_unit_id).toBe(BUS_A);
  });

  it("11. concorrenza reale: una exclusive e una non-exclusive simultanee → vince una sola", async () => {
    const { admin, tables } = makeAdmin(baseSeed());
    const [resExclusive, resNonExclusive] = await Promise.all([
      reserveBookingGroupBus(admin, actorA, { bookingGroupId: GROUP_1, busUnitId: BUS_A, service_date: DATE_1, reserved_pax: 20, exclusive: true }),
      reserveBookingGroupBus(admin, actorA, { bookingGroupId: GROUP_2, busUnitId: BUS_A, service_date: DATE_1, reserved_pax: 10, exclusive: false }),
    ]);
    const results = [resExclusive, resNonExclusive];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(1);
    expect(tables.booking_group_bus_reservations).toHaveLength(1);
  });

  it("12. concorrenza reale: due non-exclusive simultanee → entrambe consentite", async () => {
    const { admin, tables } = makeAdmin(baseSeed());
    const [r1, r2] = await Promise.all([
      reserveBookingGroupBus(admin, actorA, { bookingGroupId: GROUP_1, busUnitId: BUS_A, service_date: DATE_1, reserved_pax: 10, exclusive: false }),
      reserveBookingGroupBus(admin, actorA, { bookingGroupId: GROUP_2, busUnitId: BUS_A, service_date: DATE_1, reserved_pax: 12, exclusive: false }),
    ]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(tables.booking_group_bus_reservations).toHaveLength(2);
  });

  it("13. errore mappato sempre a HTTP 409, mai 500", async () => {
    const { admin } = makeAdmin(baseSeed());
    await reserveBookingGroupBus(admin, actorA, { bookingGroupId: GROUP_1, busUnitId: BUS_A, service_date: DATE_1, reserved_pax: 20, exclusive: true });
    const res = await reserveBookingGroupBus(admin, actorA, { bookingGroupId: GROUP_2, busUnitId: BUS_A, service_date: DATE_1, reserved_pax: 10, exclusive: false });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(409);
  });

  it("14. nessun audit scritto sul tentativo fallito", async () => {
    const { admin } = makeAdmin(baseSeed());
    await reserveBookingGroupBus(admin, actorA, { bookingGroupId: GROUP_1, busUnitId: BUS_A, service_date: DATE_1, reserved_pax: 20, exclusive: true });
    mocks.auditLog.mockClear();
    const res = await reserveBookingGroupBus(admin, actorA, { bookingGroupId: GROUP_2, busUnitId: BUS_A, service_date: DATE_1, reserved_pax: 10, exclusive: false });
    expect(res.ok).toBe(false);
    expect(mocks.auditLog).not.toHaveBeenCalled();
  });
});
