/**
 * MedmarAuthProvider — livello di autenticazione isolato verso il portale Medmar.
 *
 * Il flusso di login reale (credenziali -> sessione) NON è ancora documentato
 * (vedi sprint "Medmar One Click Fase 1"). Non vengono quindi inventati
 * payload di login né endpoint di autenticazione. In attesa che il flusso
 * reale venga verificato, questo provider legge un token di sessione già
 * ottenuto manualmente (env var), senza mai hardcodarlo nel codice.
 *
 * Quando il login automatico sarà documentato, sostituire l'implementazione
 * di getSession() seguendo lo stile cache-in-memory di lib/server/radius-adapter.ts
 * (OAuth2 refresh -> access token con scadenza), senza cambiare l'interfaccia.
 */

export class MedmarNotConfiguredError extends Error {
  constructor(message = "Autenticazione Medmar non configurata.") {
    super(message);
    this.name = "MedmarNotConfiguredError";
  }
}

export type MedmarSession = {
  bearerToken: string;
  expiresAt: number;
};

export interface MedmarAuthProvider {
  getSession(): Promise<MedmarSession>;
}

const SESSION_TTL_MS = 5 * 60 * 1000;

class EnvTokenMedmarAuthProvider implements MedmarAuthProvider {
  async getSession(): Promise<MedmarSession> {
    const token = process.env.MEDMAR_SESSION_TOKEN?.trim();
    if (!token) {
      throw new MedmarNotConfiguredError(
        "MEDMAR_SESSION_TOKEN non impostato: nessun flusso di login automatico Medmar è ancora documentato/verificato."
      );
    }
    return { bearerToken: token, expiresAt: Date.now() + SESSION_TTL_MS };
  }
}

let providerInstance: MedmarAuthProvider | null = null;

export function getMedmarAuthProvider(): MedmarAuthProvider {
  if (!providerInstance) {
    providerInstance = new EnvTokenMedmarAuthProvider();
  }
  return providerInstance;
}

/** Solo per i test: consente di iniettare un provider mock. */
export function __setMedmarAuthProviderForTests(provider: MedmarAuthProvider | null): void {
  providerInstance = provider;
}
