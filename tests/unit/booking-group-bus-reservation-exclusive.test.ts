import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Fix P1-1 (audit pre-go-live): reserveBookingGroupBus faceva upsert con
 * onConflict (tenant_id, booking_group_id, bus_unit_id, service_date) — la
 * chiave include booking_group_id, quindi due gruppi DIVERSI non
 * collidevano mai a questo livello. Due richieste (concorrenti o anche solo
 * sequenziali) potevano riservare lo stesso bus in esclusiva per due gruppi
 * diversi nella stessa data.
 *
 * Fix: partial unique index idx_bgbr_tenant_bus_date_exclusive su
 * (tenant_id, bus_unit_id, service_date) WHERE exclusive = true (migration
 * 0282, proposta, NON applicata) + mapping del 23505 risultante a un errore
 * di business 409 chiaro in reserveBookingGroupBus.
 *
 * Il fake admin modella l'indice in modo atomico (nessun await fra
 * "controlla" e "scrivi", stesso principio già usato per system_job_runs in
 * tests/unit/job-health.test.ts): il check-e-riserva avviene nello stesso
 * tick sincrono dell'upsert, cosi' anche due chiamate lanciate insieme con
 * Promise.all non possono mai vedere entrambe "nessun conflitto".
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

/**
 * Fake Supabase in-memory, dedicato a booking_group_bus_reservations.
 * Modella ENTRAMBI i vincoli reali:
 * - unique preesistente (tenant_id, booking_group_id, bus_unit_id,
 *   service_date) — l'onConflict dichiarato nell'upsert: se combacia,
 *   aggiorna la riga esistente al posto di inserirne una nuova.
 * - NUOVO partial unique (tenant_id, bus_unit_id, service_date) WHERE
 *   exclusive = true (migration 0282): se una riga con exclusive=true
 *   esiste già per quella chiave (di QUALUNQUE gruppo) e la riga in
 *   scrittura avrebbe anch'essa exclusive=true, ritorna 23505 — sia sul
 *   percorso INSERT sia sul percorso UPDATE-in-place dell'upsert (identico
 *   a un vero indice Postgres, che si applica a entrambi).
 */
function makeAdmin(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {
    booking_groups: [...(seed.booking_groups ?? [])],
    tenant_bus_units: [...(seed.tenant_bus_units ?? [])],
    booking_group_bus_reservations: [...(seed.booking_group_bus_reservations ?? [])],
  };
  let counter = 0;

  function existingConflictingExclusive(payload: Row, excludeId?: string) {
    return (tables.booking_group_bus_reservations ?? []).find(
      (r) =>
        r.id !== excludeId &&
        r.tenant_id === payload.tenant_id &&
        r.bus_unit_id === payload.bus_unit_id &&
        r.service_date === payload.service_date &&
        r.exclusive === true,
    );
  }

  function builder(table: string) {
    const filters: Row = {};
    let pending: { kind: "upsert"; payload: Row } | null = null;

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

      const wouldBeExclusive = payload.exclusive === true;
      if (wouldBeExclusive) {
        const conflict = existingConflictingExclusive(payload, existing?.id as string | undefined);
        if (conflict) {
          // Migration 0284: il trigger trg_bgbr_enforce_exclusivity anticipa
          // sempre idx_bgbr_tenant_bus_date_exclusive e solleva 23505 con
          // marker "bgbr_conflict_exclusive_exists" (vedi
          // tests/unit/booking-group-bus-reservation-mixed-exclusivity.test.ts
          // per la copertura completa del nuovo trigger).
          return { data: null, error: { code: "23505", message: "bgbr_conflict_exclusive_exists: bus gia riservato in esclusiva" } };
        }
      }

      if (existing) {
        Object.assign(existing, payload); // reserva/scrive nello stesso tick, atomico
        return { data: { ...existing }, error: null };
      }
      const row = { id: `bgbr-${++counter}`, ...payload };
      (tables[table] ??= []).push(row); // reserva/scrive nello stesso tick, atomico
      return { data: row, error: null };
    };

    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = (col: string, val: unknown) => { filters[col] = val; return b; };
    b.upsert = (payload: Row, _opts?: { onConflict: string }) => { pending = { kind: "upsert", payload }; return b; };
    b.maybeSingle = async () => (pending ? finishUpsert() : { data: rowsForFilters()[0] ?? null, error: null });
    b.single = async () => (pending ? finishUpsert() : { data: rowsForFilters()[0] ?? null, error: null });
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
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

describe("Fix P1-1 — unicità reale reservation esclusiva bus per (tenant, bus, data)", () => {
  it("1. prima exclusive reservation → consentita", async () => {
    const { admin, tables } = makeAdmin(baseSeed());
    const res = await reserveBookingGroupBus(admin, actorA, { bookingGroupId: GROUP_1, busUnitId: BUS_A, service_date: DATE_1, reserved_pax: 20, exclusive: true });
    expect(res.ok).toBe(true);
    expect(tables.booking_group_bus_reservations).toHaveLength(1);
  });

  it("2. seconda exclusive stesso tenant/bus/data, gruppo diverso → negata con errore business 409 chiaro", async () => {
    const { admin, tables } = makeAdmin(baseSeed());
    await reserveBookingGroupBus(admin, actorA, { bookingGroupId: GROUP_1, busUnitId: BUS_A, service_date: DATE_1, reserved_pax: 20, exclusive: true });
    const res2 = await reserveBookingGroupBus(admin, actorA, { bookingGroupId: GROUP_2, busUnitId: BUS_A, service_date: DATE_1, reserved_pax: 15, exclusive: true });

    expect(res2.ok).toBe(false);
    if (!res2.ok) {
      expect(res2.status).toBe(409);
      expect(res2.error).toMatch(/già riservato in esclusiva per un altro gruppo/i);
    }
    expect(tables.booking_group_bus_reservations).toHaveLength(1); // nessuna seconda riga creata
  });

  it("3. race concorrente di due exclusive (Promise.all): una sola vince, l'altra riceve 409, 1 sola riga persistita", async () => {
    const { admin, tables } = makeAdmin(baseSeed());
    const [resA, resB] = await Promise.all([
      reserveBookingGroupBus(admin, actorA, { bookingGroupId: GROUP_1, busUnitId: BUS_A, service_date: DATE_1, reserved_pax: 20, exclusive: true }),
      reserveBookingGroupBus(admin, actorA, { bookingGroupId: GROUP_2, busUnitId: BUS_A, service_date: DATE_1, reserved_pax: 15, exclusive: true }),
    ]);
    const results = [resA, resB];
    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect((losers[0] as { status: number }).status).toBe(409);
    expect(tables.booking_group_bus_reservations).toHaveLength(1);
  });

  it("4. messaggio di conflitto è un errore di business chiaro, mai un 500 generico", async () => {
    const { admin } = makeAdmin(baseSeed());
    await reserveBookingGroupBus(admin, actorA, { bookingGroupId: GROUP_1, busUnitId: BUS_A, service_date: DATE_1, reserved_pax: 20, exclusive: true });
    const res2 = await reserveBookingGroupBus(admin, actorA, { bookingGroupId: GROUP_2, busUnitId: BUS_A, service_date: DATE_1, reserved_pax: 15, exclusive: true });
    if (!res2.ok) {
      expect(res2.status).not.toBe(500);
      expect(res2.error).not.toMatch(/duplicate key value/i); // mai il messaggio Postgres grezzo esposto all'utente
    }
  });

  it("5. stesso bus, data diversa → consentito (andata/ritorno indipendenti)", async () => {
    const { admin, tables } = makeAdmin(baseSeed());
    const r1 = await reserveBookingGroupBus(admin, actorA, { bookingGroupId: GROUP_1, busUnitId: BUS_A, service_date: DATE_1, reserved_pax: 20, exclusive: true });
    const r2 = await reserveBookingGroupBus(admin, actorA, { bookingGroupId: GROUP_2, busUnitId: BUS_A, service_date: DATE_2, reserved_pax: 15, exclusive: true });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(tables.booking_group_bus_reservations).toHaveLength(2);
  });

  it("6. stesso bus/data, tenant diverso → consentito (isolamento tenant nell'indice)", async () => {
    const seed = baseSeed({
      booking_groups: [
        { id: GROUP_1, tenant_id: TENANT_A },
        { id: GROUP_2, tenant_id: TENANT_B },
      ],
      tenant_bus_units: [
        { id: BUS_A, tenant_id: TENANT_A },
        { id: BUS_A, tenant_id: TENANT_B }, // stesso id fisico per semplicità del fake: la chiave reale è comunque tenant-scoped
      ],
    });
    const { admin, tables } = makeAdmin(seed);
    const r1 = await reserveBookingGroupBus(admin, actorA, { bookingGroupId: GROUP_1, busUnitId: BUS_A, service_date: DATE_1, reserved_pax: 20, exclusive: true });
    const r2 = await reserveBookingGroupBus(admin, actorB, { bookingGroupId: GROUP_2, busUnitId: BUS_A, service_date: DATE_1, reserved_pax: 15, exclusive: true });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(tables.booking_group_bus_reservations).toHaveLength(2);
  });

  it("7. bus diverso, stessa data → consentito", async () => {
    const { admin, tables } = makeAdmin(baseSeed());
    const r1 = await reserveBookingGroupBus(admin, actorA, { bookingGroupId: GROUP_1, busUnitId: BUS_A, service_date: DATE_1, reserved_pax: 20, exclusive: true });
    const r2 = await reserveBookingGroupBus(admin, actorA, { bookingGroupId: GROUP_2, busUnitId: BUS_B, service_date: DATE_1, reserved_pax: 15, exclusive: true });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(tables.booking_group_bus_reservations).toHaveLength(2);
  });

  it("8. stesso gruppo, retry identico → idempotente (aggiorna la stessa riga, non ne crea una seconda, nessun errore)", async () => {
    const { admin, tables } = makeAdmin(baseSeed());
    const r1 = await reserveBookingGroupBus(admin, actorA, { bookingGroupId: GROUP_1, busUnitId: BUS_A, service_date: DATE_1, reserved_pax: 20, exclusive: true });
    const r2 = await reserveBookingGroupBus(admin, actorA, { bookingGroupId: GROUP_1, busUnitId: BUS_A, service_date: DATE_1, reserved_pax: 25, exclusive: true, notes: "aggiornato" });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(tables.booking_group_bus_reservations).toHaveLength(1);
    if (r2.ok) expect(r2.data.reservation.reserved_pax).toBe(25); // update in place, stessa riga
  });

  it("9. non-exclusive behavior invariato: due gruppi diversi possono avere reservation NON esclusiva sullo stesso bus/data", async () => {
    const { admin, tables } = makeAdmin(baseSeed());
    const r1 = await reserveBookingGroupBus(admin, actorA, { bookingGroupId: GROUP_1, busUnitId: BUS_A, service_date: DATE_1, reserved_pax: 10, exclusive: false });
    const r2 = await reserveBookingGroupBus(admin, actorA, { bookingGroupId: GROUP_2, busUnitId: BUS_A, service_date: DATE_1, reserved_pax: 12, exclusive: false });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(tables.booking_group_bus_reservations).toHaveLength(2); // mai bloccate dal nuovo indice (WHERE exclusive = true)
  });

  it("10. campo direction/leg non esiste su questa tabella: due date diverse per lo stesso gruppo (andata/ritorno) restano indipendenti, nessuna interferenza", async () => {
    const { admin, tables } = makeAdmin(baseSeed());
    const outbound = await reserveBookingGroupBus(admin, actorA, { bookingGroupId: GROUP_1, busUnitId: BUS_A, service_date: DATE_1, reserved_pax: 20, exclusive: true });
    const inbound = await reserveBookingGroupBus(admin, actorA, { bookingGroupId: GROUP_1, busUnitId: BUS_A, service_date: DATE_2, reserved_pax: 20, exclusive: true });
    expect(outbound.ok).toBe(true);
    expect(inbound.ok).toBe(true);
    expect(tables.booking_group_bus_reservations).toHaveLength(2);
  });

  it("11. nessun side effect parziale sul conflict: nessun audit log scritto, riga esistente del vincitore non alterata", async () => {
    const { admin, tables } = makeAdmin(baseSeed());
    await reserveBookingGroupBus(admin, actorA, { bookingGroupId: GROUP_1, busUnitId: BUS_A, service_date: DATE_1, reserved_pax: 20, exclusive: true });
    mocks.auditLog.mockClear();
    const before = { ...tables.booking_group_bus_reservations[0]! };

    const res2 = await reserveBookingGroupBus(admin, actorA, { bookingGroupId: GROUP_2, busUnitId: BUS_A, service_date: DATE_1, reserved_pax: 999, exclusive: true });

    expect(res2.ok).toBe(false);
    expect(mocks.auditLog).not.toHaveBeenCalled(); // nessun audit di un'operazione fallita
    expect(tables.booking_group_bus_reservations).toHaveLength(1); // nessuna riga fantasma
    expect(tables.booking_group_bus_reservations[0]).toEqual(before); // la riga del vincitore non è stata toccata dal tentativo fallito
  });
});
