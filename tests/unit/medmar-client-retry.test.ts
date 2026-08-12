import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.MEDMAR_API_BASE_URL = "https://medmar.example.test";
process.env.MEDMAR_SESSION_TOKEN = "";
process.env.MEDMAR_EMAIL = "";
process.env.MEDMAR_PASSWORD = "";

const { fetchCorseReadOnly, fetchBigliettiVendibiliReadOnly, MedmarAuthExpiredError } = await import("@/lib/server/medmar-booking/client");
const { __setMedmarAuthProviderForTests } = await import("@/lib/server/medmar-booking/auth");

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function corsePage(rows: unknown[]) {
  return { data: rows, current_page: 1, last_page: 1, total: rows.length };
}

const ROW_A = {
  id_corsa: 131479, id_tratta: 47, partenza_data: "2026-08-12", partenza_ora: "10:35",
  flag_chiuso: 0, flag_sospeso: 0, id_porto_partenza: 41, id_porto_arrivo: 1,
  porto_partenza: "ISCHIA", porto_arrivo: "NAPOLI", nave: "MEDMAR GIULIA",
};

/**
 * Mock provider CON cache (come il reale): getValidToken() chiama
 * authenticate() solo se non c'è una sessione valida in cache, altrimenti la
 * riusa — serve a verificare che la paginazione non rifaccia un login per
 * ogni pagina dopo un singolo rinnovo riuscito.
 */
function fakeAuthProvider() {
  let counter = 0;
  let invalidateCalls = 0;
  let cached: { bearerToken: string; expiresAt: number } | null = null;
  const provider = {
    async authenticate() {
      counter += 1;
      const session = { bearerToken: `token-${counter}`, expiresAt: Date.now() + 3600_000 };
      cached = session;
      return session;
    },
    async getValidToken() {
      if (cached && Date.now() < cached.expiresAt) return cached;
      return provider.authenticate();
    },
    invalidateToken() {
      invalidateCalls += 1;
      cached = null;
    },
    get authenticateCalls() {
      return counter;
    },
    get invalidateTokenCalls() {
      return invalidateCalls;
    },
  };
  return provider;
}

beforeEach(() => {
  vi.restoreAllMocks();
  __setMedmarAuthProviderForTests(null);
});

describe("client — retry-once su 401/403 (Fase 2A)", () => {
  it("401 sul primo tentativo -> invalida, richiede un nuovo token, ritenta UNA volta e riesce", async () => {
    const provider = fakeAuthProvider();
    __setMedmarAuthProviderForTests(provider);
    const fetchSpy = vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, 401))
      .mockResolvedValueOnce(jsonResponse(corsePage([ROW_A])));

    const rows = await fetchCorseReadOnly({ idTratta: 47, partenzaDataDal: "2026-08-12", dopoLe: "00:00:00" });

    expect(rows).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(provider.invalidateTokenCalls).toBe(1);
    expect(provider.authenticateCalls).toBe(2);
    // Il retry usa un token DIVERSO (rinnovato), non lo stesso scaduto.
    const authHeader1 = (fetchSpy.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    const authHeader2 = (fetchSpy.mock.calls[1]![1] as RequestInit).headers as Record<string, string>;
    expect(authHeader1.Authorization).not.toBe(authHeader2.Authorization);
  });

  it("403 sul primo tentativo -> stesso comportamento di 401: invalida, ritenta, riesce", async () => {
    const provider = fakeAuthProvider();
    __setMedmarAuthProviderForTests(provider);
    vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(jsonResponse({ error: "forbidden" }, 403))
      .mockResolvedValueOnce(jsonResponse(corsePage([ROW_A])));

    const rows = await fetchCorseReadOnly({ idTratta: 47, partenzaDataDal: "2026-08-12", dopoLe: "00:00:00" });
    expect(rows).toHaveLength(1);
    expect(provider.invalidateTokenCalls).toBe(1);
  });

  it("401 anche al secondo tentativo -> MedmarAuthExpiredError, MASSIMO 1 retry (2 fetch totali, non di più)", async () => {
    const provider = fakeAuthProvider();
    __setMedmarAuthProviderForTests(provider);
    const fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async () => jsonResponse({ error: "unauthorized" }, 401));

    await expect(fetchCorseReadOnly({ idTratta: 47, partenzaDataDal: "2026-08-12", dopoLe: "00:00:00" })).rejects.toThrow(MedmarAuthExpiredError);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(provider.invalidateTokenCalls).toBe(1);
  });

  it("403 anche al secondo tentativo -> MedmarAuthExpiredError, massimo 1 retry", async () => {
    const provider = fakeAuthProvider();
    __setMedmarAuthProviderForTests(provider);
    const fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async () => jsonResponse({ error: "forbidden" }, 403));

    await expect(fetchBigliettiVendibiliReadOnly(131943)).rejects.toThrow(MedmarAuthExpiredError);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("500 (non auth) NON attiva retry/re-auth: fallisce subito con l'errore esistente, nessuna invalidateToken", async () => {
    const provider = fakeAuthProvider();
    __setMedmarAuthProviderForTests(provider);
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse({ error: "server error" }, 500));

    await expect(fetchCorseReadOnly({ idTratta: 47, partenzaDataDal: "2026-08-12", dopoLe: "00:00:00" })).rejects.toThrow();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(provider.invalidateTokenCalls).toBe(0);
  });

  it("sensitivity: assertReadOnlyPath resta l'unico guard — il retry non introduce un secondo percorso fetch che lo bypassi (path identico su entrambi i tentativi)", async () => {
    const provider = fakeAuthProvider();
    __setMedmarAuthProviderForTests(provider);
    const fetchSpy = vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, 401))
      .mockResolvedValueOnce(jsonResponse(corsePage([ROW_A])));

    await fetchCorseReadOnly({ idTratta: 47, partenzaDataDal: "2026-08-12", dopoLe: "00:00:00" });
    const url1 = String(fetchSpy.mock.calls[0]![0]);
    const url2 = String(fetchSpy.mock.calls[1]![0]);
    expect(url1).toBe(url2);
    expect(url1).toContain("/production/biglietteria_api/public/index.php/api/corse/47");
  });

  it("sensitivity: nessun retry avviene su path/endpoint mutativi (il guard blocca comunque prima del fetch)", async () => {
    const { assertReadOnlyPath, MedmarMutationBlockedError } = await import("@/lib/server/medmar-booking/client");
    const fetchSpy = vi.spyOn(global, "fetch");
    expect(() => assertReadOnlyPath("/prenotazioni/lock-disponibilita")).toThrow(MedmarMutationBlockedError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("paginazione: un token scaduto a metà rinnova UNA volta e le pagine successive riusano il token già rinnovato (nessun re-auth ripetuto per pagina)", async () => {
    const provider = fakeAuthProvider();
    __setMedmarAuthProviderForTests(provider);
    const fetchSpy = vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, 401)) // pagina 1, tentativo 1: 401
      .mockResolvedValueOnce(jsonResponse({ data: [], current_page: 1, last_page: 2, total: 0 })) // pagina 1, tentativo 2: ok
      .mockResolvedValueOnce(jsonResponse({ data: [ROW_A], current_page: 2, last_page: 2, total: 1 })); // pagina 2: ok, nessun 401

    const rows = await fetchCorseReadOnly({ idTratta: 47, partenzaDataDal: "2026-08-12", dopoLe: "00:00:00" });
    expect(rows).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    // authenticate() chiamato solo 2 volte in totale (1 iniziale + 1 dopo il 401), non una volta per pagina.
    expect(provider.authenticateCalls).toBe(2);
  });
});
