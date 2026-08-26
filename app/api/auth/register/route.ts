import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/server/whatsapp";
import { tenantAccessRequestCreateSchema } from "@/lib/validation";
import { hasDeliverableEmailDomain, isDisposableEmail } from "@/lib/email-validation";
import { checkRateLimit, RATE_LIMIT_DEFAULTS, type RateLimitConfig } from "@/lib/server/rate-limit";
import { sendSecurityAlert } from "@/lib/server/security-alert-email";
import { adminGetUserByEmail } from "@/lib/server/admin-user-lookup";
import { sendAccessRequestReceivedEmail } from "@/lib/server/access-request-received-email";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const admin = createAdminClient();
  const parsed = tenantAccessRequestCreateSchema.safeParse(await request.json().catch(() => null));

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Payload non valido." }, { status: 400 });
  }

  const email = parsed.data.email.trim().toLowerCase();
  const fullName = parsed.data.full_name.trim();
  const agencyName = parsed.data.agency_name.trim();
  const ipAddress = request.headers.get("x-forwarded-for") || request.headers.get("x-real-ip") || "unknown";

  // Rate limiting by email
  const rateLimitCheck = await checkRateLimit("register", email, RATE_LIMIT_DEFAULTS.register as RateLimitConfig);
  
  if (!rateLimitCheck.allowed) {
    await sendSecurityAlert({
      type: 'rate_limit_exceeded',
      email,
      ip_address: ipAddress,
      details: { endpoint: '/api/auth/register', attemptCount: RATE_LIMIT_DEFAULTS.register.maxAttempts }
    }).then(() => undefined, () => undefined);
    
    return NextResponse.json(
      { error: "Troppi tentativi di registrazione. Riprova tra 1 ora." },
      { status: 429, headers: { "Retry-After": "3600" } }
    );
  }

  if (isDisposableEmail(email)) {
    return NextResponse.json({ error: "Email temporanea o usa e getta non consentita." }, { status: 400 });
  }

  if (!(await hasDeliverableEmailDomain(email))) {
    return NextResponse.json({ error: "Dominio email non valido o non raggiungibile. Usa un indirizzo valido." }, { status: 400 });
  }
  const existingRequest = await admin
    .from("tenant_access_requests")
    .select("id, status")
    .eq("email", email)
    .is("tenant_id", null)
    .maybeSingle();

  if (existingRequest.error) {
    return NextResponse.json({ error: existingRequest.error.message }, { status: 500 });
  }

  if (existingRequest.data?.id && existingRequest.data.status === "pending") {
    return NextResponse.json({ error: "Esiste gia una richiesta in attesa per questa email." }, { status: 409 });
  }

  // A previously rejected request keeps its row (tenant_id IS NULL) forever
  // because of the unique(user_id) WHERE tenant_id IS NULL index — re-request
  // after rejection must reopen that same row instead of inserting a new one,
  // otherwise the unique index would reject the insert with a false-positive
  // "duplicate request" and lock the user out permanently.
  const reopenRequestId = existingRequest.data?.id && existingRequest.data.status === "rejected" ? existingRequest.data.id : null;

  const { user: existingAuthUser, error: getUserError } = await adminGetUserByEmail(email);
  if (getUserError) {
    return NextResponse.json({ error: getUserError }, { status: 500 });
  }

  let userId = existingAuthUser?.id ?? null;
  let userCreatedInThisRequest = false;

  // Check membership BEFORE touching auth.users — prevents password overwrite on existing accounts
  if (userId) {
    const existingMembership = await admin
      .from("memberships")
      .select("user_id")
      .eq("user_id", userId)
      .limit(1)
      .maybeSingle();

    if (existingMembership.error) {
      return NextResponse.json({ error: existingMembership.error.message }, { status: 500 });
    }

    if (existingMembership.data?.user_id) {
      return NextResponse.json({ error: "Questo utente ha gia almeno un accesso attivo." }, { status: 409 });
    }

    // User exists but no membership (e.g. re-registering after rejection).
    // Update only metadata — never overwrite the password of an existing account.
    const metadataUpdate = await admin.auth.admin.updateUserById(userId, {
      user_metadata: { full_name: fullName }
    });
    if (metadataUpdate.error) {
      return NextResponse.json({ error: metadataUpdate.error.message }, { status: 500 });
    }
  } else {
    const userResult = await admin.auth.admin.createUser({
      email,
      password: parsed.data.password,
      email_confirm: true,
      user_metadata: { full_name: fullName }
    });

    if (userResult.error || !userResult.data.user) {
      return NextResponse.json({ error: userResult.error?.message ?? "Registrazione non riuscita." }, { status: 400 });
    }

    userId = userResult.data.user.id;
    userCreatedInThisRequest = true;
  }

  const requestPersistPayload = {
    tenant_id: null,
    user_id: userId,
    email,
    full_name: fullName,
    agency_name: agencyName,
    requested_role: parsed.data.requested_role ?? null,
    status: "pending",
    review_notes: null,
    reviewed_by_user_id: null,
    reviewed_at: null
  };

  const requestInsert = reopenRequestId
    ? await admin
        .from("tenant_access_requests")
        .update(requestPersistPayload)
        .eq("id", reopenRequestId)
        .select("id")
        .maybeSingle()
    : await admin
        .from("tenant_access_requests")
        .insert(requestPersistPayload)
        .select("id")
        .maybeSingle();

  if (requestInsert.error || !requestInsert.data?.id) {
    // 23505 = unique_violation (race condition: another request for the same
    // user landed between our pre-check SELECT and this INSERT).
    const isDuplicate = requestInsert.error?.code === "23505";

    if (userCreatedInThisRequest) {
      const deleteResult = await admin.auth.admin.deleteUser(userId!);
      console.error(
        `[auth/register] rollback: deleting orphaned auth user ${userId} after tenant_access_requests insert failure`,
        requestInsert.error?.message,
        deleteResult.error ? `rollback delete also failed: ${deleteResult.error.message}` : "rollback delete ok"
      );
    }

    await admin
      .from("auth_audit_log")
      .insert({
        user_id: userCreatedInThisRequest ? null : userId,
        event_type: "register",
        status: "failed",
        ip_address: ipAddress,
        details: {
          email,
          full_name: fullName,
          error: requestInsert.error?.message,
          rolled_back_auth_user: userCreatedInThisRequest
        }
      })
      .then(() => undefined, () => undefined);

    if (isDuplicate) {
      return NextResponse.json({ error: "Esiste gia una richiesta in attesa per questa email." }, { status: 409 });
    }

    return NextResponse.json({ error: requestInsert.error?.message ?? "Richiesta accesso non registrata." }, { status: 500 });
  }

  await admin
    .from("auth_audit_log")
    .insert({
      user_id: userId,
      event_type: "register",
      status: "success",
      ip_address: ipAddress,
      details: { email, full_name: fullName, agency_name: agencyName }
    })
    .then(() => undefined, () => undefined);

  // Best-effort: a broken email provider must never fail an otherwise valid
  // registration — the pending request is already persisted at this point.
  try {
    const receivedEmailResult = await sendAccessRequestReceivedEmail({ to: email, fullName, agencyName });
    if (receivedEmailResult.status === "failed") {
      console.error(`[auth/register] richiesta ricevuta email fallita per ${email}: ${receivedEmailResult.error}`);
    }
  } catch (error) {
    console.error(`[auth/register] richiesta ricevuta email eccezione per ${email}:`, error);
  }

  return NextResponse.json(
    {
      ok: true,
      request_id: requestInsert.data.id,
      message: "Registrazione inviata. Un admin vedra la tua richiesta e la assocera all'agenzia corretta."
    },
    { status: 201 }
  );
}
