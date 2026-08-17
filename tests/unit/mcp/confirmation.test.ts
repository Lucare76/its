import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  generateAssignDriverConfirmationToken,
  verifyAssignDriverConfirmationToken,
  claimConfirmationToken,
  __resetConfirmationRegistryForTests,
  CONFIRMATION_TTL_SECONDS,
} from "@/lib/mcp/confirmation";
import { McpError } from "@/lib/mcp/errors";

const BASE_PAYLOAD = {
  userId: "user-1",
  tenantId: "tenant-a",
  serviceId: "service-1",
  driverId: "driver-1",
  vehicleId: null as string | null,
};

describe("mcp confirmation token (Fase 26)", () => {
  beforeEach(() => {
    __resetConfirmationRegistryForTests();
    process.env.AGENCY_ACTION_SECRET = "test-secret-not-real";
  });

  it("1. token valido: verifica riuscita, payload integro", () => {
    const { token } = generateAssignDriverConfirmationToken(BASE_PAYLOAD);
    const result = verifyAssignDriverConfirmationToken(token);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.userId).toBe(BASE_PAYLOAD.userId);
      expect(result.payload.tenantId).toBe(BASE_PAYLOAD.tenantId);
      expect(result.payload.serviceId).toBe(BASE_PAYLOAD.serviceId);
      expect(result.payload.driverId).toBe(BASE_PAYLOAD.driverId);
      expect(result.payload.purpose).toBe("mcp_assign_driver");
    }
  });

  it("2. token invalido (firma alterata): rifiutato", () => {
    const { token } = generateAssignDriverConfirmationToken(BASE_PAYLOAD);
    const [payload] = token.split(".");
    const tampered = `${payload}.tamperedSignatureXYZ`;
    const result = verifyAssignDriverConfirmationToken(tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid");
  });

  it("3. token scaduto: rifiutato con reason 'expired'", () => {
    vi.useFakeTimers();
    const { token } = generateAssignDriverConfirmationToken(BASE_PAYLOAD);
    vi.advanceTimersByTime((CONFIRMATION_TTL_SECONDS + 1) * 1000);
    const result = verifyAssignDriverConfirmationToken(token);
    vi.useRealTimers();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("expired");
  });

  it("4/5. il payload verificato porta userId/tenantId per il binding a monte (assign-driver verifica l'uguaglianza col context)", () => {
    const { token } = generateAssignDriverConfirmationToken({ ...BASE_PAYLOAD, userId: "other-user", tenantId: "other-tenant" });
    const result = verifyAssignDriverConfirmationToken(token);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.userId).not.toBe(BASE_PAYLOAD.userId);
      expect(result.payload.tenantId).not.toBe(BASE_PAYLOAD.tenantId);
    }
  });

  it("6. token riusato: la seconda claim fallisce (single-use)", () => {
    const { token } = generateAssignDriverConfirmationToken(BASE_PAYLOAD);
    const result = verifyAssignDriverConfirmationToken(token);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(claimConfirmationToken(result.payload.jti)).toBe(true);
    expect(claimConfirmationToken(result.payload.jti)).toBe(false);
  });

  it("7. payload tampering: modificare service/driver id nel payload invalida la firma", () => {
    const { token } = generateAssignDriverConfirmationToken(BASE_PAYLOAD);
    const [encodedPayload, sig] = token.split(".");
    const decoded = JSON.parse(Buffer.from(encodedPayload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
    decoded.driverId = "attacker-controlled-driver-id";
    const reencoded = Buffer.from(JSON.stringify(decoded)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
    const tampered = `${reencoded}.${sig}`;
    const result = verifyAssignDriverConfirmationToken(tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid");
  });

  it("9. token con purpose diverso (es. da un altro sistema HMAC): rifiutato", () => {
    const { createHmac } = require("crypto") as typeof import("crypto");
    const foreignPayload = { purpose: "cancel", sid: "x", aid: "y", tid: "z", exp: Math.floor(Date.now() / 1000) + 3600 };
    const encoded = Buffer.from(JSON.stringify(foreignPayload)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
    const sig = createHmac("sha256", "test-secret-not-real").update(encoded).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
    const foreignToken = `${encoded}.${sig}`;
    const result = verifyAssignDriverConfirmationToken(foreignToken);
    expect(result.ok).toBe(false);
  });

  it("10. expiry esatta: al secondo esatto di scadenza il token e' gia' considerato scaduto", () => {
    vi.useFakeTimers();
    const { token } = generateAssignDriverConfirmationToken(BASE_PAYLOAD);
    vi.advanceTimersByTime(CONFIRMATION_TTL_SECONDS * 1000);
    const result = verifyAssignDriverConfirmationToken(token);
    vi.useRealTimers();
    expect(result.ok).toBe(false);
  });

  it("token non prevedibile: due generazioni per lo stesso payload producono jti/token diversi", () => {
    const a = generateAssignDriverConfirmationToken(BASE_PAYLOAD);
    const b = generateAssignDriverConfirmationToken(BASE_PAYLOAD);
    expect(a.token).not.toBe(b.token);
  });
});

/**
 * Micro-hardening: AGENCY_ACTION_SECRET esclusivo, nessun fallback a
 * CRON_SECRET, fail-closed se assente/vuoto.
 */
describe("mcp confirmation token — secret hardening", () => {
  const originalAgencySecret = process.env.AGENCY_ACTION_SECRET;
  const originalCronSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    __resetConfirmationRegistryForTests();
  });

  afterEach(() => {
    if (originalAgencySecret === undefined) delete process.env.AGENCY_ACTION_SECRET;
    else process.env.AGENCY_ACTION_SECRET = originalAgencySecret;
    if (originalCronSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalCronSecret;
  });

  it("1. AGENCY_ACTION_SECRET presente: token generato e verificato correttamente", () => {
    process.env.AGENCY_ACTION_SECRET = "test-secret-real-path";
    delete process.env.CRON_SECRET;
    const { token } = generateAssignDriverConfirmationToken(BASE_PAYLOAD);
    const result = verifyAssignDriverConfirmationToken(token);
    expect(result.ok).toBe(true);
  });

  it("2. AGENCY_ACTION_SECRET assente: nessun token generato, errore sicuro MCP_INTERNAL_ERROR", () => {
    delete process.env.AGENCY_ACTION_SECRET;
    delete process.env.CRON_SECRET;
    expect(() => generateAssignDriverConfirmationToken(BASE_PAYLOAD)).toThrow(McpError);
    try {
      generateAssignDriverConfirmationToken(BASE_PAYLOAD);
      expect.unreachable("doveva lanciare");
    } catch (error) {
      expect(error).toBeInstanceOf(McpError);
      expect((error as McpError).code).toBe("MCP_INTERNAL_ERROR");
      // Il messaggio non deve mai contenere il valore del secret (che qui e' assente,
      // ma il contratto e' che il messaggio sia sempre generico).
      expect((error as McpError).message).not.toMatch(/secret|AGENCY_ACTION_SECRET=/i);
    }
  });

  it("3. AGENCY_ACTION_SECRET vuoto (stringa vuota): stesso comportamento fail-closed", () => {
    process.env.AGENCY_ACTION_SECRET = "";
    delete process.env.CRON_SECRET;
    expect(() => generateAssignDriverConfirmationToken(BASE_PAYLOAD)).toThrow(McpError);
  });

  it("4. CRON_SECRET presente ma AGENCY_ACTION_SECRET assente: deve comunque fallire (nessun fallback)", () => {
    delete process.env.AGENCY_ACTION_SECRET;
    process.env.CRON_SECRET = "cron-secret-should-not-be-used";
    try {
      generateAssignDriverConfirmationToken(BASE_PAYLOAD);
      expect.unreachable("doveva lanciare: CRON_SECRET non deve mai essere usato come fallback");
    } catch (error) {
      expect(error).toBeInstanceOf(McpError);
      expect((error as McpError).code).toBe("MCP_INTERNAL_ERROR");
    }
  });

  it("5. token firmato con un secret diverso da quello corrente: verifica fallisce con reason 'invalid'", () => {
    process.env.AGENCY_ACTION_SECRET = "secret-A";
    const { token } = generateAssignDriverConfirmationToken(BASE_PAYLOAD);

    process.env.AGENCY_ACTION_SECRET = "secret-B-diverso";
    const result = verifyAssignDriverConfirmationToken(token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid");
  });

  it("un secret CRON_SECRET da solo non permette mai di forgiare un token verificabile", () => {
    // Un token "firmato" con CRON_SECRET (simulando un attaccante che lo conoscesse)
    // non deve mai verificare con AGENCY_ACTION_SECRET configurato.
    const { createHmac } = require("crypto") as typeof import("crypto");
    process.env.AGENCY_ACTION_SECRET = "secret-vero";
    const forgedPayload = {
      purpose: "mcp_assign_driver",
      jti: "forged-jti",
      userId: BASE_PAYLOAD.userId,
      tenantId: BASE_PAYLOAD.tenantId,
      serviceId: BASE_PAYLOAD.serviceId,
      driverId: BASE_PAYLOAD.driverId,
      vehicleId: null,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + CONFIRMATION_TTL_SECONDS,
    };
    const encoded = Buffer.from(JSON.stringify(forgedPayload)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
    const forgedSig = createHmac("sha256", "cron-secret-known-by-attacker")
      .update(encoded)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");
    const forgedToken = `${encoded}.${forgedSig}`;
    const result = verifyAssignDriverConfirmationToken(forgedToken);
    expect(result.ok).toBe(false);
  });
});
