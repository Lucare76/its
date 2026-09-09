import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

// Date dinamiche relative a "oggi" reale (todayIsoDate() nella route non è
// mockato): evita che i range hardcoded finiscano nel passato col passare
// del tempo, facendo sparire le righe generate da buildRows.
function isoDate(offsetDays: number) {
  return new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// Come isoDate(), ma per i due test "cambio mese"/"cambio anno": servono una
// coppia di giorni CONSECUTIVI e futuri che attraversino un confine di
// mese/anno. Un range hardcoded (es. "2026-08-31" -> "2026-09-01") e' un
// timestamp che, passato quel mese, diventa passato rispetto a "oggi" reale —
// enumerateShuttleDates/buildRows clippano l'intervallo a partire da "oggi"
// (comportamento corretto: mai rigenerare corse nel passato), quindi
// l'intervallo risulterebbe vuoto e insert=0 anziche' 1. Si cerca quindi
// dinamicamente, a partire da un margine di sicurezza, la prossima coppia di
// giorni consecutivi che attraversa il confine cercato.
function nextBoundaryPair(crosses: (a: Date, b: Date) => boolean, startOffsetDays: number, maxDays: number) {
  let day = new Date(Date.now() + startOffsetDays * 24 * 60 * 60 * 1000);
  for (let i = 0; i < maxDays; i++) {
    const next = new Date(day.getTime() + 24 * 60 * 60 * 1000);
    if (crosses(day, next)) {
      return { from: day.toISOString().slice(0, 10), to: next.toISOString().slice(0, 10) };
    }
    day = next;
  }
  throw new Error(`nextBoundaryPair: nessun confine trovato entro ${maxDays} giorni`);
}

function nextMonthBoundaryPair(startOffsetDays = 1) {
  // Ogni mese ha al massimo 31 giorni: 40 giorni di margine bastano sempre.
  return nextBoundaryPair((a, b) => a.getUTCMonth() !== b.getUTCMonth(), startOffsetDays, 40);
}

function nextYearBoundaryPair(startOffsetDays = 1) {
  // Un anno ha al massimo 366 giorni: 400 giorni di margine bastano sempre.
  return nextBoundaryPair((a, b) => a.getUTCFullYear() !== b.getUTCFullYear(), startOffsetDays, 400);
}

// Fake Supabase admin client that only tracks whether delete()/insert() on
// "services" were invoked — enough to prove no write happens on invalid input.
function createFakeSupabase() {
  const calls = { delete: 0, insert: 0 };

  function makeDeleteBuilder() {
    const builder = {
      eq() {
        return builder;
      },
      gte() {
        return builder;
      },
      is() {
        return builder;
      },
      then(resolve: (v: { error: null }) => unknown, reject?: (e: unknown) => unknown) {
        return Promise.resolve({ error: null }).then(resolve, reject);
      }
    };
    return builder;
  }

  // Select builder used by the F-01 operational guard (hasOperationalFutureServices)
  // added to the PATCH/DELETE route. Always resolves to an empty result set, i.e.
  // "no operational future services found", so the guard never blocks these
  // pre-existing tests and their original assertions stay unchanged.
  function makeEmptySelectBuilder() {
    const builder = {
      eq() {
        return builder;
      },
      gte() {
        return builder;
      },
      is() {
        return builder;
      },
      in() {
        return builder;
      },
      limit() {
        return builder;
      },
      then(resolve: (v: { data: unknown[]; error: null }) => unknown, reject?: (e: unknown) => unknown) {
        return Promise.resolve({ data: [], error: null }).then(resolve, reject);
      }
    };
    return builder;
  }

  const admin = {
    from(_table: string) {
      return {
        select(_cols: string) {
          return makeEmptySelectBuilder();
        },
        delete() {
          calls.delete++;
          return makeDeleteBuilder();
        },
        insert(_rows: unknown) {
          calls.insert++;
          return Promise.resolve({ error: null });
        }
      };
    }
  };

  return { admin, calls };
}

const mocks = vi.hoisted(() => ({
  authorizeServiceRoleRequest: vi.fn()
}));

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizeServiceRoleRequest: mocks.authorizeServiceRoleRequest
}));

import { PATCH } from "@/app/api/shuttle-schedules/[id]/route";
import { buildShuttleScheduleId } from "@/lib/shuttle-schedules";

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost:3010/api/shuttle-schedules/x", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", authorization: "Bearer test-token" },
    body: JSON.stringify(body)
  });
}

function callPatch(id: string, body: Record<string, unknown>) {
  return PATCH(makeRequest(body), { params: Promise.resolve({ id }) });
}

const VALID_SCHEDULE_ID = buildShuttleScheduleId({
  hotel_id: null,
  booking_service_kind: "navetta",
  customer_name: "Hotel Test",
  direction: "departure",
  departure_time: "09:30",
  meeting_point: null,
  vessel: "Navetta"
});

const VALID_PAYLOAD = {
  hotel_id: null,
  booking_service_kind: "navetta",
  customer_name: "Hotel Test",
  direction: "departure",
  departure_time: "09:30",
  meeting_point: null,
  vessel: "Navetta",
  valid_from: "2026-08-01",
  valid_to: "2026-08-05",
  days_of_week: [1, 2, 3, 4, 5],
  notes: null
};

describe("PATCH /api/shuttle-schedules/[id] — intervallo valid_from/valid_to (M1.1.3)", () => {
  let fake: ReturnType<typeof createFakeSupabase>;

  beforeEach(() => {
    vi.clearAllMocks();
    fake = createFakeSupabase();
    mocks.authorizeServiceRoleRequest.mockResolvedValue({
      admin: fake.admin,
      user: { id: "user-a", email: "op@tenant-a.test" },
      membership: { tenant_id: TENANT_A, role: "operator", suspended: false }
    });
  });

  it("valid_from < valid_to (intervallo normale) → 200, delete=1, insert=1", async () => {
    // Date dinamiche (domani/dopodomani): days_of_week è null per non
    // dipendere dal giorno della settimana specifico.
    const res = await callPatch(VALID_SCHEDULE_ID, {
      ...VALID_PAYLOAD,
      valid_from: isoDate(1),
      valid_to: isoDate(2),
      days_of_week: null
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(fake.calls.delete).toBe(1);
    expect(fake.calls.insert).toBe(1);
  });

  it("valid_from === valid_to (stesso giorno) → 200, delete=1, insert=1 (il controllo è < e non <=)", async () => {
    // Data dinamica (domani): days_of_week è null per includere comunque il
    // giorno unico dell'intervallo, indipendentemente dal giorno settimanale.
    const res = await callPatch(VALID_SCHEDULE_ID, {
      ...VALID_PAYLOAD,
      valid_from: isoDate(1),
      valid_to: isoDate(1),
      days_of_week: null
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(fake.calls.delete).toBe(1);
    expect(fake.calls.insert).toBe(1);
  });

  it("valid_to < valid_from (intervallo invertito) → 400, nessuna scrittura Supabase", async () => {
    const res = await callPatch(VALID_SCHEDULE_ID, {
      ...VALID_PAYLOAD,
      valid_from: "2026-08-02",
      valid_to: "2026-08-01"
    });

    expect(res.status).toBe(400);
    expect(fake.calls.delete).toBe(0);
    expect(fake.calls.insert).toBe(0);
  });

  it("valid_to < valid_from su cambio mese (2026-09-01 → 2026-08-31) → 400, nessuna scrittura Supabase", async () => {
    const res = await callPatch(VALID_SCHEDULE_ID, {
      ...VALID_PAYLOAD,
      valid_from: "2026-09-01",
      valid_to: "2026-08-31"
    });

    expect(res.status).toBe(400);
    expect(fake.calls.delete).toBe(0);
    expect(fake.calls.insert).toBe(0);
  });

  it("valid_to < valid_from su cambio anno (2027-01-01 → 2026-12-31) → 400, nessuna scrittura Supabase", async () => {
    const res = await callPatch(VALID_SCHEDULE_ID, {
      ...VALID_PAYLOAD,
      valid_from: "2027-01-01",
      valid_to: "2026-12-31"
    });

    expect(res.status).toBe(400);
    expect(fake.calls.delete).toBe(0);
    expect(fake.calls.insert).toBe(0);
  });

  it("valid_from < valid_to su cambio mese → 200, delete=1, insert=1", async () => {
    // Coppia dinamica futura che attraversa un cambio mese (mai hardcoded:
    // vedi commento su nextBoundaryPair). days_of_week è null per non
    // dipendere dal giorno della settimana specifico.
    const { from, to } = nextMonthBoundaryPair();
    const res = await callPatch(VALID_SCHEDULE_ID, {
      ...VALID_PAYLOAD,
      valid_from: from,
      valid_to: to,
      days_of_week: null
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(fake.calls.delete).toBe(1);
    expect(fake.calls.insert).toBe(1);
  });

  it("valid_from < valid_to su cambio anno → 200, delete=1, insert=1", async () => {
    // Coppia dinamica futura che attraversa un cambio anno (mai hardcoded:
    // vedi commento su nextBoundaryPair). days_of_week è null per non
    // dipendere dal giorno della settimana specifico.
    const { from, to } = nextYearBoundaryPair();
    const res = await callPatch(VALID_SCHEDULE_ID, {
      ...VALID_PAYLOAD,
      valid_from: from,
      valid_to: to,
      days_of_week: null
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(fake.calls.delete).toBe(1);
    expect(fake.calls.insert).toBe(1);
  });
});
