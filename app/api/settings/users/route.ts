import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/server/whatsapp";
import { sendAccessApprovalEmail } from "@/lib/server/access-approval-email";
import { sendPasswordResetEmail } from "@/lib/server/password-reset-email";
import { capabilityRoleMap, type AppCapability } from "@/lib/rbac";
import { resolvePreferredMembership } from "@/lib/tenant-preference";
import type { UserRole } from "@/lib/types";
import {
  adminRoleCapabilityOverrideSchema,
  adminUserCreateSchema,
  adminUserUpdateSchema,
  tenantAccessRequestReviewSchema
} from "@/lib/validation";

export const runtime = "nodejs";

type TenantMembershipRow = {
  user_id: string;
  tenant_id: string;
  agency_id?: string | null;
  role: "admin" | "operator" | "driver" | "agency";
  full_name: string;
  created_at?: string | null;
  suspended?: boolean;
};

type CapabilityOverrideRow = {
  id: string;
  tenant_id: string;
  role: "admin" | "operator" | "driver" | "agency";
  capability: AppCapability;
  enabled: boolean;
  created_at?: string | null;
  updated_at?: string | null;
};

type AccessRequestRow = {
  id: string;
  tenant_id: string | null;
  user_id: string;
  email: string;
  full_name: string;
  agency_name?: string | null;
  requested_role?: "admin" | "operator" | "driver" | "agency" | null;
  status: "pending" | "approved" | "rejected";
  created_at?: string | null;
  review_notes?: string | null;
};

async function hasColumn(admin: ReturnType<typeof createAdminClient>, table: string, column: string) {
  const { error } = await admin.from(table).select(column).limit(1);
  if (!error) return true;
  if ((error as { code?: string }).code === "42703") return false;
  throw new Error(`Schema probe failed for ${table}.${column}: ${error.message}`);
}

async function requireAdminMembership(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch {
    return { error: NextResponse.json({ error: "Server env missing" }, { status: 500 }) };
  }

  const token = authHeader.slice("Bearer ".length);
  const {
    data: { user },
    error: authError
  } = await admin.auth.getUser(token);
  if (authError || !user) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  const { data: memberships, error: membershipError } = await admin
    .from("memberships")
    .select("tenant_id, role, full_name, suspended")
    .eq("user_id", user.id);

  const membershipRows = (memberships ?? []) as Array<{ tenant_id: string; role: UserRole; full_name: string; suspended?: boolean | null }>;
  const membership = resolvePreferredMembership(membershipRows);

  if (membershipError || !membership?.tenant_id) {
    return { error: NextResponse.json({ error: "Tenant not found" }, { status: 404 }) };
  }

  if (membership.role !== "admin") {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }

  if (membership.suspended === true) {
    return { error: NextResponse.json({ error: "Membership suspended" }, { status: 403 }) };
  }

  return { admin, membership, actorUserId: user.id };
}

export async function GET(request: NextRequest) {
  const auth = await requireAdminMembership(request);
  if ("error" in auth) return auth.error;

  const { data, error } = await auth.admin
    .from("memberships")
    .select("user_id, tenant_id, agency_id, role, full_name, created_at, suspended")
    .eq("tenant_id", auth.membership.tenant_id)
    .order("created_at", { ascending: true });

  if (error) {
    return NextResponse.json({ error: "Failed to load users" }, { status: 500 });
  }

  const memberships = ((data ?? []) as TenantMembershipRow[]).map((item) => ({
    user_id: item.user_id,
    tenant_id: item.tenant_id,
    agency_id: item.agency_id ?? null,
    role: item.role,
    full_name: item.full_name,
    created_at: item.created_at ?? null,
    suspended: item.suspended ?? false
  }));

  const { data: capabilityOverrides, error: capabilityOverridesError } = await auth.admin
    .from("role_capability_overrides")
    .select("id, tenant_id, role, capability, enabled, created_at, updated_at")
    .eq("tenant_id", auth.membership.tenant_id)
    .order("created_at", { ascending: true });

  if (capabilityOverridesError) {
    return NextResponse.json({ error: "Failed to load capability overrides" }, { status: 500 });
  }

  const { data: pendingRequests, error: pendingRequestsError } = await auth.admin
    .from("tenant_access_requests")
    .select("id, tenant_id, user_id, email, full_name, agency_name, requested_role, status, created_at, review_notes")
    .or(`tenant_id.eq.${auth.membership.tenant_id},tenant_id.is.null`)
    .eq("status", "pending")
    .order("created_at", { ascending: true });

  if (pendingRequestsError) {
    return NextResponse.json({ error: "Failed to load pending access requests" }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    memberships,
    role_capability_overrides: (capabilityOverrides ?? []) as CapabilityOverrideRow[],
    pending_access_requests: (pendingRequests ?? []) as AccessRequestRow[]
  });
}

export async function POST(request: NextRequest) {
  const auth = await requireAdminMembership(request);
  if ("error" in auth) return auth.error;

  const parsed = adminUserCreateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid payload" }, { status: 400 });
  }

  const email = parsed.data.email.trim().toLowerCase();
  const fullName = parsed.data.full_name.trim();

  const existingMembership = await auth.admin
    .from("memberships")
    .select("user_id")
    .eq("tenant_id", auth.membership.tenant_id)
    .ilike("full_name", fullName)
    .limit(1)
    .maybeSingle();

  if (existingMembership.error) {
    return NextResponse.json({ error: "Failed to validate user uniqueness" }, { status: 500 });
  }

  if (existingMembership.data?.user_id) {
    return NextResponse.json({ error: "Esiste gia un utente con questo nome nel tenant." }, { status: 409 });
  }

  const gender = typeof (parsed.data as Record<string, unknown>).gender === "string"
    ? (parsed.data as Record<string, unknown>).gender as string
    : null;

  const userResult = await auth.admin.auth.admin.createUser({
    email,
    password: parsed.data.password,
    email_confirm: true,
    user_metadata: {
      full_name: fullName,
      ...(gender ? { gender } : {})
    }
  });

  if (userResult.error || !userResult.data.user) {
    return NextResponse.json({ error: userResult.error?.message ?? "Creazione utente fallita." }, { status: 400 });
  }

  const newUserId = userResult.data.user.id;
  let createdAgencyId: string | null = null;
  if (parsed.data.role === "agency") {
    const supportsSetupRequired = await hasColumn(auth.admin, "agencies", "setup_required");
    const agencyInsertPayload: Record<string, unknown> = {
      tenant_id: auth.membership.tenant_id,
      name: fullName,
      external_code: `auth_user:${newUserId}`,
      active: true,
      contact_email: email,
      booking_email: email
    };
    if (supportsSetupRequired) {
      agencyInsertPayload.setup_required = true;
    }
    const agencyInsert = await auth.admin.from("agencies").insert(agencyInsertPayload).select("id").maybeSingle();
    if (agencyInsert.error || !agencyInsert.data?.id) {
      await auth.admin.auth.admin.deleteUser(newUserId).catch(() => undefined);
      return NextResponse.json({ error: agencyInsert.error?.message ?? "Creazione agenzia fallita." }, { status: 500 });
    }
    createdAgencyId = agencyInsert.data.id;
  }

  const membershipInsert = await auth.admin.from("memberships").insert({
    user_id: newUserId,
    tenant_id: auth.membership.tenant_id,
    agency_id: parsed.data.role === "agency" ? createdAgencyId : null,
    role: parsed.data.role,
    full_name: fullName
  });

  if (membershipInsert.error) {
    await auth.admin.auth.admin.deleteUser(newUserId).catch(() => undefined);
    return NextResponse.json({ error: membershipInsert.error.message }, { status: 500 });
  }

  return NextResponse.json(
    {
      ok: true,
      user: {
        user_id: newUserId,
        tenant_id: auth.membership.tenant_id,
        role: parsed.data.role,
        full_name: fullName,
        email
      }
    },
    { status: 201 }
  );
}

export async function PATCH(request: NextRequest) {
  const auth = await requireAdminMembership(request);
  if ("error" in auth) return auth.error;

  const rawBody = await request.json().catch(() => null);

  if (
    rawBody &&
    typeof rawBody === "object" &&
    "action" in rawBody &&
    rawBody.action === "send_reset_password_email" &&
    typeof rawBody.user_id === "string" &&
    rawBody.user_id.trim()
  ) {
    const userId = rawBody.user_id.trim();

    const membershipLookup = await auth.admin
      .from("memberships")
      .select("user_id, full_name")
      .eq("tenant_id", auth.membership.tenant_id)
      .eq("user_id", userId)
      .maybeSingle();

    if (membershipLookup.error || !membershipLookup.data?.user_id) {
      return NextResponse.json({ error: "Utente non trovato nel tenant." }, { status: 404 });
    }

    const userResult = await auth.admin.auth.admin.getUserById(userId);
    const targetEmail = userResult.data.user?.email ?? null;
    if (userResult.error || !targetEmail) {
      return NextResponse.json({ error: userResult.error?.message ?? "Email utente non disponibile." }, { status: 400 });
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim() || request.nextUrl.origin;
    const redirectTo = `${appUrl.replace(/\/$/, "")}/auth/update-password`;
    const linkResult = await auth.admin.auth.admin.generateLink({
      type: "recovery",
      email: targetEmail,
      options: {
        redirectTo
      }
    });

    const resetUrl = linkResult.data?.properties?.action_link ?? null;
    if (linkResult.error || !resetUrl) {
      return NextResponse.json({ error: linkResult.error?.message ?? "Generazione link reset fallita." }, { status: 500 });
    }

    const emailResult = await sendPasswordResetEmail({
      to: targetEmail,
      fullName: membershipLookup.data.full_name,
      resetUrl
    });

    if (emailResult.status === "failed") {
      return NextResponse.json({ error: emailResult.error ?? "Invio email reset fallito." }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      reset_email: {
        user_id: userId,
        email: targetEmail,
        status: emailResult.status
      }
    });
  }

  const capabilityParsed = adminRoleCapabilityOverrideSchema.safeParse(rawBody);
  if (capabilityParsed.success) {
    const { role, capability, enabled } = capabilityParsed.data;
    if (!(capability in capabilityRoleMap)) {
      return NextResponse.json({ error: "Capability non riconosciuta." }, { status: 400 });
    }
    if (role === "agency") {
      return NextResponse.json(
        { error: "Il ruolo agenzia ha accesso solo a Prenotazioni agenzia e non puo ricevere altri permessi da questa schermata." },
        { status: 400 }
      );
    }

    const { error: upsertError } = await auth.admin
      .from("role_capability_overrides")
      .upsert(
        {
          tenant_id: auth.membership.tenant_id,
          role,
          capability,
          enabled
        },
        { onConflict: "tenant_id,role,capability" }
      );

    if (upsertError) {
      return NextResponse.json({ error: upsertError.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, override: { role, capability, enabled } });
  }

  const accessRequestParsed = tenantAccessRequestReviewSchema.safeParse(rawBody);
  if (accessRequestParsed.success) {
    const { request_id, action, review_notes } = accessRequestParsed.data;
    const { data: requestRow, error: requestLookupError } = await auth.admin
      .from("tenant_access_requests")
      .select("id, tenant_id, user_id, email, full_name, agency_name, requested_role, status")
      .eq("id", request_id)
      .maybeSingle();

    if (requestLookupError || !requestRow?.id) {
      return NextResponse.json({ error: "Richiesta accesso non trovata." }, { status: 404 });
    }
    if (requestRow.tenant_id && requestRow.tenant_id !== auth.membership.tenant_id) {
      return NextResponse.json({ error: "Richiesta associata a un altro tenant." }, { status: 403 });
    }

    if (requestRow.status !== "pending") {
      return NextResponse.json({ error: "La richiesta non e piu in stato pending." }, { status: 400 });
    }

    if (action === "reject") {
      const rejectUpdate = await auth.admin
        .from("tenant_access_requests")
        .update({
          tenant_id: requestRow.tenant_id ?? auth.membership.tenant_id,
          status: "rejected",
          review_notes: review_notes?.trim() || null,
          reviewed_by_user_id: auth.actorUserId,
          reviewed_at: new Date().toISOString()
        })
        .eq("id", request_id)
        .select("id")
        .maybeSingle();

      if (rejectUpdate.error || !rejectUpdate.data?.id) {
        return NextResponse.json({ error: rejectUpdate.error?.message ?? "Rifiuto richiesta fallito." }, { status: 500 });
      }

      return NextResponse.json({ ok: true, request: { id: request_id, status: "rejected" } });
    }

    const approvedRole = accessRequestParsed.data.role ?? requestRow.requested_role ?? "operator";
    let approvedAgencyId: string | null = null;
    if (approvedRole === "agency") {
      const supportsSetupRequired = await hasColumn(auth.admin, "agencies", "setup_required");
      const externalCode = `auth_user:${requestRow.user_id}`;
      const { data: existingAgency, error: existingAgencyError } = await auth.admin
        .from("agencies")
        .select("id")
        .eq("tenant_id", auth.membership.tenant_id)
        .eq("external_code", externalCode)
        .maybeSingle();

      if (existingAgencyError) {
        return NextResponse.json({ error: existingAgencyError.message }, { status: 500 });
      }

      if (!existingAgency?.id) {
        const agencyInsertPayload: Record<string, unknown> = {
          tenant_id: auth.membership.tenant_id,
          name: requestRow.agency_name?.trim() || requestRow.full_name,
          external_code: externalCode,
          active: true,
          contact_email: requestRow.email,
          booking_email: requestRow.email
        };
        if (supportsSetupRequired) {
          agencyInsertPayload.setup_required = true;
        }
        const agencyInsert = await auth.admin.from("agencies").insert(agencyInsertPayload).select("id").maybeSingle();
        if (agencyInsert.error || !agencyInsert.data?.id) {
          return NextResponse.json({ error: agencyInsert.error?.message ?? "Creazione anagrafica agenzia fallita." }, { status: 500 });
        }
        approvedAgencyId = agencyInsert.data.id;
      } else if (supportsSetupRequired) {
        const agencyUpdate = await auth.admin
          .from("agencies")
          .update({
            name: requestRow.agency_name?.trim() || requestRow.full_name,
            contact_email: requestRow.email,
            booking_email: requestRow.email,
            setup_required: true
          })
          .eq("tenant_id", auth.membership.tenant_id)
          .eq("id", existingAgency.id);
        if (agencyUpdate.error) {
          return NextResponse.json({ error: agencyUpdate.error.message }, { status: 500 });
        }
        approvedAgencyId = existingAgency.id;
      } else {
        approvedAgencyId = existingAgency.id;
      }
    }

    const existingMembership = await auth.admin
      .from("memberships")
      .select("user_id")
      .eq("tenant_id", auth.membership.tenant_id)
      .eq("user_id", requestRow.user_id)
      .maybeSingle();

    if (existingMembership.error) {
      return NextResponse.json({ error: existingMembership.error.message }, { status: 500 });
    }

    if (!existingMembership.data?.user_id) {
      const membershipInsert = await auth.admin.from("memberships").insert({
        user_id: requestRow.user_id,
        tenant_id: auth.membership.tenant_id,
        agency_id: approvedRole === "agency" ? approvedAgencyId : null,
        role: approvedRole,
        full_name: requestRow.full_name,
        suspended: false
      });
      if (membershipInsert.error) {
        return NextResponse.json({ error: membershipInsert.error.message }, { status: 500 });
      }
    } else {
      const membershipUpdate = await auth.admin
        .from("memberships")
        .update({
          agency_id: approvedRole === "agency" ? approvedAgencyId : null,
          role: approvedRole,
          full_name: requestRow.full_name,
          suspended: false
        })
        .eq("tenant_id", auth.membership.tenant_id)
        .eq("user_id", requestRow.user_id);
      if (membershipUpdate.error) {
        return NextResponse.json({ error: membershipUpdate.error.message }, { status: 500 });
      }
    }

    const approvalUpdate = await auth.admin
      .from("tenant_access_requests")
      .update({
        tenant_id: auth.membership.tenant_id,
        status: "approved",
        requested_role: approvedRole,
        review_notes: review_notes?.trim() || null,
        reviewed_by_user_id: auth.actorUserId,
        reviewed_at: new Date().toISOString()
      })
      .eq("id", request_id)
      .select("id")
      .maybeSingle();

    if (approvalUpdate.error || !approvalUpdate.data?.id) {
      return NextResponse.json({ error: approvalUpdate.error?.message ?? "Approvazione richiesta fallita." }, { status: 500 });
    }
    await sendAccessApprovalEmail({
      to: requestRow.email,
      fullName: requestRow.full_name,
      role: approvedRole,
      agencyName: requestRow.agency_name ?? null
    }).catch(() => undefined);

    return NextResponse.json({
      ok: true,
      approved_request: {
        id: request_id,
        user_id: requestRow.user_id,
        tenant_id: auth.membership.tenant_id,
        full_name: requestRow.full_name,
        email: requestRow.email,
        role: approvedRole
      }
    });
  }

  const parsed = adminUserUpdateSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid payload" }, { status: 400 });
  }

  if (parsed.data.user_id === auth.actorUserId && parsed.data.role !== "admin") {
    return NextResponse.json({ error: "Non puoi togliere a te stesso il ruolo admin da questa schermata." }, { status: 400 });
  }

  const shouldSuspend = parsed.data.suspended === true;
  if (parsed.data.user_id === auth.actorUserId && shouldSuspend) {
    return NextResponse.json({ error: "Non puoi sospendere il tuo stesso accesso tenant." }, { status: 400 });
  }

  const updateResult = await auth.admin
    .from("memberships")
    .update({
      full_name: parsed.data.full_name.trim(),
      agency_id: parsed.data.role === "agency" ? undefined : null,
      role: parsed.data.role,
      suspended: shouldSuspend
    })
    .eq("tenant_id", auth.membership.tenant_id)
    .eq("user_id", parsed.data.user_id)
    .select("user_id, tenant_id, agency_id, role, full_name, created_at, suspended")
    .maybeSingle();

  if (updateResult.error || !updateResult.data) {
    return NextResponse.json({ error: updateResult.error?.message ?? "Aggiornamento utente fallito." }, { status: 500 });
  }

  const updateGender = typeof (parsed.data as Record<string, unknown>).gender === "string"
    ? (parsed.data as Record<string, unknown>).gender as string
    : null;

  const metadataPatch: Record<string, string> = { full_name: parsed.data.full_name.trim() };
  if (updateGender) metadataPatch.gender = updateGender;

  if (parsed.data.password) {
    const passwordUpdate = await auth.admin.auth.admin.updateUserById(parsed.data.user_id, {
      password: parsed.data.password,
      user_metadata: metadataPatch
    });
    if (passwordUpdate.error) {
      return NextResponse.json({ error: passwordUpdate.error.message }, { status: 500 });
    }
  } else {
    await auth.admin.auth.admin
      .updateUserById(parsed.data.user_id, { user_metadata: metadataPatch })
      .catch(() => undefined);
  }

  return NextResponse.json({ ok: true, user: { ...updateResult.data, suspended: updateResult.data.suspended ?? shouldSuspend } });
}

export async function DELETE(request: NextRequest) {
  const auth = await requireAdminMembership(request);
  if ("error" in auth) return auth.error;

  const url = new URL(request.url);
  const userId = url.searchParams.get("user_id")?.trim();
  if (!userId) {
    return NextResponse.json({ error: "user_id mancante." }, { status: 400 });
  }

  if (userId === auth.actorUserId) {
    return NextResponse.json({ error: "Non puoi eliminare il tuo stesso utente admin." }, { status: 400 });
  }

  const membershipLookup = await auth.admin
    .from("memberships")
    .select("user_id, full_name")
    .eq("tenant_id", auth.membership.tenant_id)
    .eq("user_id", userId)
    .maybeSingle();

  if (membershipLookup.error || !membershipLookup.data?.user_id) {
    return NextResponse.json({ error: "Utente non trovato nel tenant." }, { status: 404 });
  }

  const membershipDelete = await auth.admin
    .from("memberships")
    .delete()
    .eq("tenant_id", auth.membership.tenant_id)
    .eq("user_id", userId);

  if (membershipDelete.error) {
    return NextResponse.json({ error: membershipDelete.error.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    deleted_user_id: userId,
    deleted_full_name: membershipLookup.data.full_name
  });
}
