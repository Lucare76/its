/**
 * FASE A / FASE A.1 — contesto conversazionale breve per Mario Assistant.
 *
 * FASE A usava una `Map` in-process: su Vercel/serverless due turni successivi
 * possono essere serviti da istanze diverse, quindi il contesto ("stiamo
 * ancora parlando dello stesso booking_group") andava perso. FASE A.1 sposta
 * lo storage primario su Redis Upstash CONDIVISO (lo stesso provider e le
 * stesse env già usate da `lib/server/rate-limit.ts`, via
 * `lib/server/redis.ts` — nessun secondo client).
 *
 * Chiave:  mario:session:<tenant_id>:<user_id>   (mai email/nome).
 * TTL sessione:            600s (10 min) — TTL nativo della key Redis.
 * TTL pendingConfirmation: 180s (= CONFIRMATION_TTL_SECONDS) — scarto LOGICO
 *   sulla lettura: la key può vivere 10 min, ma una conferma più vecchia di
 *   180s viene ignorata anche se ancora presente. NON tocchiamo il TTL HMAC.
 *
 * Il confirmationToken vive SOLO qui lato server. Non compare MAI:
 *  - nel contesto passato all'LLM (il router riceve `MarioSessionSummary`, che
 *    non ha il campo token — vedi `toMarioSessionSummary`);
 *  - nei log (vedi telemetry.ts);
 *  - nella risposta all'utente.
 *
 * Fail-safe (§5): se lo store condiviso è configurato ma una singola
 * operazione Redis fallisce a runtime, o se in produzione con
 * MARIO_LLM_ENABLED=true lo store condiviso non è configurato affatto, il
 * modulo NON ricade su memoria di processo: restituisce un contesto VUOTO e
 * segnala `store = "unavailable"`. Conseguenza voluta: le richieste one-shot
 * proseguono (contesto vuoto = sessione nuova), i follow-up che dipendono dal
 * contesto ottengono naturalmente una richiesta di chiarimento dal router
 * (nessun dato inventato, nessun dato di un'altra sessione).
 *
 * Il fallback in-memory resta SOLO per dev/test (Upstash non configurato e non
 * in produzione-con-LLM): mai fonte primaria in produzione.
 */
import { CONFIRMATION_TTL_SECONDS } from "@/lib/mcp/confirmation";
import { getSharedRedis, isSharedRedisConfigured } from "@/lib/server/redis";

export type MarioPendingConfirmation = {
  /** Tool WRITE da eseguire alla conferma (es. "its.create_booking_group"). */
  toolName: string;
  confirmationToken: string;
  /** Etichetta operativa breve (es. nome del tool preview), mai il token. */
  op: string;
  createdAt: number;
};

/**
 * FASE A.3 — operazione in costruzione (slot filling multi-turno). Tiene
 * l'INTENTO operativo e i soli campi funzionali già forniti dall'utente per
 * eseguire l'azione — mai testo libero, mai prompt, mai risposta LLM, mai
 * PII oltre a quanto l'utente ha esplicitamente chiesto (§2/§16).
 * `origin` NON è un campo di its.preview_create_booking_group: si conserva
 * solo per un eventuale passo successivo (add stop), mai infilato negli
 * arguments del tool di creazione (§6).
 */
export type MarioDraftSlots = {
  name?: string;
  expectedPax?: number;
  serviceDate?: string; // "YYYY-MM-DD"
  origin?: string;
  kind?: string;
};

export type MarioDraftOperation = {
  type: "create_booking_group";
  collected: MarioDraftSlots;
  missing: string[];
  updatedAt: number;
};

export type MarioSessionContext = {
  lastBookingGroupId?: string;
  lastBookingGroupName?: string;
  lastBookingGroupStopId?: string;
  lastStopCity?: string;
  lastDate?: string;
  lastIntent?: string;
  pendingConfirmation?: MarioPendingConfirmation;
  draftOperation?: MarioDraftOperation;
  updatedAt: number;
};

/** FASE A.3 — vista draft per l'LLM: nessun `updatedAt`. */
export type MarioDraftSummary = {
  type: string;
  collected: MarioDraftSlots;
  missing: string[];
};

/** Vista MINIMA sicura del contesto per il router LLM (§10): nessun token,
 *  `pendingConfirmation` ridotto alla sola etichetta operativa. */
export type MarioSessionSummary = {
  lastBookingGroupId?: string;
  lastBookingGroupName?: string;
  lastBookingGroupStopId?: string;
  lastStopCity?: string;
  lastDate?: string;
  lastIntent?: string;
  /** Solo l'`op` della conferma in sospeso, MAI il token. */
  pendingConfirmationOp?: string;
  /** FASE A.3 — operazione in costruzione (senza `updatedAt`). */
  draftOperation?: MarioDraftSummary;
};

export type MarioSessionStoreKind = "shared" | "memory_fallback" | "unavailable";

const SESSION_TTL_SECONDS = 10 * 60;
const SESSION_TTL_MS = SESSION_TTL_SECONDS * 1000;
const PENDING_TTL_MS = CONFIRMATION_TTL_SECONDS * 1000;
// FASE A.3 §2 — un draft più vecchio della sessione è logicamente morto anche
// se la key Redis vive ancora (allineato al TTL sessione, 10 min).
const DRAFT_TTL_MS = SESSION_TTL_MS;
const KEY_PREFIX = "mario:session:";

function sessionKey(tenantId: string, userId: string): string {
  return `${KEY_PREFIX}${tenantId}:${userId}`;
}

// ── Fallback in-memory (SOLO dev/test) ──────────────────────────────────────
const memory = new Map<string, MarioSessionContext>();

// Ultimo backend effettivamente usato — letto subito dopo dalla telemetria
// (§17). Non è stato condiviso: è solo un'etichetta diagnostica per-processo.
let lastStore: MarioSessionStoreKind = "memory_fallback";

/** Backend che *dovrebbe* servire la prossima operazione (prima di eventuali
 *  errori runtime di Redis, che declassano la singola op a "unavailable"). */
function resolveBackendKind(): MarioSessionStoreKind {
  if (isSharedRedisConfigured()) return "shared";
  const prodWithLlm = process.env.NODE_ENV === "production" && process.env.MARIO_LLM_ENABLED === "true";
  return prodWithLlm ? "unavailable" : "memory_fallback";
}

/** L'ultimo backend usato da get/update/clear in questo processo. Per la
 *  telemetria (§17). */
export function getLastMarioSessionStore(): MarioSessionStoreKind {
  return lastStore;
}

function emptyContext(now: number): MarioSessionContext {
  return { updatedAt: now };
}

/** Rimuove `pendingConfirmation` oltre il TTL HMAC (180s) e `draftOperation`
 *  oltre il TTL sessione (10 min). Ritorna il contesto ripulito e se è
 *  cambiato qualcosa. */
function stripExpiredPending(ctx: MarioSessionContext, now: number): { ctx: MarioSessionContext; changed: boolean } {
  let next = ctx;
  let changed = false;
  if (next.pendingConfirmation && now - next.pendingConfirmation.createdAt > PENDING_TTL_MS) {
    const { pendingConfirmation: _expired, ...rest } = next;
    next = rest;
    changed = true;
  }
  if (next.draftOperation && now - next.draftOperation.updatedAt > DRAFT_TTL_MS) {
    const { draftOperation: _stale, ...rest } = next;
    next = rest;
    changed = true;
  }
  return { ctx: next, changed };
}

// ── Lettura ─────────────────────────────────────────────────────────────────

/** Legge (e normalizza) il contesto corrente. Mai null: una sessione vuota è
 *  un oggetto senza campi opzionali valorizzati. */
export async function getMarioSession(tenantId: string, userId: string): Promise<MarioSessionContext> {
  const now = Date.now();
  const backend = resolveBackendKind();

  if (backend === "unavailable") {
    lastStore = "unavailable";
    return emptyContext(now);
  }

  if (backend === "memory_fallback") {
    lastStore = "memory_fallback";
    return readMemory(tenantId, userId, now);
  }

  // backend === "shared"
  const redis = getSharedRedis();
  if (!redis) {
    lastStore = "unavailable";
    return emptyContext(now);
  }
  try {
    const raw = await redis.get<MarioSessionContext>(sessionKey(tenantId, userId));
    lastStore = "shared";
    if (!raw || typeof raw.updatedAt !== "number") return emptyContext(now);
    const { ctx, changed } = stripExpiredPending(raw, now);
    if (changed) {
      // Best-effort: persiste la versione ripulita SENZA rinnovare il TTL
      // sessione. Se fallisce, la prossima lettura ripulirà di nuovo.
      try {
        await redis.set(sessionKey(tenantId, userId), ctx, { keepTtl: true });
      } catch {
        /* ignorato: non compromette la correttezza della lettura */
      }
    }
    return ctx;
  } catch {
    // §5 — fail-safe: mai inventare contesto, mai ricadere su memoria in prod.
    lastStore = "unavailable";
    return emptyContext(now);
  }
}

export type PendingConfirmationRead =
  | { status: "none" }
  | { status: "valid"; pending: MarioPendingConfirmation }
  | { status: "expired" };

/** Legge lo stato della conferma in sospeso SENZA normalizzare, così
 *  l'orchestrator può distinguere "mai vista" da "scaduta" (§13) e dare il
 *  messaggio giusto a un "confermo" arrivato oltre i 180s — senza mai eseguire
 *  il WRITE. Se lo store è indisponibile → "none" (fail-safe: nessuna
 *  conferma eseguibile). */
export async function readPendingConfirmation(tenantId: string, userId: string): Promise<PendingConfirmationRead> {
  const now = Date.now();
  const raw = await readRawContext(tenantId, userId);
  const p = raw?.pendingConfirmation;
  if (!p) return { status: "none" };
  if (now - p.createdAt > PENDING_TTL_MS) return { status: "expired" };
  return { status: "valid", pending: p };
}

/** Lettura grezza (nessuno strip): usata solo da readPendingConfirmation. */
async function readRawContext(tenantId: string, userId: string): Promise<MarioSessionContext | null> {
  const backend = resolveBackendKind();
  if (backend === "unavailable") {
    lastStore = "unavailable";
    return null;
  }
  if (backend === "memory_fallback") {
    lastStore = "memory_fallback";
    const e = memory.get(sessionKey(tenantId, userId));
    if (!e || Date.now() - e.updatedAt > SESSION_TTL_MS) return null;
    return e;
  }
  const redis = getSharedRedis();
  if (!redis) {
    lastStore = "unavailable";
    return null;
  }
  try {
    const raw = await redis.get<MarioSessionContext>(sessionKey(tenantId, userId));
    lastStore = "shared";
    return raw && typeof raw.updatedAt === "number" ? raw : null;
  } catch {
    lastStore = "unavailable";
    return null;
  }
}

function readMemory(tenantId: string, userId: string, now: number): MarioSessionContext {
  const key = sessionKey(tenantId, userId);
  const existing = memory.get(key);
  if (!existing || now - existing.updatedAt > SESSION_TTL_MS) {
    const fresh = emptyContext(now);
    memory.set(key, fresh);
    return fresh;
  }
  const { ctx, changed } = stripExpiredPending(existing, now);
  if (changed) memory.set(key, ctx);
  return ctx;
}

// ── Scrittura (read-modify-write, merge per campo) ──────────────────────────

/** Applica una patch parziale al contesto, aggiornando `updatedAt`. Merge per
 *  campo su una lettura fresca (§7): non sovrascrive alla cieca l'intero
 *  oggetto, così una scrittura concorrente su un altro campo non viene persa
 *  di norma. */
export async function updateMarioSession(
  tenantId: string,
  userId: string,
  patch: Partial<Omit<MarioSessionContext, "updatedAt">>,
): Promise<MarioSessionContext> {
  const now = Date.now();
  const backend = resolveBackendKind();

  if (backend === "unavailable") {
    lastStore = "unavailable";
    // Non persistito: il chiamante riceve comunque un oggetto coerente ma
    // NON condiviso (fail-safe — nessun crash).
    return { ...patch, updatedAt: now };
  }

  if (backend === "memory_fallback") {
    lastStore = "memory_fallback";
    const current = readMemory(tenantId, userId, now);
    const next: MarioSessionContext = { ...current, ...patch, updatedAt: now };
    memory.set(sessionKey(tenantId, userId), next);
    return next;
  }

  const redis = getSharedRedis();
  if (!redis) {
    lastStore = "unavailable";
    return { ...patch, updatedAt: now };
  }
  try {
    const raw = await redis.get<MarioSessionContext>(sessionKey(tenantId, userId));
    const base = raw && typeof raw.updatedAt === "number" ? stripExpiredPending(raw, now).ctx : emptyContext(now);
    const next: MarioSessionContext = { ...base, ...patch, updatedAt: now };
    await redis.set(sessionKey(tenantId, userId), next, { ex: SESSION_TTL_SECONDS });
    lastStore = "shared";
    return next;
  } catch {
    lastStore = "unavailable";
    return { ...patch, updatedAt: now };
  }
}

/** Rimuove SOLO la conferma in sospeso (annullamento esplicito o conferma
 *  consumata), lasciando intatto il resto del contesto breve. */
export async function clearPendingConfirmation(tenantId: string, userId: string): Promise<void> {
  const now = Date.now();
  const backend = resolveBackendKind();

  if (backend === "unavailable") {
    lastStore = "unavailable";
    return;
  }

  if (backend === "memory_fallback") {
    lastStore = "memory_fallback";
    const current = memory.get(sessionKey(tenantId, userId));
    if (!current?.pendingConfirmation) return;
    const { pendingConfirmation: _drop, ...rest } = current;
    memory.set(sessionKey(tenantId, userId), { ...rest, updatedAt: now });
    return;
  }

  const redis = getSharedRedis();
  if (!redis) {
    lastStore = "unavailable";
    return;
  }
  try {
    const raw = await redis.get<MarioSessionContext>(sessionKey(tenantId, userId));
    lastStore = "shared";
    if (!raw?.pendingConfirmation) return;
    const { pendingConfirmation: _drop, ...rest } = raw;
    await redis.set(sessionKey(tenantId, userId), { ...rest, updatedAt: now }, { keepTtl: true });
  } catch {
    lastStore = "unavailable";
  }
}

// ── FASE A.3 — draft operativo (slot filling) ──────────────────────────────

/** Legge il draft in costruzione, o null se assente/scaduto (>10 min). */
export async function readMarioDraftOperation(tenantId: string, userId: string): Promise<MarioDraftOperation | null> {
  const now = Date.now();
  const raw = await readRawContext(tenantId, userId);
  const d = raw?.draftOperation;
  if (!d || typeof d.updatedAt !== "number") return null;
  if (now - d.updatedAt > DRAFT_TTL_MS) return null;
  return d;
}

/** Salva/aggiorna il draft (merge per campo con il resto del contesto). Il
 *  chiamante (orchestrator) ha già fatto il merge degli slot. */
export async function setMarioDraftOperation(
  tenantId: string,
  userId: string,
  draft: Omit<MarioDraftOperation, "updatedAt">,
): Promise<void> {
  await updateMarioSession(tenantId, userId, { draftOperation: { ...draft, updatedAt: Date.now() } });
}

/** Rimuove SOLO il draft (reset esplicito / operazione completata), lasciando
 *  intatto il resto del contesto. */
export async function clearMarioDraftOperation(tenantId: string, userId: string): Promise<void> {
  const now = Date.now();
  const backend = resolveBackendKind();
  if (backend === "unavailable") {
    lastStore = "unavailable";
    return;
  }
  if (backend === "memory_fallback") {
    lastStore = "memory_fallback";
    const current = memory.get(sessionKey(tenantId, userId));
    if (!current?.draftOperation) return;
    const { draftOperation: _drop, ...rest } = current;
    memory.set(sessionKey(tenantId, userId), { ...rest, updatedAt: now });
    return;
  }
  const redis = getSharedRedis();
  if (!redis) {
    lastStore = "unavailable";
    return;
  }
  try {
    const raw = await redis.get<MarioSessionContext>(sessionKey(tenantId, userId));
    lastStore = "shared";
    if (!raw?.draftOperation) return;
    const { draftOperation: _drop, ...rest } = raw;
    await redis.set(sessionKey(tenantId, userId), { ...rest, updatedAt: now }, { keepTtl: true });
  } catch {
    lastStore = "unavailable";
  }
}

/** Cancella l'INTERO contesto della sessione (tenant+utente). Non usato nel
 *  flusso normale (il contesto scade da solo); utile per un reset esplicito. */
export async function clearMarioSession(tenantId: string, userId: string): Promise<void> {
  const backend = resolveBackendKind();
  if (backend === "memory_fallback") {
    lastStore = "memory_fallback";
    memory.delete(sessionKey(tenantId, userId));
    return;
  }
  if (backend === "unavailable") {
    lastStore = "unavailable";
    return;
  }
  const redis = getSharedRedis();
  if (!redis) {
    lastStore = "unavailable";
    return;
  }
  try {
    await redis.del(sessionKey(tenantId, userId));
    lastStore = "shared";
  } catch {
    lastStore = "unavailable";
  }
}

// ── Vista sicura per l'LLM (§10) ────────────────────────────────────────────

export function toMarioSessionSummary(ctx: MarioSessionContext): MarioSessionSummary {
  return {
    lastBookingGroupId: ctx.lastBookingGroupId,
    lastBookingGroupName: ctx.lastBookingGroupName,
    lastBookingGroupStopId: ctx.lastBookingGroupStopId,
    lastStopCity: ctx.lastStopCity,
    lastDate: ctx.lastDate,
    lastIntent: ctx.lastIntent,
    pendingConfirmationOp: ctx.pendingConfirmation?.op,
    draftOperation: ctx.draftOperation
      ? { type: ctx.draftOperation.type, collected: ctx.draftOperation.collected, missing: ctx.draftOperation.missing }
      : undefined,
  };
}

/** Solo per i test: azzera il fallback in-memory e l'etichetta diagnostica.
 *  Non tocca Redis (nei test si inietta un fake via __setSharedRedisForTests). */
export function __resetMarioSessionsForTests(): void {
  memory.clear();
  lastStore = "memory_fallback";
}
