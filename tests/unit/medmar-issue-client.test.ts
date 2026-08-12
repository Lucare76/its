import { beforeEach, describe, expect, it, vi } from "vitest";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("medmar mutation client", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    process.env.MEDMAR_API_BASE_URL = "https://medmar.example.test";
    process.env.MEDMAR_EMAIL = "";
    process.env.MEDMAR_PASSWORD = "";
    process.env.MEDMAR_SESSION_TOKEN = "";
    delete process.env.MEDMAR_ISSUING_ENABLED;
  });

  it("feature flag false -> zero mutative fetch", async () => {
    const fetchSpy = vi.spyOn(global, "fetch");
    const { createMedmarMutationClient, MedmarIssuingDisabledError } = await import("@/lib/server/medmar-booking/medmar-mutation-client");
    await expect(createMedmarMutationClient().lockAvailability({ biglietti: [], utente: 91001 })).rejects.toThrow(MedmarIssuingDisabledError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("usa path reali hardcoded per lock, prenotazione, manuale e scongela", async () => {
    process.env.MEDMAR_ISSUING_ENABLED = "true";
    const { __setMedmarAuthProviderForTests } = await import("@/lib/server/medmar-booking/auth");
    __setMedmarAuthProviderForTests({
      authenticate: vi.fn(),
      getValidToken: vi.fn().mockResolvedValue({ bearerToken: "test-token", expiresAt: Date.now() + 60_000, userId: null, clienteId: null, postazioneId: null }),
      invalidateToken: vi.fn(),
    });
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(jsonResponse({ return: true, output: { nonDisponibili: [], congelati: [] } }));
    const { createMedmarMutationClient, MEDMAR_MUTATION_PATHS } = await import("@/lib/server/medmar-booking/medmar-mutation-client");
    const client = createMedmarMutationClient();
    fetchSpy.mockResolvedValueOnce(jsonResponse({ return: true, output: { id_turno: 91001 } }));
    await client.openTurn({ id_utente: 89, id_postazione: "77", flag_stato: "A", data: "2026-08-12", ora_apertura: "09:15:30", ora_chiusura: "23:59:59" });

    fetchSpy.mockResolvedValueOnce(jsonResponse({ return: true, output: { nonDisponibili: [], congelati: [] } }));
    await client.lockAvailability({ biglietti: [{ id_corsa: 1, quantita: 2, id_log: 3, descrizione: "PASSAGGIO PONTE ADULTO - TARIFFA SPECIALE AR" }], utente: 91001 });

    fetchSpy.mockResolvedValueOnce(jsonResponse({ return: true, output: { id_prenotazione: 732162, prezzo_totale: "23.00", id_cliente: "cliente-from-auth" } }));
    await client.createBooking({
      cliente_sito: { nome: "Mario", cognome: "Rossi", telefono_1: "123", email: "mario@example.test" },
      dettaglio: [],
      dettaglioMezzo: [],
      id_causale: 1,
      id_cliente: "cliente-from-auth",
      id_modalita: 5,
      id_prenotazione: null,
      id_turno: 91001,
      id_vettore_andata: 1,
      id_vettore_ritorno: 1,
      targa: { dettagli: [] },
      urlPagamento: null,
    });

    fetchSpy.mockResolvedValueOnce(jsonResponse({ return: true, output: { id_prenotazione: "732162", prezzo: "23.00", id_cliente: "cliente-from-auth", id_modalita: "5", numero: "AG1" } }));
    await client.payManual({ id_prenotazione: 732162, prezzo: 23, id_cliente: "cliente-from-auth", id_modalita: 5 });

    fetchSpy.mockResolvedValueOnce(jsonResponse({ return: true, output: [] }));
    await client.unlockAvailability({ biglietti: [], utente: 91001 });

    const urls = fetchSpy.mock.calls.map(([url]) => String(url));
    expect(urls[0]).toContain(MEDMAR_MUTATION_PATHS.turn);
    expect(urls[1]).toContain(MEDMAR_MUTATION_PATHS.lock);
    expect(urls[2]).toContain(MEDMAR_MUTATION_PATHS.booking);
    expect(urls[3]).toContain(MEDMAR_MUTATION_PATHS.manualPayment);
    expect(urls[4]).toContain(MEDMAR_MUTATION_PATHS.unlock);
    expect(JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body))).toEqual({
      id_utente: 89,
      id_postazione: "77",
      flag_stato: "A",
      data: "2026-08-12",
      ora_apertura: "09:15:30",
      ora_chiusura: "23:59:59",
    });
  });

  it("POST prenotazioni timeout/5xx non viene retryato e diventa remote_state_unknown", async () => {
    process.env.MEDMAR_ISSUING_ENABLED = "true";
    const { __setMedmarAuthProviderForTests } = await import("@/lib/server/medmar-booking/auth");
    __setMedmarAuthProviderForTests({
      authenticate: vi.fn(),
      getValidToken: vi.fn().mockResolvedValue({ bearerToken: "test-token", expiresAt: Date.now() + 60_000, userId: null, clienteId: null, postazioneId: null }),
      invalidateToken: vi.fn(),
    });
    const fetchSpy = vi.spyOn(global, "fetch").mockRejectedValue(new Error("socket hang up"));
    const { createMedmarMutationClient, MedmarMutationRemoteUnknownError } = await import("@/lib/server/medmar-booking/medmar-mutation-client");
    await expect(createMedmarMutationClient().createBooking({
      cliente_sito: { nome: "Mario", cognome: "Rossi", telefono_1: "123", email: "mario@example.test" },
      dettaglio: [],
      dettaglioMezzo: [],
      id_causale: 1,
      id_cliente: "cliente-from-auth",
      id_modalita: 5,
      id_prenotazione: null,
      id_turno: 91001,
      id_vettore_andata: 1,
      id_vettore_ritorno: 1,
      targa: { dettagli: [] },
      urlPagamento: null,
    })).rejects.toThrow(MedmarMutationRemoteUnknownError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("POST turni timeout non viene retryato e diventa remote_state_unknown", async () => {
    process.env.MEDMAR_ISSUING_ENABLED = "true";
    const { __setMedmarAuthProviderForTests } = await import("@/lib/server/medmar-booking/auth");
    __setMedmarAuthProviderForTests({
      authenticate: vi.fn(),
      getValidToken: vi.fn().mockResolvedValue({ bearerToken: "test-token", expiresAt: Date.now() + 60_000, userId: 89, clienteId: "cliente-from-auth", postazioneId: "77" }),
      invalidateToken: vi.fn(),
    });
    const fetchSpy = vi.spyOn(global, "fetch").mockRejectedValue(new Error("socket hang up"));
    const { createMedmarMutationClient, MedmarMutationRemoteUnknownError } = await import("@/lib/server/medmar-booking/medmar-mutation-client");
    await expect(createMedmarMutationClient().openTurn({
      id_utente: 89,
      id_postazione: "77",
      flag_stato: "A",
      data: "2026-08-12",
      ora_apertura: "09:15:30",
      ora_chiusura: "23:59:59",
    })).rejects.toThrow(MedmarMutationRemoteUnknownError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
