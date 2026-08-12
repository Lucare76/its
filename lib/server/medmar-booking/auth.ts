/**
 * MedmarAuthProvider — livello di autenticazione isolato verso il portale Medmar.
 *
 * Fase 2A: login automatico reale. Questo file resta il CONTRATTO stabile
 * verso il resto del modulo (client.ts, preflight.ts): possiede solo il
 * singleton e l'hook di test. L'implementazione (precedenza env, chiamata
 * reale a /authenticate, parsing JWT, cache, single-flight) vive in
 * medmar-auth-provider.ts — vedi quel file per i dettagli, incluso perché
 * duplica localmente il prefisso di path invece di importarlo da client.ts
 * (per evitare un import circolare client.ts -> auth.ts -> quel file ->
 * client.ts).
 *
 * Il business code (client.ts, preflight.ts) chiede sempre e solo un token
 * valido a questo modulo: non vede mai email/password.
 */

export {
  MedmarNotConfiguredError,
  MedmarAuthFailedError,
  createMedmarAuthProvider,
} from "./medmar-auth-provider";
export type { MedmarSession, MedmarAuthProvider } from "./medmar-auth-provider";

import { createMedmarAuthProvider } from "./medmar-auth-provider";
import type { MedmarAuthProvider } from "./medmar-auth-provider";

let providerInstance: MedmarAuthProvider | null = null;

export function getMedmarAuthProvider(): MedmarAuthProvider {
  if (!providerInstance) {
    providerInstance = createMedmarAuthProvider();
  }
  return providerInstance;
}

/** Solo per i test: consente di iniettare un provider mock. */
export function __setMedmarAuthProviderForTests(provider: MedmarAuthProvider | null): void {
  providerInstance = provider;
}
