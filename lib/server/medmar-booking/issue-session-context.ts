import { getMedmarAuthProvider } from "./auth";
import { createMedmarMutationClient, MedmarMutationRemoteUnknownError } from "./medmar-mutation-client";
import type { MedmarIssueSessionContext, MedmarMutationClient } from "./issue-types";

type SessionContextResult =
  | { ok: true; context: MedmarIssueSessionContext }
  | { ok: false; status: "not_ready" | "remote_state_unknown"; error: string; retry_allowed: boolean };

function romeDateTimeParts(now: Date): { data: string; ora: string } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Rome",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    data: `${get("year")}-${get("month")}-${get("day")}`,
    ora: `${get("hour")}:${get("minute")}:${get("second")}`,
  };
}

export async function resolveMedmarIssueSessionContext(input?: {
  mutationClient?: MedmarMutationClient;
  now?: Date;
}): Promise<SessionContextResult> {
  const session = await getMedmarAuthProvider().getValidToken();
  if (session.userId == null || !session.clienteId || !session.postazioneId) {
    return {
      ok: false,
      status: "not_ready",
      error: "Contesto sessione Medmar incompleto: utente, cliente o postazione mancanti.",
      retry_allowed: false,
    };
  }

  const { data, ora } = romeDateTimeParts(input?.now ?? new Date());
  try {
    const turn = await (input?.mutationClient ?? createMedmarMutationClient()).openTurn({
      id_utente: session.userId,
      id_postazione: session.postazioneId,
      flag_stato: "A",
      data,
      ora_apertura: ora,
      ora_chiusura: "23:59:59",
    });
    return {
      ok: true,
      context: {
        bearerToken: session.bearerToken,
        userId: session.userId,
        clienteId: session.clienteId,
        postazioneId: session.postazioneId,
        turnoId: turn.id_turno,
      },
    };
  } catch (err) {
    if (err instanceof MedmarMutationRemoteUnknownError || (err instanceof Error && err.name === "MedmarMutationRemoteUnknownError")) {
      return {
        ok: false,
        status: "remote_state_unknown",
        error: "Apertura turno Medmar ambigua: verificare manualmente prima di riprovare.",
        retry_allowed: false,
      };
    }
    return {
      ok: false,
      status: "not_ready",
      error: "Apertura turno Medmar non disponibile.",
      retry_allowed: false,
    };
  }
}
