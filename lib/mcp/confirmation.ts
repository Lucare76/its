/**
 * Confirmation token per il flusso preview → conferma utente → execute dei
 * tool MCP WRITE (Sprint 2: its.preview_assign_driver → its.assign_driver).
 *
 * Scelta: token opaco firmato HMAC-SHA256, stesso schema di
 * lib/server/agency-action-token.ts (già in produzione per i link email di
 * azione agenzia) — payload base64url + firma, verificato server-side.
 * Nessun secret nuovo: riusa AGENCY_ACTION_SECRET, già configurato.
 *
 * Micro-hardening: NESSUN fallback a CRON_SECRET (a differenza di
 * agency-action-token.ts). I confirmation token MCP autorizzano una
 * scrittura WRITE diretta (assegnazione autista); CRON_SECRET protegge
 * endpoint cron con una superficie di minaccia diversa — condividere la
 * chiave tra i due domini avrebbe permesso a chi conosce CRON_SECRET di
 * forgiare confirmation token MCP. Se AGENCY_ACTION_SECRET manca o è vuoto,
 * si fallisce chiuso (MCP_INTERNAL_ERROR): nessun token viene mai generato
 * o accettato senza quella chiave specifica. Un campo "purpose" fisso nel
 * payload impedisce inoltre che un token generato per un altro scopo (es.
 * cancellazione agenzia via email, che usa lo stesso secret) possa essere
 * riusato qui, e viceversa.
 *
 * Il token da solo NON basta a rendere sicura l'esecuzione: assign_driver
 * rivalida SEMPRE lo stato live (tramite lo stesso lib/server/
 * assign-service-core.ts usato dalla route HTTP) prima di scrivere — il
 * token dimostra solo "un utente autorizzato ha visto ed approvato
 * esattamente questo payload, di recente".
 *
 * Single-use: registro in-memory dei jti consumati, per-processo. Sufficiente
 * per un server MCP locale a sessione singola (Sprint 2): se il processo
 * riavvia tra preview ed execute, il registro si azzera — accettabile dato
 * il TTL breve (§ CONFIRMATION_TTL_SECONDS) e perché assign_driver rivalida
 * comunque lo stato live indipendentemente dal token. Vedi rischi residui
 * nel report Sprint 2 per l'estensione futura (storage condiviso/Redis) se
 * il server MCP dovesse diventare multi-processo.
 */
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { McpError } from "@/lib/mcp/errors";

export const CONFIRMATION_TTL_SECONDS = 180; // 3 minuti: abbastanza per una revisione umana, breve per limitare drift di stato

export type AssignDriverConfirmationPayload = {
  purpose: "mcp_assign_driver";
  jti: string;
  userId: string;
  tenantId: string;
  serviceId: string;
  driverId: string;
  vehicleId: string | null;
  iat: number;
  exp: number;
};

function getSecret(): string {
  // Solo AGENCY_ACTION_SECRET — nessun fallback a CRON_SECRET (vedi commento
  // di modulo). Stringa vuota trattata come assente (fail-closed). Il valore
  // non viene mai loggato né incluso in errori/messaggi.
  const secret = process.env.AGENCY_ACTION_SECRET;
  if (!secret) throw new McpError("MCP_INTERNAL_ERROR", "Configurazione server mancante per la firma dei confirmation token.");
  return secret;
}

function base64url(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf) : buf;
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function fromBase64url(s: string): string {
  return s.replace(/-/g, "+").replace(/_/g, "/");
}

export function generateAssignDriverConfirmationToken(payload: {
  userId: string;
  tenantId: string;
  serviceId: string;
  driverId: string;
  vehicleId: string | null;
}): { token: string; expiresAt: string } {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + CONFIRMATION_TTL_SECONDS;
  const full: AssignDriverConfirmationPayload = {
    purpose: "mcp_assign_driver",
    jti: base64url(randomBytes(18)),
    userId: payload.userId,
    tenantId: payload.tenantId,
    serviceId: payload.serviceId,
    driverId: payload.driverId,
    vehicleId: payload.vehicleId,
    iat,
    exp,
  };
  const encodedPayload = base64url(JSON.stringify(full));
  const sig = base64url(createHmac("sha256", getSecret()).update(encodedPayload).digest());
  return { token: `${encodedPayload}.${sig}`, expiresAt: new Date(exp * 1000).toISOString() };
}

export type VerifyConfirmationResult =
  | { ok: true; payload: AssignDriverConfirmationPayload }
  | { ok: false; reason: "invalid" | "expired" };

export function verifyAssignDriverConfirmationToken(token: string): VerifyConfirmationResult {
  try {
    const dot = token.lastIndexOf(".");
    if (dot < 0) return { ok: false, reason: "invalid" };
    const encodedPayload = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expectedSig = base64url(createHmac("sha256", getSecret()).update(encodedPayload).digest());

    const a = Buffer.from(fromBase64url(sig), "base64");
    const b = Buffer.from(fromBase64url(expectedSig), "base64");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "invalid" };

    const payload = JSON.parse(Buffer.from(fromBase64url(encodedPayload), "base64").toString()) as AssignDriverConfirmationPayload;
    if (payload.purpose !== "mcp_assign_driver") return { ok: false, reason: "invalid" };
    if (
      typeof payload.jti !== "string" ||
      typeof payload.userId !== "string" ||
      typeof payload.tenantId !== "string" ||
      typeof payload.serviceId !== "string" ||
      typeof payload.driverId !== "string"
    ) {
      return { ok: false, reason: "invalid" };
    }
    // Boundary conservativo: al secondo esatto di scadenza il token e' gia'
    // considerato scaduto (exp e' "valido fino a", non "valido fino a e incluso").
    if (payload.exp <= Math.floor(Date.now() / 1000)) return { ok: false, reason: "expired" };
    return { ok: true, payload };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

// Registro single-use in-memory, per-processo (vedi commento di modulo).
const consumedTokenIds = new Set<string>();

/**
 * Marca atomicamente un jti come consumato. Ritorna true se questa è la
 * prima volta (esecuzione consentita), false se era già stato consumato
 * (replay/doppia esecuzione concorrente). L'operazione è sincrona: due
 * chiamate concorrenti su Node (single-threaded, nessun await nel mezzo) non
 * possono entrambe vedere "prima volta" per lo stesso jti — chiude la race
 * "due execute simultanei" a livello MCP, indipendentemente dal race
 * protection già presente nel core di assegnazione (vincolo unique 23505).
 */
export function claimConfirmationToken(jti: string): boolean {
  if (consumedTokenIds.has(jti)) return false;
  consumedTokenIds.add(jti);
  return true;
}

/** Solo per i test. */
export function __resetConfirmationRegistryForTests() {
  consumedTokenIds.clear();
}

/**
 * MCP Sprint 3: its.preview_update_service_status -> its.update_service_status.
 * Stessa infrastruttura di sopra (nessun secondo sistema): stesso
 * AGENCY_ACTION_SECRET, stesso TTL, stesso registro single-use condiviso
 * (claimConfirmationToken sopra), stesso schema token opaco HMAC-SHA256. Solo
 * il payload e il "purpose" cambiano, per legare il token esattamente a
 * questa azione (un token emesso per assign_driver non deve mai validare qui
 * e viceversa — il campo "purpose" nel payload lo garantisce).
 *
 * currentStatus e' incluso nel payload come snapshot: its.update_service_status
 * lo confronta con lo stato live al momento dell'esecuzione (FASE 14) e lo
 * passa a updateServiceStatusCore come expectedCurrentStatus per l'update
 * condizionale atomico (FASE 19) — il token da solo non autorizza mai una
 * scrittura contro uno stato diverso da quello effettivamente visto in preview.
 */
export type UpdateServiceStatusConfirmationPayload = {
  purpose: "mcp_update_service_status";
  jti: string;
  userId: string;
  tenantId: string;
  serviceId: string;
  currentStatus: string;
  targetStatus: string;
  iat: number;
  exp: number;
};

export function generateUpdateServiceStatusConfirmationToken(payload: {
  userId: string;
  tenantId: string;
  serviceId: string;
  currentStatus: string;
  targetStatus: string;
}): { token: string; expiresAt: string } {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + CONFIRMATION_TTL_SECONDS;
  const full: UpdateServiceStatusConfirmationPayload = {
    purpose: "mcp_update_service_status",
    jti: base64url(randomBytes(18)),
    userId: payload.userId,
    tenantId: payload.tenantId,
    serviceId: payload.serviceId,
    currentStatus: payload.currentStatus,
    targetStatus: payload.targetStatus,
    iat,
    exp,
  };
  const encodedPayload = base64url(JSON.stringify(full));
  const sig = base64url(createHmac("sha256", getSecret()).update(encodedPayload).digest());
  return { token: `${encodedPayload}.${sig}`, expiresAt: new Date(exp * 1000).toISOString() };
}

export type VerifyUpdateServiceStatusConfirmationResult =
  | { ok: true; payload: UpdateServiceStatusConfirmationPayload }
  | { ok: false; reason: "invalid" | "expired" };

export function verifyUpdateServiceStatusConfirmationToken(token: string): VerifyUpdateServiceStatusConfirmationResult {
  try {
    const dot = token.lastIndexOf(".");
    if (dot < 0) return { ok: false, reason: "invalid" };
    const encodedPayload = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expectedSig = base64url(createHmac("sha256", getSecret()).update(encodedPayload).digest());

    const a = Buffer.from(fromBase64url(sig), "base64");
    const b = Buffer.from(fromBase64url(expectedSig), "base64");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "invalid" };

    const payload = JSON.parse(Buffer.from(fromBase64url(encodedPayload), "base64").toString()) as UpdateServiceStatusConfirmationPayload;
    if (payload.purpose !== "mcp_update_service_status") return { ok: false, reason: "invalid" };
    if (
      typeof payload.jti !== "string" ||
      typeof payload.userId !== "string" ||
      typeof payload.tenantId !== "string" ||
      typeof payload.serviceId !== "string" ||
      typeof payload.currentStatus !== "string" ||
      typeof payload.targetStatus !== "string"
    ) {
      return { ok: false, reason: "invalid" };
    }
    if (payload.exp <= Math.floor(Date.now() / 1000)) return { ok: false, reason: "expired" };
    return { ok: true, payload };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

/**
 * FASE 3 (Mario / MCP gruppi prenotazione): its.preview_* -> its.* per il
 * dominio booking_groups. STESSA identica infrastruttura di sopra — nessun
 * secondo sistema: stesso AGENCY_ACTION_SECRET (fail-closed se assente),
 * stesso TTL, stesso registro single-use condiviso (`claimConfirmationToken`),
 * stesso schema token opaco HMAC-SHA256.
 *
 * Un SOLO purpose (`mcp_booking_group`) con un campo `op` discriminante, così
 * un token emesso per `create_booking_group` non può eseguire
 * `operationalize_booking_group` e viceversa. `groupId` lega il token al
 * gruppo specifico (null solo per `create_booking_group`, che il gruppo non
 * esiste ancora). `args` è lo snapshot degli argomenti approvati in preview:
 * il tool di esecuzione lo ri-valida SEMPRE contro lo stato live (via
 * `lib/server/booking-groups-service.ts`, la stessa logica della route HTTP)
 * prima di scrivere — il token non è mai un'autorizzazione cieca.
 */
export type BookingGroupConfirmationOp =
  | "create_booking_group"
  | "add_booking_group_stop"
  | "add_booking_group_passengers"
  | "reserve_booking_group_bus"
  | "update_booking_group_ferry"
  | "operationalize_booking_group";

export type BookingGroupConfirmationPayload = {
  purpose: "mcp_booking_group";
  op: BookingGroupConfirmationOp;
  jti: string;
  userId: string;
  tenantId: string;
  /** null SOLO per op === "create_booking_group". */
  groupId: string | null;
  /** Snapshot argomenti approvati in preview. */
  args: Record<string, unknown>;
  iat: number;
  exp: number;
};

const BOOKING_GROUP_OPS: readonly BookingGroupConfirmationOp[] = [
  "create_booking_group",
  "add_booking_group_stop",
  "add_booking_group_passengers",
  "reserve_booking_group_bus",
  "update_booking_group_ferry",
  "operationalize_booking_group",
];

export function generateBookingGroupConfirmationToken(payload: {
  op: BookingGroupConfirmationOp;
  userId: string;
  tenantId: string;
  groupId: string | null;
  args: Record<string, unknown>;
}): { token: string; expiresAt: string } {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + CONFIRMATION_TTL_SECONDS;
  const full: BookingGroupConfirmationPayload = {
    purpose: "mcp_booking_group",
    op: payload.op,
    jti: base64url(randomBytes(18)),
    userId: payload.userId,
    tenantId: payload.tenantId,
    groupId: payload.groupId,
    args: payload.args,
    iat,
    exp,
  };
  const encodedPayload = base64url(JSON.stringify(full));
  const sig = base64url(createHmac("sha256", getSecret()).update(encodedPayload).digest());
  return { token: `${encodedPayload}.${sig}`, expiresAt: new Date(exp * 1000).toISOString() };
}

export type VerifyBookingGroupConfirmationResult =
  | { ok: true; payload: BookingGroupConfirmationPayload }
  | { ok: false; reason: "invalid" | "expired" };

export function verifyBookingGroupConfirmationToken(
  token: string,
  expectedOp?: BookingGroupConfirmationOp,
): VerifyBookingGroupConfirmationResult {
  try {
    const dot = token.lastIndexOf(".");
    if (dot < 0) return { ok: false, reason: "invalid" };
    const encodedPayload = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expectedSig = base64url(createHmac("sha256", getSecret()).update(encodedPayload).digest());

    const a = Buffer.from(fromBase64url(sig), "base64");
    const b = Buffer.from(fromBase64url(expectedSig), "base64");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "invalid" };

    const payload = JSON.parse(Buffer.from(fromBase64url(encodedPayload), "base64").toString()) as BookingGroupConfirmationPayload;
    if (payload.purpose !== "mcp_booking_group") return { ok: false, reason: "invalid" };
    if (
      typeof payload.jti !== "string" ||
      typeof payload.userId !== "string" ||
      typeof payload.tenantId !== "string" ||
      typeof payload.op !== "string" ||
      !BOOKING_GROUP_OPS.includes(payload.op) ||
      typeof payload.args !== "object" ||
      payload.args === null ||
      Array.isArray(payload.args)
    ) {
      return { ok: false, reason: "invalid" };
    }
    if (payload.op !== "create_booking_group" && typeof payload.groupId !== "string") {
      return { ok: false, reason: "invalid" };
    }
    if (expectedOp && payload.op !== expectedOp) return { ok: false, reason: "invalid" };
    if (payload.exp <= Math.floor(Date.now() / 1000)) return { ok: false, reason: "expired" };
    return { ok: true, payload };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}
