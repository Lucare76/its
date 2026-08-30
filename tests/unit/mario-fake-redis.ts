/**
 * Fake Upstash-compatibile per i test del session store di Mario (FASE A.1).
 *
 * Implementa solo il sottoinsieme usato da lib/server/mario-assistant/
 * session-context.ts: get<T>, set(key, value, { ex?, keepTtl? }), del.
 * I valori sono clonati (structuredClone) per imitare la serializzazione
 * JSON di Upstash — nessun riferimento condiviso con il chiamante.
 *
 * NON è un file di test (niente `.test.ts`): vitest non lo raccoglie come suite.
 */

type Entry = { value: unknown; expiresAt: number | null };

export type FakeRedisOptions = {
  /** Se true, ogni operazione lancia — simula Upstash down (§16). */
  failing?: boolean;
  /** Clock iniettabile per testare la scadenza TTL della key. */
  now?: () => number;
};

export class FakeUpstashRedis {
  private readonly store = new Map<string, Entry>();
  private readonly now: () => number;
  failing: boolean;

  constructor(opts: FakeRedisOptions = {}) {
    this.failing = opts.failing ?? false;
    this.now = opts.now ?? (() => Date.now());
  }

  private assertUp() {
    if (this.failing) throw new Error("FakeUpstashRedis: simulated store failure");
  }

  private live(key: string): Entry | undefined {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (e.expiresAt !== null && this.now() >= e.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return e;
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    this.assertUp();
    const e = this.live(key);
    return e ? (structuredClone(e.value) as T) : null;
  }

  async set(
    key: string,
    value: unknown,
    opts?: { ex?: number; keepTtl?: boolean },
  ): Promise<"OK"> {
    this.assertUp();
    let expiresAt: number | null = null;
    if (opts?.keepTtl) {
      expiresAt = this.store.get(key)?.expiresAt ?? null;
    } else if (typeof opts?.ex === "number") {
      expiresAt = this.now() + opts.ex * 1000;
    }
    this.store.set(key, { value: structuredClone(value), expiresAt });
    return "OK";
  }

  async del(key: string): Promise<number> {
    this.assertUp();
    return this.store.delete(key) ? 1 : 0;
  }

  /** Test helper: quante key vivono attualmente. */
  size(): number {
    for (const k of [...this.store.keys()]) this.live(k);
    return this.store.size;
  }

  /** Test helper: dump grezzo (per assert diretti). */
  raw(key: string): unknown {
    return this.live(key)?.value ?? null;
  }
}
