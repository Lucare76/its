import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor", "assistenza"]);
  if (auth instanceof NextResponse) return auth;

  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) return NextResponse.json({ services: [] });

  const { data, error } = await auth.admin
    .from("services")
    .select("id, customer_name, customer_first_name, customer_last_name, phone, date, time, booking_service_kind, hotels(name)")
    .eq("tenant_id", auth.membership.tenant_id)
    .or(`customer_name.ilike.%${q}%,phone.ilike.%${q}%`)
    .order("date", { ascending: false })
    .limit(20);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ services: data ?? [] });
}
