/**
 * Client Upstash Redis (REST) CONDIVISO per il progetto.
 *
 * Audit FASE A.1: prima di questo modulo l'unico consumatore di Redis era
 * `lib/server/rate-limit.ts`, che costruiva il proprio client privato
 * (`new Redis(...)`) leggendo `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`.
 * Questo modulo estrae quella costruzione in un unico punto riutilizzabile —
 * NON introduce un secondo provider né un secondo set di env: `rate-limit.ts`
 * ora consuma `getSharedRedis()` da qui.
 *
 * `@upstash/redis` è un client REST stateless (nessun pool di connessioni):
 * memorizzarne un'istanza serve solo a evitare di ri-parsare le env ad ogni
 * chiamata, non a mantenere socket aperti.
 */
import { Redis } from "@upstash/redis";

let cached: Redis | null = null;

/** Override iniettabile SOLO dai test (fake in-memory Upstash-compatibile).
 *  `undefined` = nessun override; `null` = forza "non configurato". */
let testOverride: Redis | null | undefined;

function readEnv(): { url: string | undefined; token: string | undefined } {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim().replace(/^["']|["']$/g, "");
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim().replace(/^["']|["']$/g, "");
  return { url, token };
}

/** True se le env Upstash sono presenti (o se un fake è iniettato nei test). */
export function isSharedRedisConfigured(): boolean {
  if (testOverride !== undefined) return testOverride !== null;
  const { url, token } = readEnv();
  return Boolean(url && token);
}

/** Ritorna il client condiviso, oppure `null` se Upstash non è configurato.
 *  Stessa semantica di lettura-env-ad-ogni-chiamata già usata da rate-limit.ts
 *  (il caso `null` non viene memorizzato: un deploy che aggiunge le env più
 *  tardi non richiede un riavvio del processo). */
export function getSharedRedis(): Redis | null {
  if (testOverride !== undefined) return testOverride;
  const { url, token } = readEnv();
  if (!url || !token) return null;
  if (!cached) cached = new Redis({ url, token });
  return cached;
}

/** Test-only: inietta un client fake (Upstash-compatibile) o `null` per
 *  simulare "non configurato". Passare `undefined` per rimuovere l'override. */
export function __setSharedRedisForTests(client: Redis | null | undefined): void {
  testOverride = client;
  cached = null;
}
