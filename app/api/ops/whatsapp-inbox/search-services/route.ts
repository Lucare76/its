import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

function sanitizeToken(raw: string) {
  return raw.replace(/[,%()]/g, " ").trim();
}

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor", "assistenza"]);
  if (auth instanceof NextResponse) return auth;

  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) return NextResponse.json({ services: [] });

  // Word-order tolerant: WhatsApp contact/thread names are often displayed
  // "SURNAME FIRSTNAME" (as typed here by the operator), while services.customer_name
  // is stored "Firstname Lastname" — a single literal ilike("%q%") never matches
  // when the two words are reversed. Require every whitespace-separated token to
  // appear somewhere in customer_name (any order), OR the raw query to match phone.
  const tokens = q.split(/\s+/).map(sanitizeToken).filter((token) => token.length > 0);
  const nameClause = tokens.length > 0 ? `and(${tokens.map((token) => `customer_name.ilike.%${token}%`).join(",")})` : "";
  const phoneClause = `phone.ilike.%${sanitizeToken(q)}%`;
  const orFilter = nameClause ? `${nameClause},${phoneClause}` : phoneClause;

  const { data, error } = await auth.admin
    .from("services")
    .select("id, customer_name, customer_first_name, customer_last_name, phone, date, time, booking_service_kind, billing_party_name, agency_id, hotels(name), agencies(name)")
    .eq("tenant_id", auth.membership.tenant_id)
    .or(orFilter)
    .order("date", { ascending: false })
    .limit(20);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ services: data ?? [] });
}
