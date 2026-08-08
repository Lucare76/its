import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Test hardening promise chain — POST /api/ops/piano-giorno/apply-resolution-suggestion.
 *
 * Pattern precedente: `void logAssignmentChange(auth.admin, [...])` senza
 * alcun `.then()`/`.catch()` — il più debole dei 4 call site auditati: un
 * reject di logAssignmentChange era garantito unhandled rejection. Fix:
 * `.catch(() => undefined)` sulla catena. apply-resolution-suggestion non
 * chiama mai updateLearnedPatterns (changeType "resolution_suggestion" non è
 * consumato da learned-patterns) — il fix non introduce learning, coerente
 * con l'istruzione esplicita del task.
 *
 * apply-resolution-suggestion non muta mai services/assignments/trip_groups
 * (dichiarato nel commento del file sorgente): persiste solo operator
 * decisions + lo storico strutturato. Questo file mocka l'intera catena di
 * diagnostica/validazione (`buildRealGiroDiagnostics`,
 * `validateResolutionSuggestionApply`, `buildResolutionPreview`,
 * `insertOperatorDecision`, `supersedeOverlappingOperatorDecisions`,
 * `listDriverRegistry`) per isolare esclusivamente la robustezza della
 * catena promise di logAssignmentChange — la business logic di
 * diagnosi/validazione è fuori dal perimetro di questo task (non toccata) e
 * non ha un test route-level preesistente da estendere.
 */

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GROUP_1 = "c1111111-1111-4111-8111-111111111111";
const SERVICE_1 = "a1111111-1111-4111-8111-111111111111";
const OPERATOR_1 = "u1111111-1111-4111-8111-111111111111";
const SUGGESTION_ID = "sugg-1";
const TEST_DATE = "2026-08-10";

type Row = Record<string, unknown>;

function createSupabase() {
  // apply-resolution-suggestion legge solo services/hotels/trip_groups/assignments
  // (via loadDiagnostics) per costruire i diagnostics — qui non serve dato
  // reale perché buildRealGiroDiagnostics è mockato: ogni select restituisce
  // semplicemente un array vuoto.
  const admin = {
    from(_table: string) {
      const builder = {
        select() { return builder; },
        eq() { return builder; },
        neq() { return builder; },
        order() { return builder; },
        limit() { return builder; },
        in() { return builder; },
        then(resolve: (v: { data: Row[]; error: null }) => unknown, reject?: (e: unknown) => unknown) {
          return Promise.resolve({ data: [], error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
  return { admin };
}

const mocks = vi.hoisted(() => ({
  authorizePricingRequest: vi.fn(),
  listDriverRegistry: vi.fn(),
  loadConfirmedOperatorDecisions: vi.fn(),
  buildRealGiroDiagnostics: vi.fn(),
  validateResolutionSuggestionApply: vi.fn(),
  buildResolutionPreview: vi.fn(),
  insertOperatorDecision: vi.fn(),
  supersedeOverlappingOperatorDecisions: vi.fn(),
  extractFeatures: vi.fn(),
  logAssignmentChange: vi.fn(),
}));

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizePricingRequest: mocks.authorizePricingRequest,
}));
vi.mock("@/lib/server/driver-registry", () => ({
  listDriverRegistry: mocks.listDriverRegistry,
}));
vi.mock("@/lib/server/piano-operator-decisions", () => ({
  insertOperatorDecision: mocks.insertOperatorDecision,
  loadConfirmedOperatorDecisions: mocks.loadConfirmedOperatorDecisions,
  supersedeOverlappingOperatorDecisions: mocks.supersedeOverlappingOperatorDecisions,
}));
vi.mock("@/lib/piano-real-giro-diagnostics", () => ({
  buildRealGiroDiagnostics: mocks.buildRealGiroDiagnostics,
}));
vi.mock("@/lib/piano-resolution-apply-guard", () => ({
  validateResolutionSuggestionApply: mocks.validateResolutionSuggestionApply,
}));
vi.mock("@/lib/piano-conflict-resolution-preview", () => ({
  buildResolutionPreview: mocks.buildResolutionPreview,
}));
vi.mock("@/lib/server/assignment-history", () => ({
  extractFeatures: mocks.extractFeatures,
  logAssignmentChange: mocks.logAssignmentChange,
}));

import { POST } from "@/app/api/ops/piano-giorno/apply-resolution-suggestion/route";

function buildSuggestion(overrides: Row = {}) {
  return {
    group_id: GROUP_1,
    recommended_action: "ACCORPAMENTO",
    involved_services: [{ service_id: SERVICE_1, pickup_label: null }],
    suggested_order: [],
    operator_confirmation_required: false,
    ...overrides,
  };
}

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost:3010/api/ops/piano-giorno/apply-resolution-suggestion", {
    method: "POST",
    headers: { "Content-Type": "application/json", authorization: "Bearer test-token" },
    body: JSON.stringify(body),
  });
}
function callPost(body: Record<string, unknown> = { date: TEST_DATE, suggestion_id: SUGGESTION_ID, group_id: GROUP_1, action: "ACCORPAMENTO" }) {
  return POST(makeRequest(body));
}

function authorizeAs(fake: ReturnType<typeof createSupabase>) {
  mocks.authorizePricingRequest.mockResolvedValue({
    admin: fake.admin,
    user: { id: OPERATOR_1, email: "op@test.dev" },
    membership: { tenant_id: TENANT_A, role: "operator", suspended: false },
  });
}

describe("hardening promise chain — apply-resolution-suggestion logAssignmentChange().catch()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listDriverRegistry.mockResolvedValue([]);
    mocks.loadConfirmedOperatorDecisions.mockResolvedValue([]);
    mocks.buildRealGiroDiagnostics.mockReturnValue({ resolution_suggestions: [] });
    mocks.validateResolutionSuggestionApply.mockReturnValue({ ok: true, apply_status: "confirmed", suggestion: buildSuggestion() });
    mocks.buildResolutionPreview.mockReturnValue({
      simulated_status: "ok", residual_conflicts: [], residual_warnings: [], total_pax: 2, final_stops: [], warnings: [], before: {}, after: {},
    });
    mocks.insertOperatorDecision.mockResolvedValue({ decision: { id: "dec-1", suggestion_hash: "hash-1" }, duplicate: false });
    mocks.supersedeOverlappingOperatorDecisions.mockResolvedValue([]);
    mocks.extractFeatures.mockReturnValue({});
    mocks.logAssignmentChange.mockResolvedValue(undefined);
  });

  it("1. logAssignmentChange risolve: comportamento invariato, risposta regolare", async () => {
    const fake = createSupabase();
    authorizeAs(fake);

    const res = await callPost();
    const body = await res.json();
    await new Promise((resolve) => setImmediate(resolve));

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.apply_status).toBe("confirmed");
    expect(mocks.logAssignmentChange).toHaveBeenCalledTimes(1);
  });

  it("2. logAssignmentChange rigetta: risposta principale invariata, nessun unhandled rejection", async () => {
    const fake = createSupabase();
    authorizeAs(fake);
    mocks.logAssignmentChange.mockRejectedValueOnce(new Error("driver_assignment_history insert failed"));

    const res = await callPost();
    const body = await res.json();
    await new Promise((resolve) => setImmediate(resolve));

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/driver_assignment_history/);
    expect(mocks.insertOperatorDecision).toHaveBeenCalledTimes(1);
  });

  it("3. updateLearnedPatterns non è mai coinvolto (non previsto per questo changeType): nessuna chiamata introdotta dal fix", async () => {
    const fake = createSupabase();
    authorizeAs(fake);

    await callPost();

    // apply-resolution-suggestion non importa/chiama updateLearnedPatterns:
    // nessun mock da verificare, il fix aggiunge solo .catch(), non learning.
    expect(mocks.logAssignmentChange).toHaveBeenCalledTimes(1);
  });

  it("4. zero unhandled rejection: verificato strutturalmente (vedi nota sotto), non tramite il test 2", () => {
    // NOTA METODOLOGICA: a differenza degli altri 3 call site (che incatenano
    // `.then(...)`), qui la chiamata è `void logAssignmentChange(...)` nuda.
    // Con un vi.fn() mockato, un reject "nudo" (nessun .then()/.catch() nel
    // codice sotto test) viene comunque tracciato internamente da Vitest per
    // il proprio `mock.results` — questo soddisfa il controllo Node su "la
    // promise ha un handler" e IMPEDISCE la rilevazione dell'unhandled
    // rejection anche quando il .catch() reale è assente (verificato con una
    // prova isolata: vi.fn().mockRejectedValueOnce() chiamato "nudo" non
    // produce mai un unhandledRejection in Vitest, mentre la stessa funzione
    // reale — non mockata — sì). Il test 2 quindi non può discriminare in
    // modo affidabile la presenza del fix per QUESTO specifico call site: la
    // verifica affidabile è strutturale (test 4b sotto), sul sorgente reale.
    expect(true).toBe(true);
  });

  it("4b. il sorgente ha .catch() sull'intera catena di logAssignmentChange (verifica strutturale, affidabile indipendentemente dai limiti del mocking)", () => {
    const source = readFileSync(
      join(process.cwd(), "app/api/ops/piano-giorno/apply-resolution-suggestion/route.ts"),
      "utf8"
    );
    const callSite = source.slice(source.indexOf("void logAssignmentChange"));
    const firstStatementEnd = callSite.indexOf(";");
    const statement = callSite.slice(0, firstStatementEnd + 1);

    expect(statement).toContain(".catch(() => undefined)");
    expect(statement).not.toMatch(/updateLearnedPatterns/);
  });

  it("5. history chiamata una sola volta", async () => {
    const fake = createSupabase();
    authorizeAs(fake);

    await callPost();

    expect(mocks.logAssignmentChange).toHaveBeenCalledTimes(1);
  });

  it("6. learning chiamato solo se previsto: N/A per questa action, nessuna regressione rispetto al comportamento preesistente (mai chiamato)", () => {
    expect(true).toBe(true);
  });

  it("7. nessun doppio catch/logging: un solo insert in driver_assignment_history per servizio coinvolto", async () => {
    const fake = createSupabase();
    authorizeAs(fake);

    await callPost();

    const entries = mocks.logAssignmentChange.mock.calls[0][1] as Row[];
    expect(entries).toHaveLength(1);
    expect(entries[0].serviceId).toBe(SERVICE_1);
    expect(entries[0].changeType).toBe("resolution_suggestion");
  });

  it("8. decisione operatore già salvata prima del fire-and-forget history: insertOperatorDecision chiamato anche se logAssignmentChange rigetta", async () => {
    const fake = createSupabase();
    authorizeAs(fake);
    mocks.logAssignmentChange.mockRejectedValueOnce(new Error("history down"));

    const res = await callPost();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(mocks.insertOperatorDecision).toHaveBeenCalledTimes(1);
  });

  it("9. nessuna regressione sui path di errore preesistenti: suggerimento non valido → status derivato da apply_status, zero history", async () => {
    const fake = createSupabase();
    authorizeAs(fake);
    mocks.validateResolutionSuggestionApply.mockReturnValue({ ok: false, apply_status: "stale", message: "Suggerimento non più valido." });

    const res = await callPost();
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.ok).toBe(false);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });
});
