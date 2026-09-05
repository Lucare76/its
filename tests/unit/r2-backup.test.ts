import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.fn();

vi.mock("@aws-sdk/client-s3", () => {
  class FakeCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  class FakeS3Client {
    send(...args: unknown[]) {
      return sendMock(...args);
    }
  }
  return {
    S3Client: FakeS3Client,
    PutObjectCommand: class extends FakeCommand {},
    HeadObjectCommand: class extends FakeCommand {},
    ListObjectsV2Command: class extends FakeCommand {},
    DeleteObjectsCommand: class extends FakeCommand {},
  };
});

const REQUIRED_ENV = {
  R2_ACCOUNT_ID: "test-account-id",
  R2_ACCESS_KEY_ID: "test-access-key-id",
  R2_SECRET_ACCESS_KEY: "test-secret-access-key-value",
  R2_BUCKET_NAME: "its-backups-offsite",
  R2_ENDPOINT: "https://test-account-id.r2.cloudflarestorage.com",
};

function setEnv(overrides: Partial<Record<keyof typeof REQUIRED_ENV, string | undefined>> = {}) {
  const merged = { ...REQUIRED_ENV, ...overrides };
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function clearEnv() {
  for (const key of Object.keys(REQUIRED_ENV)) delete process.env[key];
}

describe("r2-backup — Disaster Recovery V2 offsite Cloudflare R2", () => {
  beforeEach(() => {
    sendMock.mockReset();
    clearEnv();
    setEnv();
    vi.resetModules();
  });

  afterEach(() => {
    clearEnv();
  });

  it("1. primary success + R2 upload success + HeadObject success -> status success, verified true, size coerente", async () => {
    const { uploadOffsiteBackup } = await import("@/lib/server/r2-backup");
    const bytes = Buffer.from(JSON.stringify({ hello: "world" }), "utf-8");
    sendMock
      .mockResolvedValueOnce({}) // PutObjectCommand
      .mockResolvedValueOnce({ ContentLength: bytes.length }); // HeadObjectCommand

    const result = await uploadOffsiteBackup("backup_2026-09-06.json", bytes);

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.verified).toBe(true);
      expect(result.size_bytes).toBe(bytes.length);
      expect(result.key).toBe("production/backup_2026-09-06.json");
      expect(result.bucket).toBe("its-backups-offsite");
    }
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it("2. R2 PutObject failure -> status failed, mai un'eccezione propagata", async () => {
    const { uploadOffsiteBackup } = await import("@/lib/server/r2-backup");
    const bytes = Buffer.from("{}", "utf-8");
    sendMock.mockRejectedValueOnce(new Error("network unreachable"));

    const result = await uploadOffsiteBackup("backup_2026-09-06.json", bytes);

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toContain("network unreachable");
      expect(result.verified).toBe(false);
    }
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("3. HeadObject failure dopo upload riuscito -> status failed (PutObject da solo non basta)", async () => {
    const { uploadOffsiteBackup } = await import("@/lib/server/r2-backup");
    const bytes = Buffer.from("{}", "utf-8");
    sendMock
      .mockResolvedValueOnce({}) // PutObjectCommand ok
      .mockRejectedValueOnce(new Error("404 Not Found")); // HeadObjectCommand fallisce

    const result = await uploadOffsiteBackup("backup_2026-09-06.json", bytes);

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toContain("Verifica HeadObject fallita");
    }
  });

  it("3b. HeadObject risponde ma con ContentLength incoerente -> status failed", async () => {
    const { uploadOffsiteBackup } = await import("@/lib/server/r2-backup");
    const bytes = Buffer.from("{}", "utf-8");
    sendMock.mockResolvedValueOnce({}).mockResolvedValueOnce({ ContentLength: 1 });

    const result = await uploadOffsiteBackup("backup_2026-09-06.json", bytes);

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toContain("dimensione attesa");
    }
  });

  it("4. env R2 mancanti -> status skipped, nessuna chiamata S3, primary non impattato", async () => {
    clearEnv();
    const { uploadOffsiteBackup, getR2ConfigStatus } = await import("@/lib/server/r2-backup");

    const config = getR2ConfigStatus();
    expect(config.configured).toBe(false);

    const result = await uploadOffsiteBackup("backup_2026-09-06.json", Buffer.from("{}"));
    expect(result.status).toBe("skipped");
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("4b. env R2 parzialmente mancanti -> configured false con elenco preciso delle mancanti", async () => {
    clearEnv();
    setEnv({ R2_ENDPOINT: undefined });
    const { getR2ConfigStatus } = await import("@/lib/server/r2-backup");
    const config = getR2ConfigStatus();
    expect(config.configured).toBe(false);
    if (!config.configured) expect(config.missing).toEqual(["R2_ENDPOINT"]);
  });

  it("5. purge R2 success -> elenca il prefix corretto e cancella solo gli oggetti scaduti", async () => {
    const { purgeOldOffsiteBackups } = await import("@/lib/server/r2-backup");
    const now = new Date("2026-09-06T00:00:00.000Z");
    sendMock
      .mockResolvedValueOnce({
        Contents: [
          { Key: "production/backup_2026-01-01.json" }, // scaduto (>90gg)
          { Key: "production/backup_2026-09-05.json" }, // recente
        ],
      })
      .mockResolvedValueOnce({}); // DeleteObjectsCommand ok

    const result = await purgeOldOffsiteBackups(now);

    expect(result.errors).toEqual([]);
    expect(result.deleted).toEqual(["production/backup_2026-01-01.json"]);
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it("6. purge R2 failure (elenco) -> restituisce errore, nessuna eccezione, nessuna cancellazione tentata", async () => {
    const { purgeOldOffsiteBackups } = await import("@/lib/server/r2-backup");
    sendMock.mockRejectedValueOnce(new Error("list denied"));

    const result = await purgeOldOffsiteBackups(new Date("2026-09-06T00:00:00.000Z"));

    expect(result.deleted).toEqual([]);
    expect(result.errors[0]).toContain("Elenco oggetti R2 fallito");
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("6b. purge R2 failure (cancellazione) -> errore riportato, nessun oggetto segnato come cancellato", async () => {
    const { purgeOldOffsiteBackups } = await import("@/lib/server/r2-backup");
    sendMock
      .mockResolvedValueOnce({ Contents: [{ Key: "production/backup_2026-01-01.json" }] })
      .mockRejectedValueOnce(new Error("delete denied"));

    const result = await purgeOldOffsiteBackups(new Date("2026-09-06T00:00:00.000Z"));

    expect(result.deleted).toEqual([]);
    expect(result.errors[0]).toContain("Cancellazione oggetti R2 fallita");
  });

  it("7. un errore R2 (upload fallito) non invalida ne' cancella il backup primario Supabase — il modulo R2 non tocca mai storage Supabase", async () => {
    const { uploadOffsiteBackup } = await import("@/lib/server/r2-backup");
    sendMock.mockRejectedValueOnce(new Error("boom"));

    const result = await uploadOffsiteBackup("backup_2026-09-06.json", Buffer.from("{}"));

    expect(result.status).toBe("failed");
    // Il modulo r2-backup non importa ne' chiama mai il client Supabase: un
    // fallimento qui si limita a restituire un valore, senza alcun accesso
    // a storage/db esterni al bucket R2 stesso.
  });

  it("8. nessun secret presente nel messaggio di errore riportato (summarizeR2Error ridacta i valori delle env sensibili)", async () => {
    const { summarizeR2Error } = await import("@/lib/server/r2-backup");
    const leaky = new Error(`AccessDenied for key ${REQUIRED_ENV.R2_ACCESS_KEY_ID} secret ${REQUIRED_ENV.R2_SECRET_ACCESS_KEY}`);

    const message = summarizeR2Error(leaky);

    expect(message).not.toContain(REQUIRED_ENV.R2_ACCESS_KEY_ID);
    expect(message).not.toContain(REQUIRED_ENV.R2_SECRET_ACCESS_KEY);
    expect(message).toContain("[redacted]");
  });

  it("9. retention non cancella backup <=90 giorni (esattamente al cutoff resta)", async () => {
    const { purgeOldOffsiteBackups } = await import("@/lib/server/r2-backup");
    const now = new Date("2026-09-06T00:00:00.000Z"); // cutoff = 2026-06-08
    sendMock.mockResolvedValueOnce({
      Contents: [{ Key: "production/backup_2026-06-08.json" }, { Key: "production/backup_2026-09-01.json" }],
    });

    const result = await purgeOldOffsiteBackups(now);

    expect(result.deleted).toEqual([]);
    expect(sendMock).toHaveBeenCalledTimes(1); // solo list, nessuna DeleteObjectsCommand
  });

  it("10. retention cancella solo backup >90 giorni, ignora oggetti fuori dal pattern nome file", async () => {
    const { purgeOldOffsiteBackups } = await import("@/lib/server/r2-backup");
    const now = new Date("2026-09-06T00:00:00.000Z");
    sendMock
      .mockResolvedValueOnce({
        Contents: [
          { Key: "production/backup_2026-01-01.json" }, // scaduto
          { Key: "production/backup_2026-09-05.json" }, // recente
          { Key: "production/README.txt" }, // non corrisponde al pattern -> ignorato
        ],
      })
      .mockResolvedValueOnce({});

    const result = await purgeOldOffsiteBackups(now);

    expect(result.deleted).toEqual(["production/backup_2026-01-01.json"]);
  });
});
