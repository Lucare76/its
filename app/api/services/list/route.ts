import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { buildServicesQuery, serviceQueryFiltersSchema } from "@/lib/server/services-filter-builder";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const authHeader = request.headers.get("authorization");

    if (!supabaseUrl || !serviceRoleKey) {
      return NextResponse.json({ error: "Configurazione server mancante." }, { status: 500 });
    }
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Sessione non valida." }, { status: 401 });
    }

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    const token = authHeader.slice("Bearer ".length);
    const {
      data: { user },
      error: userError
    } = await admin.auth.getUser(token);
    if (userError || !user) {
      return NextResponse.json({ error: "Sessione non valida." }, { status: 401 });
    }

    const payload = await request.json();
    const parsed = serviceQueryFiltersSchema.safeParse(payload);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Filtri non validi." }, { status: 400 });
    }

    const { data: membership, error: membershipError } = await admin
      .from("memberships")
      .select("tenant_id, role")
      .eq("user_id", user.id)
      .eq("tenant_id", parsed.data.tenant_id)
      .maybeSingle();

    if (membershipError || !membership?.tenant_id) {
      return NextResponse.json({ error: "Membership non trovata." }, { status: 403 });
    }

    const filters = {
      ...parsed.data,
      agency_id: membership.role === "agency" ? user.id : parsed.data.agency_id
    };

    const query = (await buildServicesQuery({
      admin,
      filters,
      select: "*"
    })) as any;

    const { data: services, error: servicesError } = await query.order("date", { ascending: true }).order("time", { ascending: true });
    if (servicesError) {
      console.error("Services list query error", servicesError.message);
      return NextResponse.json({ error: "Errore caricamento servizi." }, { status: 500 });
    }

    return NextResponse.json({ services: services ?? [] });
  } catch (error) {
    console.error("Services list endpoint unexpected error", error);
    return NextResponse.json({ error: "Errore interno server." }, { status: 500 });
  }
}
