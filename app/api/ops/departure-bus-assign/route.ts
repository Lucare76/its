import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { ensureDriverProfileForMembership, reserveMembershipUsername } from "@/lib/server/driver-registry";
import { sendPushToUser } from "@/lib/server/web-push";
import { auditLog } from "@/lib/server/ops-audit";
import { validateDriverGeographicBatch, type TripGeoServiceRow } from "@/lib/server/geo-assignment";

export const runtime = "nodejs";

function makeAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/^["']|["']$/g, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim().replace(/^["']|["']$/g, "");
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

// ── Verifica che tutti i service_ids appartengano al tenant autenticato ──────
// Guardia anti-IDOR (SEC-01): un service_id non appartenente al tenant o
// inesistente produce la stessa risposta 404 generica, senza rivelare quale
// dei due casi si sia verificato. Un errore nella query stessa è fail-closed
// (500, nessuna scrittura). Deve essere chiamata prima di qualsiasi DELETE/INSERT.
type OwnershipCheckResult = { ok: true } | { ok: false; response: NextResponse };

async function verifyServicesBelongToTenant(
  admin: SupabaseClient,
  tenantId: string,
  uniqueServiceIds: string[],
  context: { userId: string; action: string }
): Promise<OwnershipCheckResult> {
  const { data: ownedServices, error: ownedServicesError } = await admin
    .from("services")
    .select("id")
    .eq("tenant_id", tenantId)
    .in("id", uniqueServiceIds);

  if (ownedServicesError) {
    auditLog({
      event: "departure_bus_assign_service_ownership_check_failed",
      level: "error",
      tenantId,
      userId: context.userId,
      details: {
        action: context.action,
        serviceCount: uniqueServiceIds.length,
        error: ownedServicesError.message,
      },
    });
    return {
      ok: false,
      response: NextResponse.json({ ok: false, error: "Errore durante la verifica dei servizi." }, { status: 500 }),
    };
  }

  if ((ownedServices?.length ?? 0) !== uniqueServiceIds.length) {
    auditLog({
      event: "departure_bus_assign_failed",
      level: "warn",
      tenantId,
      userId: context.userId,
      details: {
        action: context.action,
        serviceCount: uniqueServiceIds.length,
        reason: "service_ownership_mismatch",
      },
    });
    return {
      ok: false,
      response: NextResponse.json({ ok: false, error: "Uno o più servizi non trovati." }, { status: 404 }),
    };
  }

  return { ok: true };
}

// ── SEC-05 residuo: verifica che driver_user_id ricevuto dal client
// appartenga al tenant autenticato e abbia una membership con role="driver",
// prima di scrivere l'assignment. La route usa il client service-role
// (bypassa RLS): il controllo va fatto qui, come già fatto in assign-service.
// Salta il controllo solo se driverUserId è assente (qui non può succedere:
// assign_driver lo richiede a monte, ma l'helper resta difensivo). Stessa
// risposta 404 generica per driver inesistente, di altro tenant, o utente
// esistente ma senza membership "driver" — non deve rivelare quale caso si
// sia verificato. Errore di query è fail-closed (500). Non verifica lo stato
// sospeso/attivo del driver (FUNC-03, fuori scope) né driver_profile_id
// (questa route non lo usa).
async function verifyDriverBelongsToTenant(
  admin: SupabaseClient,
  tenantId: string,
  driverUserId: string | null | undefined,
  context: { actorUserId?: string; action: string }
): Promise<{ ok: true } | { ok: false; response: NextResponse }> {
  if (!driverUserId) return { ok: true };

  const { data, error } = await admin
    .from("memberships")
    .select("user_id")
    .eq("tenant_id", tenantId)
    .eq("user_id", driverUserId)
    .eq("role", "driver")
    .maybeSingle();

  if (error) {
    auditLog({
      event: "departure_bus_assign_driver_verification_failed",
      level: "error",
      tenantId,
      userId: context.actorUserId ?? null,
      details: { action: context.action, dbCode: (error as { code?: string }).code ?? null },
    });
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, error: "DRIVER_VERIFICATION_FAILED", message: "Errore durante la verifica dell'autista." },
        { status: 500 }
      ),
    };
  }

  if (!data?.user_id) {
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, error: "DRIVER_NOT_FOUND", message: "Autista non trovato." },
        { status: 404 }
      ),
    };
  }

  return { ok: true };
}

// ── GET — lista autisti con stato account ─────────────────────────────────────

export async function GET(req: NextRequest) {
  try {
    const auth = await authorizePricingRequest(req, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;
    const tenantId = auth.membership.tenant_id;

    const [profilesRes, membershipsRes] = await Promise.all([
      auth.admin
        .from("driver_profiles")
        .select("id,full_name,phone,user_id")
        .eq("tenant_id", tenantId)
        .eq("active", true)
        .order("full_name"),
      auth.admin
        .from("memberships")
        .select("user_id,full_name")
        .eq("tenant_id", tenantId)
        .eq("role", "driver"),
    ]);

    const profiles = (profilesRes.data ?? []) as Array<{ id: string; full_name: string; phone: string | null; user_id: string | null }>;
    const memberships = (membershipsRes.data ?? []) as Array<{ user_id: string; full_name: string }>;

    const membershipByUserId = new Map(memberships.map((m) => [m.user_id, m]));
    const membershipByName = new Map(memberships.map((m) => [m.full_name.toLowerCase().trim(), m]));

    const drivers = profiles.map((p) => {
      const match = (p.user_id ? membershipByUserId.get(p.user_id) : null) ?? membershipByName.get(p.full_name.toLowerCase().trim());
      return {
        profile_id: p.id,
        full_name: p.full_name,
        phone: p.phone ?? null,
        user_id: match?.user_id ?? null,
        has_account: !!match,
      };
    });

    return NextResponse.json({ ok: true, drivers });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Errore" }, { status: 500 });
  }
}

// ── POST ──────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const auth = await authorizePricingRequest(req, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;
    const tenantId = auth.membership.tenant_id;

    const body = (await req.json()) as Record<string, unknown>;
    const action = body.action as string;

    // ── Crea account driver ───────────────────────────────────────────────────
    if (action === "create_driver_account") {
      const profileId = body.driver_profile_id as string;
      const email = (body.email as string | undefined)?.trim().toLowerCase();
      const phone = (body.phone as string | undefined)?.trim() ?? "";

      if (!profileId || !email) {
        return NextResponse.json({ ok: false, error: "driver_profile_id e email richiesti" }, { status: 400 });
      }

      const { data: profile, error: profileErr } = await auth.admin
        .from("driver_profiles")
        .select("id,full_name")
        .eq("id", profileId)
        .eq("tenant_id", tenantId)
        .maybeSingle();

      if (profileErr || !profile) {
        return NextResponse.json({ ok: false, error: "Profilo autista non trovato" }, { status: 404 });
      }

      const adminClient = makeAdminClient();
      if (!adminClient) {
        return NextResponse.json({ ok: false, error: "Configurazione server mancante" }, { status: 500 });
      }

      const password = phone.replace(/\s/g, "") || randomBytes(8).toString("hex");

      const { data: newUser, error: createErr } = await adminClient.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: {
          full_name: (profile as { id: string; full_name: string }).full_name,
          force_password_change: true,
          password_change_required: true,
        },
      });

      if (createErr || !newUser.user) {
        return NextResponse.json(
          { ok: false, error: createErr?.message ?? "Creazione utente fallita" },
          { status: 500 }
        );
      }

      const { error: membershipErr } = await adminClient.from("memberships").insert({
        user_id: newUser.user.id,
        tenant_id: tenantId,
        role: "driver",
        full_name: (profile as { id: string; full_name: string }).full_name,
        username: await reserveMembershipUsername(adminClient, {
          preferredUsername: (profile as { id: string; full_name: string }).full_name,
        }),
      });

      if (membershipErr) {
        await adminClient.auth.admin.deleteUser(newUser.user.id);
        return NextResponse.json({ ok: false, error: membershipErr.message }, { status: 500 });
      }

      await ensureDriverProfileForMembership(adminClient, {
        tenantId,
        userId: newUser.user.id,
        fullName: (profile as { id: string; full_name: string }).full_name,
      });

      return NextResponse.json({ ok: true, user_id: newUser.user.id });
    }

    // ── Assegna autista al gruppo bus ─────────────────────────────────────────
    if (action === "assign_driver") {
      const serviceIds = body.service_ids as string[];
      const driverUserId = body.driver_user_id as string;
      const vehicleLabel = body.vehicle_label as string;

      if (!serviceIds?.length || !driverUserId || !vehicleLabel) {
        return NextResponse.json(
          { ok: false, error: "service_ids, driver_user_id e vehicle_label richiesti" },
          { status: 400 }
        );
      }

      const uniqueServiceIds = [...new Set(serviceIds)];
      const ownership = await verifyServicesBelongToTenant(auth.admin, tenantId, uniqueServiceIds, {
        userId: auth.user.id,
        action: "assign_driver",
      });
      if (!ownership.ok) return ownership.response;

      // SEC-05 residuo: verifica ownership tenant + ruolo driver, prima di
      // qualunque caricamento dati operativo o scrittura successiva.
      const driverOwnership = await verifyDriverBelongsToTenant(auth.admin, tenantId, driverUserId, {
        actorUserId: auth.user.id,
        action: "assign_driver",
      });
      if (!driverOwnership.ok) return driverOwnership.response;

      // ── FUNC-01: caricamento dati operativi del batch (data, orario, geografia) ──
      const { data: batchServicesData, error: batchServicesError } = await auth.admin
        .from("services")
        .select("id, date, time, pickup_hotel, direction, hotel_id, meeting_point")
        .eq("tenant_id", tenantId)
        .in("id", uniqueServiceIds);

      if (batchServicesError) {
        auditLog({
          event: "departure_bus_assign_services_load_failed",
          level: "error",
          tenantId,
          userId: auth.user.id,
          details: { action: "assign_driver", error: batchServicesError.message },
        });
        return NextResponse.json({ ok: false, error: "Errore durante il caricamento dei servizi." }, { status: 500 });
      }

      const batchServices = (batchServicesData ?? []) as Array<TripGeoServiceRow & { date: string }>;
      if (batchServices.length !== uniqueServiceIds.length) {
        return NextResponse.json({ ok: false, error: "Uno o più servizi non trovati." }, { status: 404 });
      }

      // ── FUNC-01: disponibilità giornaliera confermata per tutte le date del batch ──
      const uniqueDates = [...new Set(batchServices.map((s) => s.date))];
      const { data: confirmations, error: confirmationsError } = await auth.admin
        .from("daily_availability_confirmations")
        .select("date, confirmed")
        .eq("tenant_id", tenantId)
        .in("date", uniqueDates);

      if (confirmationsError) {
        auditLog({
          event: "departure_bus_assign_availability_check_failed",
          level: "error",
          tenantId,
          userId: auth.user.id,
          details: { action: "assign_driver", error: confirmationsError.message },
        });
        return NextResponse.json({ ok: false, error: "Errore durante la verifica della disponibilità." }, { status: 500 });
      }

      const confirmedDates = new Set(
        (confirmations ?? []).filter((c) => c.confirmed).map((c) => c.date as string)
      );
      const allDatesConfirmed = uniqueDates.every((d) => confirmedDates.has(d));
      if (!allDatesConfirmed) {
        auditLog({
          event: "departure_bus_assign_failed",
          level: "warn",
          tenantId,
          userId: auth.user.id,
          details: { action: "assign_driver", reason: "daily_availability_not_confirmed" },
        });
        return NextResponse.json(
          {
            ok: false,
            error: "DAILY_AVAILABILITY_NOT_CONFIRMED",
            message: "La disponibilità giornaliera non è stata ancora confermata.",
          },
          { status: 409 }
        );
      }

      // ── FUNC-01: validazione geografica del batch come unico giro bus ──────────
      const geoValidation = await validateDriverGeographicBatch(auth.admin, tenantId, driverUserId, batchServices);
      if (!geoValidation.ok) {
        if (geoValidation.kind === "query_error") {
          auditLog({
            event: "departure_bus_assign_geo_check_failed",
            level: "error",
            tenantId,
            userId: auth.user.id,
            details: { action: "assign_driver", error: geoValidation.error },
          });
          return NextResponse.json({ ok: false, error: "Errore durante la verifica geografica." }, { status: 500 });
        }
        auditLog({
          event: "departure_bus_assign_failed",
          level: "warn",
          tenantId,
          userId: auth.user.id,
          details: { action: "assign_driver", reason: "geographic_conflict" },
        });
        return NextResponse.json(
          {
            ok: false,
            error: "DRIVER_GEOGRAPHIC_CONFLICT",
            message: "L'autista ha un altro servizio incompatibile con questo gruppo bus.",
          },
          { status: 409 }
        );
      }

      // RACE-01: upsert al posto di DELETE+INSERT. Con due richieste concorrenti
      // sullo stesso batch, il DELETE dell'una poteva cancellare silenziosamente
      // la riga appena scritta dall'altra (lost update, nessun errore visibile).
      // L'upsert scrive una sola riga per service_id in un solo statement atomico
      // sul vincolo unique assignments_service_tenant_unique (service_id, tenant_id)
      // — introdotto in 0137 proprio per supportare upsert — eliminando del tutto
      // la finestra di race: ogni riga esiste sempre, mai zero righe, mai duplicati.
      //
      // Semantica upsert (post RACE-01 fix): a differenza del vecchio DELETE+INSERT,
      // un upsert aggiorna solo le colonne presenti nel payload — quelle omesse
      // sopravvivono invariate sulla riga già esistente. Il vecchio DELETE+INSERT
      // azzerava invece sempre driver_profile_id/group_id/assignment_source/
      // locked_by_operator/assigned_by/assigned_at/lock_reason (mai valorizzati
      // nell'INSERT, quindi sempre a NULL/default su ogni nuova riga). Per
      // replicare esattamente quel comportamento senza perdere l'atomicità,
      // questi campi vanno esplicitati qui: null/false replicano il default
      // storico (nessun valore nuovo "manual_dispatch" introdotto, non supportato
      // altrove nel dominio), mentre assigned_by/assigned_at registrano l'attore
      // e l'istante di questa specifica riassegnazione manuale.
      const now = new Date().toISOString();
      const { error: upsertErr } = await auth.admin.from("assignments").upsert(
        serviceIds.map((sid) => ({
          tenant_id: tenantId,
          service_id: sid,
          driver_user_id: driverUserId,
          vehicle_label: vehicleLabel,
          driver_profile_id: null,
          group_id: null,
          assignment_source: null,
          locked_by_operator: false,
          assigned_by: auth.user.id,
          assigned_at: now,
          lock_reason: null,
        })),
        { onConflict: "service_id,tenant_id", ignoreDuplicates: false }
      );

      if (upsertErr) throw new Error(upsertErr.message);

      // Notifica push all'autista
      const readableLabel = vehicleLabel.replace(/^DEP_BUS:/, "");
      void sendPushToUser(tenantId, driverUserId, {
        title: "Nuovo bus assegnato",
        body: `Sei stato assegnato a: ${readableLabel}`,
        url: "/driver",
        tag: "dep-bus-assign",
      });

      return NextResponse.json({ ok: true });
    }

    // ── Rimuovi autista dal gruppo bus ────────────────────────────────────────
    if (action === "remove_driver") {
      const serviceIds = body.service_ids as string[];
      if (!serviceIds?.length) {
        return NextResponse.json({ ok: false, error: "service_ids richiesti" }, { status: 400 });
      }

      const uniqueServiceIds = [...new Set(serviceIds)];
      const ownership = await verifyServicesBelongToTenant(auth.admin, tenantId, uniqueServiceIds, {
        userId: auth.user.id,
        action: "remove_driver",
      });
      if (!ownership.ok) return ownership.response;

      await auth.admin
        .from("assignments")
        .delete()
        .in("service_id", serviceIds)
        .eq("tenant_id", tenantId);

      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ ok: false, error: "Azione non valida" }, { status: 400 });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Errore" },
      { status: 500 }
    );
  }
}
