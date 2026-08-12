import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createMedmarAuthProvider,
  MedmarNotConfiguredError,
  MedmarAuthFailedError,
  type MedmarAuthProvider,
} from "@/lib/server/medmar-booking/medmar-auth-provider";

const ORIGINAL_ENV = { ...process.env };

function clearMedmarEnv() {
  delete process.env.MEDMAR_EMAIL;
  delete process.env.MEDMAR_PASSWORD;
  delete process.env.MEDMAR_SESSION_TOKEN;
  process.env.MEDMAR_API_BASE_URL = "https://medmar.example.test";
}

function base64url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function makeJwt(payload: Record<string, unknown> | null): string {
  const header = base64url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const body = payload === null ? "not-json" : base64url(JSON.stringify(payload));
  return `${header}.${body}.signature`;
}

function authResponse(overrides: Partial<{ ret: unknown; token: unknown; userExtra: Record<string, unknown> }> = {}) {
  return {
    return: overrides.ret ?? true,
    output: { token: overrides.token, user: overrides.userExtra ?? { id: 89, id_cliente: "54175", secret_note: "MUST-NEVER-LEAK" } },
    extra: { message: null },
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let provider: MedmarAuthProvider;

beforeEach(() => {
  clearMedmarEnv();
  provider = createMedmarAuthProvider();
  vi.restoreAllMocks();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.useRealTimers();
});

describe("medmar-auth-provider — precedenza credenziali", () => {
  it("nessuna credenziale -> MedmarNotConfiguredError", async () => {
    await expect(provider.getValidToken()).rejects.toThrow(MedmarNotConfiguredError);
  });

  it("solo MEDMAR_EMAIL (senza password) -> MedmarNotConfiguredError, NON fallback su session token", async () => {
    process.env.MEDMAR_EMAIL = "ops@example.test";
    process.env.MEDMAR_SESSION_TOKEN = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    const fetchSpy = vi.spyOn(global, "fetch");
    await expect(provider.getValidToken()).rejects.toThrow(MedmarNotConfiguredError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("solo MEDMAR_PASSWORD (senza email) -> MedmarNotConfiguredError", async () => {
    process.env.MEDMAR_PASSWORD = "secret";
    await expect(provider.getValidToken()).rejects.toThrow(MedmarNotConfiguredError);
  });

  it("solo MEDMAR_SESSION_TOKEN -> modalità manuale, nessuna chiamata di rete", async () => {
    const token = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    process.env.MEDMAR_SESSION_TOKEN = token;
    const fetchSpy = vi.spyOn(global, "fetch");
    const session = await provider.getValidToken();
    expect(session.bearerToken).toBe(token);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("EMAIL+PASSWORD presenti -> login automatico obbligatorio, MEDMAR_SESSION_TOKEN ignorato del tutto", async () => {
    process.env.MEDMAR_EMAIL = "ops@example.test";
    process.env.MEDMAR_PASSWORD = "secret";
    process.env.MEDMAR_SESSION_TOKEN = "should-be-ignored-token";
    const goodToken = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse(authResponse({ token: goodToken })));
    const session = await provider.getValidToken();
    expect(session.bearerToken).toBe(goodToken);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("sensitivity: EMAIL+PASSWORD presenti ma login automatico fallisce -> MAI un fallback silenzioso su MEDMAR_SESSION_TOKEN", async () => {
    process.env.MEDMAR_EMAIL = "ops@example.test";
    process.env.MEDMAR_PASSWORD = "wrong-password";
    const fallbackToken = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    process.env.MEDMAR_SESSION_TOKEN = fallbackToken;
    const fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async () => jsonResponse(authResponse({ ret: false })));
    await expect(provider.getValidToken()).rejects.toThrow(MedmarAuthFailedError);
    // Un secondo tentativo (senza reset del provider) deve ritentare il login
    // automatico di nuovo, mai leggere silenziosamente il token manuale.
    await expect(provider.getValidToken()).rejects.toThrow(MedmarAuthFailedError);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    for (const call of fetchSpy.mock.calls) {
      expect(String(call[0])).toContain("/authenticate");
    }
  });
});

describe("medmar-auth-provider — authenticate() request/response", () => {
  beforeEach(() => {
    process.env.MEDMAR_EMAIL = "ops@example.test";
    process.env.MEDMAR_PASSWORD = "secret";
  });

  it("POST corretto: URL, metodo, Content-Type, body {email,password}", async () => {
    const goodToken = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse(authResponse({ token: goodToken })));
    await provider.getValidToken();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe("https://medmar.example.test/production/biglietteria_api/public/index.php/api/authenticate");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).headers).toMatchObject({ "Content-Type": "application/json" });
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ email: "ops@example.test", password: "secret" });
  });

  it("return=false -> MedmarAuthFailedError", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse(authResponse({ ret: false })));
    await expect(provider.getValidToken()).rejects.toThrow(MedmarAuthFailedError);
  });

  it("output mancante -> MedmarAuthFailedError", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse({ return: true, extra: { message: null } }));
    await expect(provider.getValidToken()).rejects.toThrow(MedmarAuthFailedError);
  });

  it("token mancante -> MedmarAuthFailedError", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse(authResponse({ token: undefined })));
    await expect(provider.getValidToken()).rejects.toThrow(MedmarAuthFailedError);
  });

  it("token vuoto -> MedmarAuthFailedError", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse(authResponse({ token: "   " })));
    await expect(provider.getValidToken()).rejects.toThrow(MedmarAuthFailedError);
  });

  it("HTTP non-ok dal login -> MedmarAuthFailedError", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse({ error: "bad credentials" }, 401));
    await expect(provider.getValidToken()).rejects.toThrow(MedmarAuthFailedError);
  });

  it("JSON non valido nella risposta di login -> MedmarAuthFailedError", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(new Response("not json", { status: 200 }));
    await expect(provider.getValidToken()).rejects.toThrow(MedmarAuthFailedError);
  });

  it("errore di rete/timeout sul login -> MedmarAuthFailedError, mai una stack trace/credenziali nel messaggio", async () => {
    vi.spyOn(global, "fetch").mockRejectedValueOnce(new Error("ECONNRESET"));
    try {
      await provider.getValidToken();
      throw new Error("doveva lanciare");
    } catch (err) {
      expect(err).toBeInstanceOf(MedmarAuthFailedError);
      expect((err as Error).message).not.toMatch(/secret|ops@example\.test|ECONNRESET/i);
    }
  });

  it("MEDMAR_API_BASE_URL non configurato -> MedmarNotConfiguredError anche con credenziali corrette", async () => {
    delete process.env.MEDMAR_API_BASE_URL;
    const fetchSpy = vi.spyOn(global, "fetch");
    await expect(provider.getValidToken()).rejects.toThrow(MedmarNotConfiguredError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("medmar-auth-provider — exp del JWT (hint di cache, non prova crittografica)", () => {
  beforeEach(() => {
    process.env.MEDMAR_EMAIL = "ops@example.test";
    process.env.MEDMAR_PASSWORD = "secret";
  });

  it("exp futuro -> sessione cacheable, riusata senza una seconda chiamata", async () => {
    const token = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse(authResponse({ token })));
    const s1 = await provider.getValidToken();
    const s2 = await provider.getValidToken();
    expect(s1.bearerToken).toBe(token);
    expect(s2.bearerToken).toBe(token);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("exp passato -> trattato come già scaduto, nuova authenticate() alla chiamata successiva", async () => {
    const pastToken = makeJwt({ exp: Math.floor(Date.now() / 1000) - 3600 });
    const freshToken = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    const fetchSpy = vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(jsonResponse(authResponse({ token: pastToken })))
      .mockResolvedValueOnce(jsonResponse(authResponse({ token: freshToken })));
    await provider.getValidToken();
    await provider.getValidToken();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("exp mancante -> non cacheable, ogni getValidToken() rifà authenticate()", async () => {
    const noExpToken = makeJwt({ sub: "no-exp-claim" });
    const fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async () => jsonResponse(authResponse({ token: noExpToken })));
    await provider.getValidToken();
    await provider.getValidToken();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("JWT malformato (non 3 segmenti) -> non cacheable, mai un crash", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async () => jsonResponse(authResponse({ token: "not-a-jwt" })));
    const session = await provider.getValidToken();
    expect(session.bearerToken).toBe("not-a-jwt");
    await provider.getValidToken();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("exp appena dentro il refresh skew (5 min) -> trattato come scaduto, rinnovato", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);
    const nearExpiryToken = makeJwt({ exp: Math.floor((now + 4 * 60 * 1000) / 1000) }); // 4 min < skew 5 min
    const freshToken = makeJwt({ exp: Math.floor((now + 3600 * 1000) / 1000) });
    const fetchSpy = vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(jsonResponse(authResponse({ token: nearExpiryToken })))
      .mockResolvedValueOnce(jsonResponse(authResponse({ token: freshToken })));
    await provider.getValidToken();
    const s2 = await provider.getValidToken();
    expect(s2.bearerToken).toBe(freshToken);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("exp ben oltre il refresh skew -> resta in cache, nessun rinnovo", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);
    const safeToken = makeJwt({ exp: Math.floor((now + 3600 * 1000) / 1000) }); // 1h, ben oltre i 5 min di skew
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse(authResponse({ token: safeToken })));
    await provider.getValidToken();
    await provider.getValidToken();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("medmar-auth-provider — invalidateToken()", () => {
  beforeEach(() => {
    process.env.MEDMAR_EMAIL = "ops@example.test";
    process.env.MEDMAR_PASSWORD = "secret";
  });

  it("invalida la cache: la successiva getValidToken() autentica di nuovo", async () => {
    const token1 = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    const token2 = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    const fetchSpy = vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(jsonResponse(authResponse({ token: token1 })))
      .mockResolvedValueOnce(jsonResponse(authResponse({ token: token2 })));
    const s1 = await provider.getValidToken();
    provider.invalidateToken();
    const s2 = await provider.getValidToken();
    expect(s1.bearerToken).toBe(token1);
    expect(s2.bearerToken).toBe(token2);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("un authenticate() fallito non resta in cache: il tentativo successivo riparte pulito", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse(authResponse({ ret: false })));
    await expect(provider.getValidToken()).rejects.toThrow(MedmarAuthFailedError);

    const token = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    vi.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse(authResponse({ token })));
    const session = await provider.getValidToken();
    expect(session.bearerToken).toBe(token);
  });
});

describe("medmar-auth-provider — concorrenza (single-flight)", () => {
  beforeEach(() => {
    process.env.MEDMAR_EMAIL = "ops@example.test";
    process.env.MEDMAR_PASSWORD = "secret";
  });

  it("5 richieste simultanee senza cache valida -> UNA sola authenticate(), stessa sessione per tutti", async () => {
    const token = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    let resolveFetch!: (r: Response) => void;
    const pending = new Promise<Response>((resolve) => { resolveFetch = resolve; });
    const fetchSpy = vi.spyOn(global, "fetch").mockReturnValueOnce(pending as unknown as Promise<Response>);

    const calls = [provider.getValidToken(), provider.getValidToken(), provider.getValidToken(), provider.getValidToken(), provider.getValidToken()];
    // Nessuna delle 5 deve aver innescato una seconda fetch nel frattempo.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    resolveFetch(jsonResponse(authResponse({ token })));

    const sessions = await Promise.all(calls);
    for (const s of sessions) {
      expect(s.bearerToken).toBe(token);
    }
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("chiamate concorrenti con cache già valida -> zero nuove chiamate di rete", async () => {
    const token = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse(authResponse({ token })));
    await provider.getValidToken();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const sessions = await Promise.all([provider.getValidToken(), provider.getValidToken(), provider.getValidToken()]);
    for (const s of sessions) expect(s.bearerToken).toBe(token);
    // Nessuna nuova chiamata oltre a quella iniziale che ha popolato la cache.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("authenticate() fallisce durante il single-flight -> tutti i chiamanti in attesa falliscono, il lock viene ripulito e una richiesta successiva può ritentare", async () => {
    let rejectFetch!: (err: unknown) => void;
    const pending = new Promise<Response>((_, reject) => { rejectFetch = reject; });
    vi.spyOn(global, "fetch").mockReturnValueOnce(pending as unknown as Promise<Response>);

    const calls = [provider.getValidToken(), provider.getValidToken(), provider.getValidToken()];
    rejectFetch(new Error("network down"));

    const results = await Promise.allSettled(calls);
    for (const r of results) {
      expect(r.status).toBe("rejected");
      if (r.status === "rejected") expect(r.reason).toBeInstanceOf(MedmarAuthFailedError);
    }

    // Il lock è stato ripulito: la richiesta successiva riparte da zero e può riuscire.
    const token = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    vi.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse(authResponse({ token })));
    const session = await provider.getValidToken();
    expect(session.bearerToken).toBe(token);
  });
});

describe("medmar-auth-provider — sicurezza / sensitivity", () => {
  beforeEach(() => {
    process.env.MEDMAR_EMAIL = "ops@example.test";
    process.env.MEDMAR_PASSWORD = "secret";
  });

  it("la sessione restituita contiene SOLO bearerToken+expiresAt, mai i dati utente/cliente annidati", async () => {
    const token = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    vi.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse(authResponse({ token, userExtra: { id: 1, id_cliente: "999", pii: "should-not-appear" } })));
    const session = await provider.getValidToken();
    expect(Object.keys(session).sort()).toEqual(["bearerToken", "expiresAt"]);
    expect(JSON.stringify(session)).not.toMatch(/id_cliente|pii|should-not-appear/);
  });

  it("nessun messaggio di errore contiene la password configurata", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse(authResponse({ ret: false })));
    try {
      await provider.getValidToken();
    } catch (err) {
      expect((err as Error).message).not.toContain("secret");
    }
  });
});
