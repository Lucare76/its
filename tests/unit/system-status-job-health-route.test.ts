import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizePricingRequest: vi.fn()
}));

vi.mock("@/lib/server/job-health", () => ({
  readSystemJobHealthSummary: vi.fn(),
  readRecentJobRuns: vi.fn()
}));

import { GET } from "@/app/api/admin/system-status/route";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { readSystemJobHealthSummary, readRecentJobRuns } from "@/lib/server/job-health";

describe("GET /api/admin/system-status — job health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("è protetto dall'autorizzazione esistente", async () => {
    vi.mocked(authorizePricingRequest).mockResolvedValue(NextResponse.json({ error: "Sessione non valida." }, { status: 401 }));

    const response = await GET(new Request("http://localhost/api/admin/system-status") as never);

    expect(response.status).toBe(401);
    expect(readSystemJobHealthSummary).not.toHaveBeenCalled();
  });

  it("restituisce job_health per il tenant autorizzato senza esporre secret", async () => {
    const storageList = vi.fn().mockResolvedValue({ data: [], error: null });
    const storageFrom = vi.fn(() => ({ list: storageList }));
    const admin = { storage: { from: storageFrom } };
    vi.mocked(authorizePricingRequest).mockResolvedValue({
      admin,
      user: { id: "user-1", email: "admin@example.com" },
      membership: { tenant_id: "tenant-1", role: "admin", suspended: false }
    } as never);
    vi.mocked(readSystemJobHealthSummary).mockResolvedValue([
      {
        job_key: "backup",
        job_name: "Backup automatico",
        source: "api/cron/backup",
        latest_run: null,
        latest_success: null,
        latest_failure: null,
        recent_failed_count: 0
      }
    ]);
    vi.mocked(readRecentJobRuns).mockResolvedValue({ backup: [], "poll-emails": [], "postgres-backup": [], "whatsapp-reminders": [] });

    const response = await GET(new Request("http://localhost/api/admin/system-status", {
      headers: { authorization: "Bearer test" }
    }) as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(readSystemJobHealthSummary).toHaveBeenCalledWith(admin, "tenant-1", ["backup", "poll-emails", "postgres-backup", "whatsapp-reminders"], expect.any(String));
    expect(readRecentJobRuns).toHaveBeenCalledWith(admin, "tenant-1", ["backup", "poll-emails", "postgres-backup", "whatsapp-reminders"]);
    expect(body.job_health).toHaveLength(1);
    expect(body.env[0]).toHaveProperty("present");
    expect(body.env[0]).not.toHaveProperty("value");

    // Sprint 2 — Centro Salute ITS: la response ora include l'interpretazione health, non solo l'execution status grezzo.
    expect(body).toHaveProperty("overall_health");
    expect(body).toHaveProperty("job_health_summary");
    expect(body.job_health[0]).toHaveProperty("health");
    expect(body.job_health[0]).toHaveProperty("reason");
    expect(body.job_health[0]).toHaveProperty("enabled");
    // backup non ha mai girato in questo test (latest_run: null) -> mai eseguito, mai un warning/critical inventato senza dati.
    expect(body.job_health[0].health).toBe("unknown");
    // whatsapp-reminders e' sempre disabled indipendentemente dai run (non presente nel mock readSystemJobHealthSummary -> job_health ha solo 1 entry, verificato sopra).
  });
});
