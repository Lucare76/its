import { NextRequest, NextResponse } from "next/server";
import { buildServicesQuery, serviceQueryFiltersSchema } from "@/lib/server/services-filter-builder";
import { authorizeServiceRoleRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

// GET is not used for listing (use POST with filters), but the auth check
// must still return 401 for unauthenticated requests rather than 405.
export async function GET(request: NextRequest) {
  const auth = await authorizeServiceRoleRequest(request, {
    roles: ["admin", "operator", "agency", "supervisor"],
    auditPrefix: "services_list"
  });
  if (auth instanceof NextResponse) return auth;
  return NextResponse.json({ error: "Use POST to list services." }, { status: 405 });
}

export async function POST(request: NextRequest) {
  try {
    const auth = await authorizeServiceRoleRequest(request, {
      roles: ["admin", "operator", "agency", "supervisor"],
      membershipFields: ["agency_id"],
      auditPrefix: "services_list"
    });
    if (auth instanceof NextResponse) return auth;

    const payload = await request.json();
    const parsed = serviceQueryFiltersSchema.safeParse(payload);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Filtri non validi." }, { status: 400 });
    }
    if (parsed.data.tenant_id !== auth.membership.tenant_id) {
      return NextResponse.json({ error: "Tenant non autorizzato." }, { status: 403 });
    }

    if (auth.membership.role === "agency" && !auth.membership.agency_id) {
      return NextResponse.json({ error: "Account agenzia non configurato." }, { status: 403 });
    }

    const filters = {
      ...parsed.data,
      agency_id: auth.membership.role === "agency" ? auth.membership.agency_id : parsed.data.agency_id
    };

    const { query } = await buildServicesQuery({
      admin: auth.admin,
      filters,
      select: "*"
    });

    const { data: services, error: servicesError } = await query.order("date", { ascending: true }).order("time", { ascending: true });
    if (servicesError) {
      console.error("Services list query error", servicesError.message);
      return NextResponse.json({ error: "Errore caricamento servizi." }, { status: 500 });
    }

    return NextResponse.json({ services: services ?? [] });
  } catch (error) {
    console.error("Services list endpoint unexpected error", error instanceof Error ? error.message : String(error));
    return NextResponse.json({ error: "Errore interno server." }, { status: 500 });
  }
}
