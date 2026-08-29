import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { isValidIsoDate } from "@/lib/medmar-date";
import { generateMedmarRowsWithCoverage } from "@/lib/server/medmar-generate-with-coverage";

export const runtime = "nodejs";

// READ-ONLY. Finds the MEDMAR Formula departures for the given operational
// day, grades each one exactly like the Excel-import preview, and resolves
// SPRINT MEDMAR STEP 2 coverage_status (new/sent/changed/invalid) against
// the most recent successful send for the same service_id. Never sends
// WhatsApp, never mutates services / bookings / convocation batches /
// whatsapp_events.
export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const date = request.nextUrl.searchParams.get("date") ?? "";
  if (!isValidIsoDate(date)) {
    return NextResponse.json({ error: "Parametro date non valido: atteso formato YYYY-MM-DD" }, { status: 400 });
  }

  const result = await generateMedmarRowsWithCoverage(auth.admin, auth.membership.tenant_id, date);
  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }

  return NextResponse.json({ ok: true, date, source: "gestionale", summary: result.summary, rows: result.rows });
}
