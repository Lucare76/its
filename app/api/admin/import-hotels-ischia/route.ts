import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { importHotelsFromOsmForTenant } from "@/lib/server/hotels-osm-import";

export const runtime = "nodejs";

const requestSchema = z.object({
  limit: z.number().int().positive().max(1000).optional(),
  dry_run: z.boolean().optional(),
  force_refresh: z.boolean().optional(),
  cache_ttl_minutes: z.number().int().positive().max(7 * 24 * 60).optional()
});

function parseBody(body: unknown) {
  if (!body || typeof body !== "object") return {};
  const input = body as Record<string, unknown>;
  const limitValue = input.limit;
  const dryRunValue = input.dry_run;
  const forceRefreshValue = input.force_refresh;
  const cacheTtlMinutesValue = input.cache_ttl_minutes;
  return {
    limit: typeof limitValue === "number" ? limitValue : undefined,
    dry_run: typeof dryRunValue === "boolean" ? dryRunValue : undefined,
    force_refresh: typeof forceRefreshValue === "boolean" ? forceRefreshValue : undefined,
    cache_ttl_minutes: typeof cacheTtlMinutesValue === "number" ? cacheTtlMinutesValue : undefined
  };
}

export async function POST(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;

    const raw = await request.json().catch(() => ({}));
    const parsed = requestSchema.safeParse(parseBody(raw));
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: parsed.error.issues[0]?.message ?? "Payload non valido." }, { status: 400 });
    }

    const report = await importHotelsFromOsmForTenant(auth.admin, auth.membership.tenant_id, {
      limit: parsed.data.limit,
      dryRun: parsed.data.dry_run ?? false,
      forceRefresh: parsed.data.force_refresh ?? false,
      cacheTtlMinutes: parsed.data.cache_ttl_minutes,
      requestedByUserId: auth.user.id
    });

    return NextResponse.json({
      ok: true,
      tenant_id: auth.membership.tenant_id,
      dry_run: parsed.data.dry_run ?? false,
      force_refresh: parsed.data.force_refresh ?? false,
      cache_ttl_minutes: parsed.data.cache_ttl_minutes ?? null,
      report
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
