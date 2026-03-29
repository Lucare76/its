import { NextRequest, NextResponse } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { parseRole } from "@/lib/rbac";
import { resolvePreferredMembership } from "@/lib/tenant-preference";
import { agencyProfileSetupSchema } from "@/lib/validation";

export const runtime = "nodejs";

type AgencyRole = "admin" | "agency";

type AuthContext = {
  admin: SupabaseClient;
  user: { id: string; email: string | null };
  membership: { tenant_id: string; agency_id: string | null; role: AgencyRole; full_name: string };
};

type MembershipRow = {
  tenant_id: string | null;
  agency_id?: string | null;
  role: string | null;
  full_name?: string | null;
  suspended?: boolean | null;
};

type AgencyRow = {
  id: string;
  name?: string | null;
  legal_name?: string | null;
  billing_name?: string | null;
  contact_email?: string | null;
  booking_email?: string | null;
  phone?: string | null;
  vat_number?: string | null;
  pec_email?: string | null;
  sdi_code?: string | null;
  notes?: string | null;
  active?: boolean | null;
  setup_required?: boolean | null;
};

async function hasColumn(admin: SupabaseClient, table: string, column: string) {
  const { error } = await admin.from(table).select(column).limit(1);
  if (!error) return true;
  if ((error as { code?: string }).code === "42703") return false;
  throw new Error(`Schema probe failed for ${table}.${column}: ${error.message}`);
}

async function authorizeAgencyProfileRequest(request: NextRequest): Promise<AuthContext | NextResponse> {
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

  const { data: memberships, error: membershipError } = await admin
    .from("memberships")
    .select("tenant_id, agency_id, role, full_name, suspended")
    .eq("user_id", user.id);
  const membershipRow = resolvePreferredMembership((memberships ?? []) as MembershipRow[]);

  const role = parseRole(membershipRow?.role ?? undefined);
  if (membershipError || !membershipRow?.tenant_id || !role || membershipRow.suspended === true) {
    return NextResponse.json({ error: "Membership non trovata." }, { status: 403 });
  }
  if (role !== "agency" && role !== "admin") {
    return NextResponse.json({ error: "Ruolo non autorizzato." }, { status: 403 });
  }

  return {
    admin,
    user: { id: user.id, email: user.email ?? null },
    membership: {
      tenant_id: membershipRow.tenant_id,
      agency_id: membershipRow.agency_id ?? null,
      role,
      full_name: membershipRow.full_name ?? ""
    }
  };
}

async function resolveAgency(auth: AuthContext) {
  const supportsExternalCode = await hasColumn(auth.admin, "agencies", "external_code");
  const supportsSetupRequired = await hasColumn(auth.admin, "agencies", "setup_required");
  const externalCode = `auth_user:${auth.user.id}`;
  const selectColumns = [
    "id",
    "name",
    "legal_name",
    "billing_name",
    "contact_email",
    "booking_email",
    "phone",
    "vat_number",
    "pec_email",
    "sdi_code",
    "notes",
    "active",
    supportsSetupRequired ? "setup_required" : null
  ]
    .filter(Boolean)
    .join(", ");

  let query = auth.admin
    .from("agencies")
    .select(selectColumns)
    .eq("tenant_id", auth.membership.tenant_id);

  if (auth.membership.agency_id) {
    query = query.eq("id", auth.membership.agency_id);
  } else {
    query = supportsExternalCode ? query.eq("external_code", externalCode) : query.eq("name", auth.membership.full_name.trim() || "Agenzia");
  }

  let { data: agency, error } = await query.maybeSingle();
  let agencyRow = agency as AgencyRow | null;
  if (error) {
    return { agency: null, supportsSetupRequired, error: error.message };
  }

  if (agencyRow?.id && auth.membership.agency_id !== agencyRow.id) {
    await auth.admin
      .from("memberships")
      .update({ agency_id: agencyRow.id })
      .eq("tenant_id", auth.membership.tenant_id)
      .eq("user_id", auth.user.id);
  }

  if (!agencyRow?.id && auth.membership.role === "agency") {
    const insertPayload: Record<string, unknown> = {
      tenant_id: auth.membership.tenant_id,
      name: auth.membership.full_name.trim() || auth.user.email?.split("@")[0] || "Agenzia",
      active: true,
      contact_email: auth.user.email,
      booking_email: auth.user.email
    };
    if (supportsExternalCode) {
      insertPayload.external_code = externalCode;
    }
    if (supportsSetupRequired) {
      insertPayload.setup_required = true;
    }

    const insert = await auth.admin
      .from("agencies")
      .insert(insertPayload)
      .select(selectColumns)
      .maybeSingle();
    const insertedAgency = insert.data as AgencyRow | null;
    if (insert.error || !insertedAgency?.id) {
      return { agency: null, supportsSetupRequired, error: insert.error?.message ?? "Creazione agenzia fallita." };
    }
    await auth.admin
      .from("memberships")
      .update({ agency_id: insertedAgency.id })
      .eq("tenant_id", auth.membership.tenant_id)
      .eq("user_id", auth.user.id);
    agencyRow = insertedAgency;
  }

  return { agency: agencyRow, supportsSetupRequired };
}

export async function GET(request: NextRequest) {
  const auth = await authorizeAgencyProfileRequest(request);
  if (auth instanceof NextResponse) return auth;

  const resolved = await resolveAgency(auth);
  if (resolved.error) {
    return NextResponse.json({ error: resolved.error }, { status: 500 });
  }
  if (!resolved.agency?.id) {
    return NextResponse.json({ error: "Anagrafica agenzia non trovata." }, { status: 404 });
  }

  return NextResponse.json({
    ok: true,
    agency: {
      ...resolved.agency,
      setup_required: resolved.supportsSetupRequired ? resolved.agency.setup_required ?? false : false
    }
  });
}

export async function PATCH(request: NextRequest) {
  const auth = await authorizeAgencyProfileRequest(request);
  if (auth instanceof NextResponse) return auth;

  const parsed = agencyProfileSetupSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Payload non valido." }, { status: 400 });
  }

  const resolved = await resolveAgency(auth);
  if (resolved.error) {
    return NextResponse.json({ error: resolved.error }, { status: 500 });
  }
  if (!resolved.agency?.id) {
    return NextResponse.json({ error: "Anagrafica agenzia non trovata." }, { status: 404 });
  }

  const updatePayload: Record<string, unknown> = {
    name: parsed.data.name.trim(),
    legal_name: parsed.data.legal_name.trim(),
    billing_name: parsed.data.billing_name.trim(),
    contact_email: parsed.data.contact_email.trim().toLowerCase(),
    booking_email: parsed.data.booking_email.trim().toLowerCase(),
    phone: parsed.data.phone.trim(),
    vat_number: parsed.data.vat_number.trim(),
    pec_email: parsed.data.pec_email?.trim().toLowerCase() || null,
    sdi_code: parsed.data.sdi_code?.trim().toUpperCase() || null,
    notes: parsed.data.notes?.trim() || null,
    active: true
  };
  if (resolved.supportsSetupRequired) {
    updatePayload.setup_required = false;
  }

  const update = await auth.admin
    .from("agencies")
    .update(updatePayload)
    .eq("tenant_id", auth.membership.tenant_id)
    .eq("id", resolved.agency.id)
    .select(
      [
        "id",
        "name",
        "legal_name",
        "billing_name",
        "contact_email",
        "booking_email",
        "phone",
        "vat_number",
        "pec_email",
        "sdi_code",
        "notes",
        "active",
        resolved.supportsSetupRequired ? "setup_required" : null
      ]
        .filter(Boolean)
        .join(", ")
    )
    .maybeSingle();
  const updatedAgency = update.data as AgencyRow | null;

  if (update.error || !updatedAgency?.id) {
    return NextResponse.json({ error: update.error?.message ?? "Salvataggio profilo agenzia fallito." }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    agency: {
      ...updatedAgency,
      setup_required: resolved.supportsSetupRequired ? updatedAgency.setup_required ?? false : false
    }
  });
}
