import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/server/whatsapp";
import { tenantAccessRequestCreateSchema } from "@/lib/validation";
import { hasDeliverableEmailDomain, isDisposableEmail } from "@/lib/email-validation";

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

  const listedUsers = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (listedUsers.error) {
    return NextResponse.json({ error: listedUsers.error.message }, { status: 500 });
  }

  const existingAuthUser = (listedUsers.data.users ?? []).find((item) => item.email?.trim().toLowerCase() === email) ?? null;

  let userId = existingAuthUser?.id ?? null;
  if (!userId) {
    const userResult = await admin.auth.admin.createUser({
      email,
      password: parsed.data.password,
      email_confirm: true,
      user_metadata: {
        full_name: fullName
      }
    });

    if (userResult.error || !userResult.data.user) {
      return NextResponse.json({ error: userResult.error?.message ?? "Registrazione non riuscita." }, { status: 400 });
    }

    userId = userResult.data.user.id;
  } else {
    const metadataUpdate = await admin.auth.admin.updateUserById(userId, {
      password: parsed.data.password,
      user_metadata: {
        full_name: fullName
      }
    });
    if (metadataUpdate.error) {
      return NextResponse.json({ error: metadataUpdate.error.message }, { status: 500 });
    }
  }

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

  const requestInsert = await admin
    .from("tenant_access_requests")
    .insert({
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
    })
    .select("id")
    .maybeSingle();

  if (requestInsert.error || !requestInsert.data?.id) {
    return NextResponse.json({ error: requestInsert.error?.message ?? "Richiesta accesso non registrata." }, { status: 500 });
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
