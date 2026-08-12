import { beforeEach, describe, expect, it, vi } from "vitest";
import { MedmarMutationRemoteUnknownError } from "@/lib/server/medmar-booking/medmar-mutation-client";
import type { MedmarMutationClient } from "@/lib/server/medmar-booking/issue-types";

function mutationClient(overrides: Partial<MedmarMutationClient> = {}): MedmarMutationClient {
  return {
    openTurn: vi.fn().mockResolvedValue({ id_turno: 91001 }),
    lockAvailability: vi.fn(),
    createBooking: vi.fn(),
    payManual: vi.fn(),
    unlockAvailability: vi.fn(),
    ...overrides,
  };
}

describe("medmar issue session context", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.restoreAllMocks();
    const { __setMedmarAuthProviderForTests } = await import("@/lib/server/medmar-booking/auth");
    __setMedmarAuthProviderForTests({
      authenticate: vi.fn(),
      getValidToken: vi.fn().mockResolvedValue({
        bearerToken: "test-token",
        expiresAt: Date.now() + 60_000,
        userId: 89,
        clienteId: "cliente-from-auth",
        postazioneId: "77",
      }),
      invalidateToken: vi.fn(),
    });
  });

  it("apre il turno con payload dinamico e data/ora Europe/Rome", async () => {
    const client = mutationClient();
    const { resolveMedmarIssueSessionContext } = await import("@/lib/server/medmar-booking/issue-session-context");
    const result = await resolveMedmarIssueSessionContext({
      mutationClient: client,
      now: new Date("2026-08-12T07:15:30.000Z"),
    });
    expect(result.ok).toBe(true);
    expect(client.openTurn).toHaveBeenCalledWith({
      id_utente: 89,
      id_postazione: "77",
      flag_stato: "A",
      data: "2026-08-12",
      ora_apertura: "09:15:30",
      ora_chiusura: "23:59:59",
    });
    if (result.ok) {
      expect(result.context).toMatchObject({
        bearerToken: "test-token",
        userId: 89,
        clienteId: "cliente-from-auth",
        postazioneId: "77",
        turnoId: 91001,
      });
    }
  });

  it("contesto auth incompleto -> not_ready e nessuna apertura turno", async () => {
    const { __setMedmarAuthProviderForTests } = await import("@/lib/server/medmar-booking/auth");
    __setMedmarAuthProviderForTests({
      authenticate: vi.fn(),
      getValidToken: vi.fn().mockResolvedValue({
        bearerToken: "test-token",
        expiresAt: Date.now() + 60_000,
        userId: 89,
        clienteId: null,
        postazioneId: "77",
      }),
      invalidateToken: vi.fn(),
    });
    const client = mutationClient();
    const { resolveMedmarIssueSessionContext } = await import("@/lib/server/medmar-booking/issue-session-context");
    const result = await resolveMedmarIssueSessionContext({ mutationClient: client });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("not_ready");
    expect(client.openTurn).not.toHaveBeenCalled();
  });

  it("timeout apertura turno -> remote_state_unknown e nessuna seconda POST logica", async () => {
    const client = mutationClient({ openTurn: vi.fn().mockRejectedValue(new MedmarMutationRemoteUnknownError()) });
    const { resolveMedmarIssueSessionContext } = await import("@/lib/server/medmar-booking/issue-session-context");
    const result = await resolveMedmarIssueSessionContext({ mutationClient: client });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("remote_state_unknown");
    expect(client.openTurn).toHaveBeenCalledTimes(1);
  });
});
