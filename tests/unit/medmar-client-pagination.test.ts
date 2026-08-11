import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.MEDMAR_API_BASE_URL = "https://medmar.example.test";
process.env.MEDMAR_SESSION_TOKEN = "test-token";

const { fetchCorseReadOnly, MedmarBadResponseError } = await import("@/lib/server/medmar-booking/client");

function laravelPage(rows: unknown[], opts: { currentPage: number; lastPage: number; total?: number }) {
  return {
    data: rows,
    current_page: opts.currentPage,
    last_page: opts.lastPage,
    total: opts.total ?? rows.length,
    per_page: 10,
    from: 1,
    to: rows.length,
    path: "https://medmar.example.test/production/biglietteria_api/public/index.php/api/corse/47",
    next_page_url: opts.currentPage < opts.lastPage
      ? `https://medmar.example.test/production/biglietteria_api/public/index.php/api/corse/47?page=${opts.currentPage + 1}`
      : null,
    prev_page_url: null,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const ROW_A = {
  id_corsa: 131479, id_tratta: 47, partenza_data: "2026-08-12", partenza_ora: "10:35",
  flag_chiuso: 0, flag_sospeso: 0, id_porto_partenza: 41, id_porto_arrivo: 1,
  porto_partenza: "ISCHIA", porto_arrivo: "NAPOLI", nave: "MEDMAR GIULIA",
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("fetchCorseReadOnly — paginazione reale (dati Ischia->Napoli, id_tratta 47)", () => {
  it("corsa target in prima pagina: una sola richiesta", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse(laravelPage([ROW_A], { currentPage: 1, lastPage: 1 })));
    const rows = await fetchCorseReadOnly({ idTratta: 47, partenzaDataDal: "2026-08-12", dopoLe: "00:00:00" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id_corsa).toBe(131479);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("corsa target trovata solo in pagina 2: segue la paginazione", async () => {
    const fetchSpy = vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(jsonResponse(laravelPage([], { currentPage: 1, lastPage: 2 })))
      .mockResolvedValueOnce(jsonResponse(laravelPage([ROW_A], { currentPage: 2, lastPage: 2 })));
    const rows = await fetchCorseReadOnly({ idTratta: 47, partenzaDataDal: "2026-08-12", dopoLe: "00:00:00" });
    expect(rows).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("nessun match su più pagine: tutte le pagine vengono esaminate, array vuoto", async () => {
    const fetchSpy = vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(jsonResponse(laravelPage([], { currentPage: 1, lastPage: 3 })))
      .mockResolvedValueOnce(jsonResponse(laravelPage([], { currentPage: 2, lastPage: 3 })))
      .mockResolvedValueOnce(jsonResponse(laravelPage([], { currentPage: 3, lastPage: 3 })));
    const rows = await fetchCorseReadOnly({ idTratta: 47, partenzaDataDal: "2026-08-12", dopoLe: "00:00:00" });
    expect(rows).toHaveLength(0);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("max pagine superato: fail-closed con MedmarBadResponseError, mai loop infinito", async () => {
    // Il server dichiara sempre pagina 1 di 999: senza un cap lato client
    // questo ciclerebbe all'infinito. Il nostro contatore locale ci ferma
    // comunque a MAX_CORSE_PAGES indipendentemente da cosa dichiara il server.
    const fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async () => jsonResponse(laravelPage([], { currentPage: 1, lastPage: 999 })));
    await expect(fetchCorseReadOnly({ idTratta: 47, partenzaDataDal: "2026-08-12", dopoLe: "00:00:00" })).rejects.toThrow(MedmarBadResponseError);
    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(30);
  });

  it("loop pagination (server ripete sempre current_page=1): bounded dal contatore locale, non dal valore server", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async () => jsonResponse(laravelPage([], { currentPage: 1, lastPage: 5 })));
    await expect(fetchCorseReadOnly({ idTratta: 47, partenzaDataDal: "2026-08-12", dopoLe: "00:00:00" })).rejects.toThrow(MedmarBadResponseError);
    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(30);
  });

  it("paginazione malformata (last_page/current_page/total assenti): trattata come pagina singola, nessun crash", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse({ data: [ROW_A] }));
    const rows = await fetchCorseReadOnly({ idTratta: 47, partenzaDataDal: "2026-08-12", dopoLe: "00:00:00" });
    expect(rows).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("stop deterministico: se tutte le righe di una pagina hanno data successiva a quella richiesta, non continua", async () => {
    const futureRow = { ...ROW_A, partenza_data: "2026-08-13" };
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse(laravelPage([futureRow], { currentPage: 1, lastPage: 5 })));
    const rows = await fetchCorseReadOnly({ idTratta: 47, partenzaDataDal: "2026-08-12", dopoLe: "00:00:00" });
    expect(rows).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("non chiama mai next_page_url direttamente: ogni pagina è ricostruita dal base URL configurato + page", async () => {
    const fetchSpy = vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(jsonResponse(laravelPage([], { currentPage: 1, lastPage: 2 })))
      .mockResolvedValueOnce(jsonResponse(laravelPage([ROW_A], { currentPage: 2, lastPage: 2 })));
    await fetchCorseReadOnly({ idTratta: 47, partenzaDataDal: "2026-08-12", dopoLe: "00:00:00" });
    const urlsCalled = fetchSpy.mock.calls.map((c) => String(c[0]));
    for (const url of urlsCalled) {
      expect(url.startsWith("https://medmar.example.test/production/biglietteria_api/public/index.php/api/corse/47")).toBe(true);
    }
    expect(urlsCalled[1]).toContain("page=2");
  });
});
