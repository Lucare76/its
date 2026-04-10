import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { agencyProfileSetupSchema } from "@/lib/validation";
import { authorizeServiceRoleRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

type AgencyRole = "admin" | "agency";

type AuthContext = {
  admin: SupabaseClient;
  user: { id: string; email: string | null };
  membership: { tenant_id: string; agency_id: string | null; role: AgencyRole; full_name: string };
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
  try {
    const { error } = await admin.from(table).select(column).limit(1);
    if (!error) return true;
    if ((error as { code?: string }).code === "42703") return false;
    // Per qualsiasi altro errore (permessi, rete) assume colonna assente
    return false;
  } catch {
    return false;
  }
}

async function authorizeAgencyProfileRequest(request: NextRequest): Promise<AuthContext | NextResponse> {
  const auth = await authorizeServiceRoleRequest<AgencyRole, { agency_id?: string | null; full_name?: string | null }>(request, {
    roles: ["admin", "agency"],
    membershipFields: ["agency_id", "full_name"],
    auditPrefix: "agency_profile"
  });
  if (auth instanceof NextResponse) return auth;
  return {
    admin: auth.admin,
    user: { id: auth.user.id, email: auth.user.email },
    membership: {
      tenant_id: auth.membership.tenant_id,
      agency_id: auth.membership.agency_id ?? null,
      role: auth.membership.role,
      full_name: auth.membership.full_name ?? ""
    }
  };
}

async function resolveAgency(auth: AuthContext) {
  const [
    supportsExternalCode,
    supportsSetupRequired,
    supportsVatNumber,
    supportsPecEmail,
    supportsSdiCode,
    supportsLegalName,
    supportsBillingName,
    supportsNotes
  ] = await Promise.all([
    hasColumn(auth.admin, "agencies", "external_code"),
    hasColumn(auth.admin, "agencies", "setup_required"),
    hasColumn(auth.admin, "agencies", "vat_number"),
    hasColumn(auth.admin, "agencies", "pec_email"),
    hasColumn(auth.admin, "agencies", "sdi_code"),
    hasColumn(auth.admin, "agencies", "legal_name"),
    hasColumn(auth.admin, "agencies", "billing_name"),
    hasColumn(auth.admin, "agencies", "notes")
  ]);
  const externalCode = `auth_user:${auth.user.id}`;
  const selectColumns = [
    "id",
    "name",
    supportsLegalName ? "legal_name" : null,
    supportsBillingName ? "billing_name" : null,
    "contact_email",
    "booking_email",
    "phone",
    supportsVatNumber ? "vat_number" : null,
    supportsPecEmail ? "pec_email" : null,
    supportsSdiCode ? "sdi_code" : null,
    supportsNotes ? "notes" : null,
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
      booking_email: auth.user.email,
      notes: ""
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

  return { agency: agencyRow, supportsSetupRequired, supportsVatNumber, supportsPecEmail, supportsSdiCode, supportsLegalName, supportsBillingName, supportsNotes };
}

export async function GET(request: NextRequest) {
  try {
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
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Errore interno." }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
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
    contact_email: parsed.data.contact_email.trim().toLowerCase(),
    booking_email: parsed.data.booking_email.trim().toLowerCase(),
    phone: parsed.data.phone.trim(),
    active: true
  };
  if (resolved.supportsLegalName) updatePayload.legal_name = parsed.data.legal_name.trim();
  if (resolved.supportsBillingName) updatePayload.billing_name = parsed.data.billing_name.trim();
  if (resolved.supportsVatNumber) updatePayload.vat_number = parsed.data.vat_number.trim();
  if (resolved.supportsPecEmail) updatePayload.pec_email = parsed.data.pec_email?.trim().toLowerCase() || null;
  if (resolved.supportsSdiCode) updatePayload.sdi_code = parsed.data.sdi_code?.trim().toUpperCase() || null;
  if (resolved.supportsNotes) updatePayload.notes = parsed.data.notes?.trim() || null;
  if (resolved.supportsSetupRequired) updatePayload.setup_required = false;

  const update = await auth.admin
    .from("agencies")
    .update(updatePayload)
    .eq("tenant_id", auth.membership.tenant_id)
    .eq("id", resolved.agency.id)
    .select(
      [
        "id",
        "name",
        resolved.supportsLegalName ? "legal_name" : null,
        resolved.supportsBillingName ? "billing_name" : null,
        "contact_email",
        "booking_email",
        "phone",
        resolved.supportsVatNumber ? "vat_number" : null,
        resolved.supportsPecEmail ? "pec_email" : null,
        resolved.supportsSdiCode ? "sdi_code" : null,
        resolved.supportsNotes ? "notes" : null,
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
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Errore interno." }, { status: 500 });
  }
}
