import { describe, it, expect } from "vitest";
import {
  buildDuplicateProbe,
  duplicateProbeFromNormalized,
  findPotentialExistingMatches,
  lookupBookingDuplicates,
  type NormalizedPdfImport,
} from "@/lib/server/agency-pdf-import";

/**
 * Copre il deduplicatore condiviso riusato da inbox-approve e claude-save-draft.
 * Nessun DB reale: fake builder Supabase in-memory.
 */

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type Row = Record<string, unknown>;

/**
 * Fake admin: `services` supporta la sequenza
 *   .select(...).eq(...).ilike(...).order(...).limit(...).maybeSingle()   (match certo)
 *   .select(...).eq(...).ilike|eq(...).order(...).limit(5)  → await         (match soft)
 *   .select(...).eq(...).in(...)  → await                                   (hydrate)
 */
function makeAdmin(cfg: {
  byPattern?: Row | null; // findServiceByPattern
  byPractice?: Row[];
  byPhone?: Row[];
  byName?: Row[];
  hydrate?: Row[];
}) {
  const servicesBuilder = () => {
    const st = { ilikeCol: null as string | null, eqCol: null as string | null, usedIn: false };
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = (col: string) => { if (col !== "tenant_id") st.eqCol = col; return b; };
    b.ilike = (col: string) => { st.ilikeCol = col; return b; };
    b.in = () => { st.usedIn = true; return b; };
    b.order = () => b;
    b.limit = () => b;
    b.maybeSingle = async () => ({ data: cfg.byPattern ?? null, error: null });
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      let rows: Row[] = [];
      if (st.usedIn) rows = cfg.hydrate ?? [];
      else if (st.ilikeCol === "notes") rows = cfg.byPractice ?? [];
      else if (st.eqCol === "phone") rows = cfg.byPhone ?? [];
      else if (st.ilikeCol === "customer_name") rows = cfg.byName ?? [];
      return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
    };
    return b;
  };
  return {
    from: () => servicesBuilder(),
  } as never;
}

describe("buildDuplicateProbe — chiave composite condivisa", () => {
  it("produce la stessa slug 'nome|data|hotel' usata nei marker [pdf_composite:...]", () => {
    const probe = buildDuplicateProbe({
      customerName: "MARIOTTI SERENA",
      arrivalDate: "2026-09-06",
      hotelName: "ISOLA VERDE HOTEL & THERMAL SPA",
      practiceNumber: "26/011405",
      phone: "3289126048",
    });
    expect(probe.composite_key).toBe("mariotti-serena-2026-09-06-isola-verde-hotel-thermal-spa");
    expect(probe.practice_number).toBe("26/011405");
    expect(probe.customer_phone).toBe("3289126048");
    expect(probe.pdf_hash).toBeNull();
    expect(probe.text_hash).toBeNull();
  });

  it("composite_key null se manca nome o data (nessun falso match)", () => {
    expect(buildDuplicateProbe({ customerName: "", arrivalDate: "2026-09-06" }).composite_key).toBeNull();
    expect(buildDuplicateProbe({ customerName: "X", arrivalDate: "" }).composite_key).toBeNull();
  });

  it("duplicateProbeFromNormalized estrae i campi dal NormalizedPdfImport", () => {
    const n = {
      customer_full_name: "MARIO ROSSI",
      customer_phone: "3331112222",
      pdf_hash: "aaaa",
      text_hash: "bbbb",
      dedupe_key: "cccc",
      dedupe_components: { practice_number: "26/1", composite_key: "mario-rossi-2026-01-02-hotel" },
    } as unknown as NormalizedPdfImport;
    const p = duplicateProbeFromNormalized(n);
    expect(p).toMatchObject({
      practice_number: "26/1",
      customer_full_name: "MARIO ROSSI",
      customer_phone: "3331112222",
      pdf_hash: "aaaa",
      text_hash: "bbbb",
      dedupe_key: "cccc",
      composite_key: "mario-rossi-2026-01-02-hotel",
    });
  });
});

describe("lookupBookingDuplicates — MARIOTTI", () => {
  it("intercetta il record esistente via [pdf_composite] anche con pratica diversa", async () => {
    const existing = {
      id: "svc-A",
      is_draft: false,
      status: "new",
      inbound_email_id: null,
      notes: "[pdf_composite:mariotti-serena-2026-09-06-isola-verde-hotel-thermal-spa]",
    };
    const admin = makeAdmin({
      byPattern: existing,
      byPhone: [{ id: "svc-A", status: "new", is_draft: false, customer_name: "MARIOTTI SERENA", phone: "3289126048", date: "2026-09-06" }],
    });
    const probe = buildDuplicateProbe({
      customerName: "MARIOTTI SERENA",
      arrivalDate: "2026-09-06",
      hotelName: "ISOLA VERDE HOTEL & THERMAL SPA",
      practiceNumber: "26/011405",
      phone: "3289126048",
    });
    const { certain_service_id, matches } = await lookupBookingDuplicates(admin, TENANT, probe);
    expect(certain_service_id).toBe("svc-A");
    expect(matches.map((m) => m.service_id)).toContain("svc-A");
  });
});

describe("findPotentialExistingMatches — comitive (non è un duplicato certo)", () => {
  it("stesso telefono + persone diverse → match 'phone', nessun match certo", async () => {
    const admin = makeAdmin({
      byPattern: null,
      byPhone: [{ id: "svc-comitiva", status: "new", is_draft: false, customer_name: "LEVI STEFANIA", phone: "3382157166", date: "2026-07-12" }],
    });
    const probe = buildDuplicateProbe({
      customerName: "LEVI ALLEGRA",
      arrivalDate: "2026-07-12",
      hotelName: "HOTEL X",
      phone: "3382157166",
    });
    const soft = await findPotentialExistingMatches(admin, TENANT, probe);
    expect(soft).toHaveLength(1);
    expect(soft[0]!.match_reason).toBe("phone");

    const { certain_service_id, matches } = await lookupBookingDuplicates(admin, TENANT, probe);
    expect(certain_service_id).toBeNull();
    expect(matches).toHaveLength(1);
  });
});
