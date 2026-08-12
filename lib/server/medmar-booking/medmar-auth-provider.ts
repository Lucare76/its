/**
 * Implementazione reale dell'autenticazione automatica Medmar (Fase 2A).
 *
 * Endpoint verificato manualmente:
 *   POST {MEDMAR_API_BASE_URL}/production/biglietteria_api/public/index.php/api/authenticate
 *   Body: { "email": "...", "password": "..." }
 *   Risposta: { return: true, output: { token: "<JWT>", user: {...} }, extra: { message } }
 *
 * Il prefisso di path qui sotto DUPLICA intenzionalmente MEDMAR_API_PATH_PREFIX
 * di client.ts (non lo importa) per evitare un import circolare: client.ts
 * importa auth.ts, che importa questo file — se questo file importasse a sua
 * volta client.ts si chiuderebbe un ciclo a 3 file. Sono 2 stringhe letterali
 * costanti dello stesso servizio Medmar: se Medmar cambia il prefisso reale,
 * vanno aggiornate entrambe (non ci si aspetta che cambi).
 *
 * REQUISITO DI SICUREZZA (risposta /authenticate contiene dati sensibili):
 * dalla risposta si estrae SOLO output.token. Tutto il resto (in particolare
 * output.user con id/id_cliente/altri dati annidati) NON viene mai assegnato
 * a una variabile, mai loggato, mai passato a auditLog/console, mai
 * persistito. Se in futuro servisse davvero un campo come user.id_cliente,
 * va estratto qui con lo stesso criterio (immediatamente, senza mai tenere
 * un riferimento all'oggetto risposta completo).
 *
 * Precedenza credenziali (nessun fallback silenzioso):
 *   1. MEDMAR_EMAIL + MEDMAR_PASSWORD ENTRAMBI presenti -> login automatico
 *      OBBLIGATORIO. MEDMAR_SESSION_TOKEN, anche se presente, viene ignorato
 *      del tutto — e se il login automatico fallisce, l'errore risale così
 *      com'è: MAI un fallback silenzioso sul token manuale (mascherebbe un
 *      problema di credenziali).
 *   2. Solo UNO tra EMAIL/PASSWORD presente -> configurazione a metà, trattata
 *      come non configurato (mai un fallback sul token manuale neanche qui).
 *   3. Solo MEDMAR_SESSION_TOKEN presente -> percorso di compatibilità
 *      temporaneo. Il token è statico: invalidateToken() + una nuova
 *      getValidToken() rileggono lo stesso valore da env (nessun refresh
 *      possibile), quindi un token manuale scaduto produce sempre e
 *      comunque un fail-closed pulito tramite il retry-once in client.ts.
 *   4. Nessuno dei precedenti -> MedmarNotConfiguredError.
 *
 * Cache: SOLO { token, expiresAt } in memoria di processo (mai email/password
 * in questa cache: restano in process.env). Nessuna persistenza su
 * Supabase/DB. Su Vercel questo è un cache per-istanza, non condivisa tra
 * cold start diversi: riduce concretamente le richieste di login ripetute
 * ENTRO una singola invocazione (fino a ~30 pagine di paginazione corse in
 * un solo preflight) e tra richieste consecutive su un'istanza calda, ma un
 * nuovo cold start rifà sempre login — limite noto e accettato, non un bug.
 *
 * Single-flight: più chiamanti concorrenti che richiedono un token quando la
 * cache non è valida condividono la STESSA promise di login (una sola POST
 * /authenticate), sempre limitatamente al singolo processo/istanza caldo.
 *
 * exp del JWT: letto SOLO localmente (nessuna verifica di firma: non
 * disponiamo di una chiave pubblica/secret Medmar) come hint operativo di
 * scadenza, MAI come prova crittografica — l'unica autorità reale sulla
 * validità del token sono le risposte 401/403 di Medmar. Se exp non è
 * leggibile il token NON viene mai considerato cacheable (mai una durata
 * fissa assunta, es. le ~12h osservate).
 */

const MEDMAR_AUTH_PATH = "/production/biglietteria_api/public/index.php/api/authenticate";
const AUTH_TIMEOUT_MS = 10_000;
const REFRESH_SKEW_MS = 5 * 60 * 1000;

export class MedmarNotConfiguredError extends Error {
  constructor(message = "Autenticazione Medmar non configurata.") {
    super(message);
    this.name = "MedmarNotConfiguredError";
  }
}

/**
 * Credenziali presenti ma il login Medmar è stato rifiutato/non interpretabile
 * (return=false, output/token mancante, risposta malformata, rete/timeout sul
 * login). Diverso da MedmarAuthExpiredError (client.ts): quello è per un
 * token che ERA valido ed è scaduto/revocato durante una chiamata dati.
 */
export class MedmarAuthFailedError extends Error {
  constructor(message = "Autenticazione Medmar rifiutata.") {
    super(message);
    this.name = "MedmarAuthFailedError";
  }
}

export type MedmarSession = {
  bearerToken: string;
  /**
   * Epoch ms. Hint operativo di scadenza (da JWT exp se leggibile), MAI una
   * prova crittografica. 0 se non determinabile: il chiamante deve sempre
   * trattare expiresAt<=Date.now() come "non cacheable / già scaduto".
   */
  expiresAt: number;
};

export interface MedmarAuthProvider {
  /** Forza un nuovo login (o rilettura del token manuale), bypassando la cache ma non il single-flight. */
  authenticate(): Promise<MedmarSession>;
  /** Ritorna una sessione valida, da cache se possibile, altrimenti autentica. */
  getValidToken(): Promise<MedmarSession>;
  /** Invalida la sessione in cache: la prossima getValidToken() autentica di nuovo. */
  invalidateToken(): void;
}

function clean(value: string | undefined): string {
  return (value ?? "").trim();
}

type MedmarAuthMode =
  | { mode: "automatic"; email: string; password: string }
  | { mode: "manual_token"; token: string }
  | { mode: "not_configured" };

/** Letta a ogni chiamata (non a livello di modulo) per restare testabile con vi.resetModules(). */
function resolveMedmarAuthMode(): MedmarAuthMode {
  const email = clean(process.env.MEDMAR_EMAIL);
  const password = clean(process.env.MEDMAR_PASSWORD);
  const sessionToken = clean(process.env.MEDMAR_SESSION_TOKEN);

  if (email && password) {
    return { mode: "automatic", email, password };
  }
  if (email || password) {
    // Configurazione a metà: mai un fallback sul token manuale, sarebbe un
    // mascheramento silenzioso di un errore di configurazione.
    return { mode: "not_configured" };
  }
  if (sessionToken) {
    return { mode: "manual_token", token: sessionToken };
  }
  return { mode: "not_configured" };
}

/**
 * Decodifica SOLO il payload JWT (base64url), senza verificare la firma.
 * Qualunque anomalia (non 3 segmenti, base64/JSON non validi, exp
 * mancante/non numerico) fa ritornare null: il chiamante tratta il token
 * come non cacheable in quel caso.
 */
function readJwtExpMs(token: string): number | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payloadPart = parts[1];
    if (!payloadPart) return null;
    const base64 = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const decoded = Buffer.from(padded, "base64").toString("utf8");
    if (!decoded) return null;
    const payload = JSON.parse(decoded) as Record<string, unknown>;
    const exp = payload.exp;
    if (typeof exp !== "number" || !Number.isFinite(exp)) return null;
    return exp * 1000;
  } catch {
    return null;
  }
}

function sessionFromToken(token: string): MedmarSession {
  const expMs = readJwtExpMs(token);
  const expiresAt = expMs !== null && expMs > Date.now() ? expMs : 0;
  return { bearerToken: token, expiresAt };
}

async function loginWithCredentials(email: string, password: string): Promise<MedmarSession> {
  const baseUrl = clean(process.env.MEDMAR_API_BASE_URL);
  if (!baseUrl) {
    throw new MedmarNotConfiguredError("MEDMAR_API_BASE_URL non configurato: impossibile autenticarsi.");
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${MEDMAR_AUTH_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    });
  } catch (err) {
    // Rete/timeout: mai includere credenziali nel messaggio di errore.
    throw new MedmarAuthFailedError(
      err instanceof Error && err.name === "TimeoutError"
        ? "Timeout durante l'autenticazione Medmar."
        : "Errore di rete durante l'autenticazione Medmar."
    );
  }

  if (!response.ok) {
    throw new MedmarAuthFailedError(`Medmar ha rifiutato l'autenticazione (status ${response.status}).`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new MedmarAuthFailedError("Risposta di autenticazione Medmar non interpretabile (JSON non valido).");
  }

  // Parsing STRETTISSIMO: si legge solo return e output.token. `body` esce
  // di scope subito dopo — nessun riferimento alla risposta completa
  // sopravvive oltre queste righe.
  if (!body || typeof body !== "object") {
    throw new MedmarAuthFailedError("Risposta di autenticazione Medmar in un formato inatteso.");
  }
  const parsed = body as { return?: unknown; output?: { token?: unknown } };
  if (parsed.return !== true) {
    throw new MedmarAuthFailedError("Medmar ha rifiutato le credenziali configurate.");
  }
  const token = parsed.output?.token;
  if (typeof token !== "string" || token.trim().length === 0) {
    throw new MedmarAuthFailedError("Risposta di autenticazione Medmar priva di un token valido.");
  }

  return sessionFromToken(token);
}

class MedmarAuthProviderImpl implements MedmarAuthProvider {
  private cachedSession: MedmarSession | null = null;
  private inFlight: Promise<MedmarSession> | null = null;

  private isCacheValid(): boolean {
    if (!this.cachedSession) return false;
    return Date.now() < this.cachedSession.expiresAt - REFRESH_SKEW_MS;
  }

  async authenticate(): Promise<MedmarSession> {
    // Single-flight: se un login è già in corso, tutti i chiamanti
    // condividono la STESSA promise — mai più di una POST /authenticate
    // simultanea entro lo stesso processo/istanza calda.
    if (this.inFlight) return this.inFlight;

    const attempt = (async (): Promise<MedmarSession> => {
      const mode = resolveMedmarAuthMode();
      if (mode.mode === "automatic") {
        return loginWithCredentials(mode.email, mode.password);
      }
      if (mode.mode === "manual_token") {
        return sessionFromToken(mode.token);
      }
      throw new MedmarNotConfiguredError();
    })();

    this.inFlight = attempt;
    try {
      const session = await attempt;
      this.cachedSession = session;
      return session;
    } finally {
      // Un login fallito o riuscito libera sempre il lock: il prossimo
      // chiamante può ritentare da zero, mai un lock rotto/agganciato.
      this.inFlight = null;
    }
  }

  async getValidToken(): Promise<MedmarSession> {
    if (this.isCacheValid()) {
      return this.cachedSession!;
    }
    return this.authenticate();
  }

  invalidateToken(): void {
    this.cachedSession = null;
  }
}

export function createMedmarAuthProvider(): MedmarAuthProvider {
  return new MedmarAuthProviderImpl();
}
