import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { ensureDriverProfileForMembership, reserveMembershipUsername } from "@/lib/server/driver-registry";
import { sendPushToUser } from "@/lib/server/web-push";
import { auditLog } from "@/lib/server/ops-audit";
import { validateDriverGeographicBatch, type TripGeoServiceRow } from "@/lib/server/geo-assignment";
import { vehicleIntervalsOverlap } from "@/lib/piano-vehicle-timeline";
import { effectiveServiceDisembarkTime, minutesFromHHMM } from "@/lib/piano-arrival-time";

export const runtime = "nodejs";

// ── CONC-03 residuo: nessun controllo di sovrapposizione oraria per lo stesso
// mezzo (vehicle_label) era applicato in questa route, a differenza di
// assign-service (già corretto). Stessa regola di blocco reale già in uso lì:
// finestra fissa di 30 minuti per servizio, overlap [start,end) senza buffer.
// Riusa vehicleIntervalsOverlap (lib/piano-vehicle-timeline.ts) e
// effectiveServiceDisembarkTime/minutesFromHHMM (lib/piano-arrival-time.ts),
// stessa logica operational-time già usata in assign-service, duplicata qui
// localmente (funzione pura, non esportata da quel file, fuori perimetro).
//
// Differenza rispetto ad assign-service: qui l'azione assign_driver riceve un
// BATCH di service_ids con un unico vehicle_label per l'intero batch, mentre
// assign-service gestisce un servizio alla volta. Un batch legittimo (vedi
// app/(app)/rete-ischia/page.tsx: i gruppi sono costruiti per stesso
// pickup_time/nave/porto) ha tipicamente un'unica finestra operativa ripetuta
// su più passeggeri — non va trattato come N conflitti interni. Le finestre
// vengono quindi deduplicate per (data, minuti) prima di qualunque confronto:
// il conflitto interno scatta solo se il batch contiene finestre DISTINTE che
// si sovrappongono tra loro (scenario anomalo, non il caso normale).
//
// Questa route non usa trip_groups (ogni upsert scrive group_id:null, vedi
// RACE-01/semantica upsert sotto): il conflitto esterno viene quindi cercato
// direttamente su assignments per tenant_id+vehicle_label, escludendo i
// service_id del batch corrente — a differenza di assign-service (che passa
// per trip_groups), questo cattura correttamente anche eventuali impegni
// dello stesso mezzo creati da altre route (stesso vehicle_label è lo stesso
// mezzo fisico, indipendentemente da quale route ha scritto la riga).
//
// Nessun filtro sullo stato del servizio esterno (completato/cancelled/ecc.):
// stessa scelta già fatta in assign-service CONC-03, per coerenza (né trips
// né auto-assign filtrano lo stato per questo tipo di blocco).
const VEHICLE_OVERLAP_DURATION_MINUTES = 30;

type DepartureVehicleOverlapServiceFields = {
  date: string;
  time: string | null;
  direction: "arrival" | "departure";
  pickup_hotel: string | null;
  arrival_time?: string | null;
  orario_barca?: string | null;
  porto_bruno?: string | null;
  barca_compagnia?: string | null;
  booking_service_kind?: string | null;
  service_type_code?: string | null;
  vessel?: string | null;
  ferry_details?: Record<string, unknown> | null;
};

function departureServiceOperationalMinutes(service: DepartureVehicleOverlapServiceFields): number | null {
  const timeStr =
    service.direction === "departure"
      ? (service.pickup_hotel ?? service.time)?.slice(0, 5) ?? null
      : effectiveServiceDisembarkTime(service) ?? service.time?.slice(0, 5) ?? null;
  return timeStr ? minutesFromHHMM(timeStr) : null;
}

function vehicleOverlapResponse(): NextResponse {
  return NextResponse.json(
    { ok: false, error: "VEHICLE_OVERLAP", message: "Il mezzo è già impegnato in un altro servizio nello stesso orario." },
    { status: 409 }
  );
}

function vehicleCheckFailedResponse(): NextResponse {
  return NextResponse.json(
    { ok: false, error: "VEHICLE_CHECK_FAILED", message: "Errore durante la verifica della disponibilità del mezzo." },
    { status: 500 }
  );
}

// Verifica overlap reale del mezzo (vehicle_label) contro altri assignments
// dello stesso tenant/mezzo esterni al batch corrente. Va invocata solo per
// l'azione "assign_driver" e solo se vehicle_label è presente/non vuoto.
// Fail-closed: un errore di query blocca la scrittura (500 sanificato).
// Nessun dettaglio del servizio confliggente viene restituito al client.
//
// NOTA DI DESIGN — nessun controllo "interno al batch": una prima versione
// confrontava a coppie le finestre distinte all'interno dello stesso batch,
// ma questo rompeva uno scenario reale già coperto da test esistenti
// (departure-bus-assign-operational-validation.test.ts, "batch trattato come
// unica finestra geografica, non servizio per servizio"): un bus con più
// fermate (hotel diversi, orari scaglionati di pochi minuti) è un batch
// legittimo con finestre temporali DIVERSE per costruzione, non un errore.
// Lo stesso principio è già applicato a FUNC-01 (validateDriverGeographicBatch
// tratta l'intero batch come un'unica finestra operativa, non a coppie). Il
// co-invio di più service_ids nella stessa richiesta assign_driver è di per
// sé il segnale che l'operatore li considera un unico giro coordinato: non
// esiste nel modello dati un modo affidabile per distinguere un batch
// multi-fermata legittimo da un batch "malformato", quindi qualunque
// controllo pairwise interno produrrebbe falsi positivi sistematici. Il
// controllo esterno sotto resta comunque applicato per OGNI finestra del
// batch (deduplicata), quindi una singola fermata in conflitto con un
// impegno esterno preesistente viene comunque bloccata.
async function checkDepartureBatchVehicleOverlap(
  admin: SupabaseClient,
  tenantId: string,
  input: {
    vehicleLabel: string;
    services: Array<DepartureVehicleOverlapServiceFields & { id: string }>;
  },
  context: { userId?: string }
): Promise<{ ok: true } | { ok: false; response: NextResponse }> {
  const label = input.vehicleLabel.trim();
  if (!label) return { ok: true };

  type Window = { date: string; start: number; end: number };
  const windowsByKey = new Map<string, Window>();
  for (const svc of input.services) {
    const start = departureServiceOperationalMinutes(svc);
    if (start == null) continue;
    const key = `${svc.date}|${start}`;
    if (!windowsByKey.has(key)) {
      windowsByKey.set(key, { date: svc.date, start, end: start + VEHICLE_OVERLAP_DURATION_MINUTES });
    }
  }
  const windows = Array.from(windowsByKey.values());
  if (windows.length === 0) return { ok: true };

  // Conflitto esterno: altri assignments dello stesso tenant/mezzo, non
  // filtrati per data a livello di query (nessuna colonna embedded
  // affidabile da filtrare via dot-path su services), filtrati in memoria
  // sotto insieme all'esclusione del batch corrente.
  const excludeServiceIds = new Set(input.services.map((s) => s.id));

  const { data: externalData, error: externalError } = await admin
    .from("assignments")
    .select(
      "service_id, services!inner(date, time, direction, pickup_hotel, arrival_time, orario_barca, porto_bruno, barca_compagnia, booking_service_kind, service_type_code, vessel, ferry_details)"
    )
    .eq("tenant_id", tenantId)
    .eq("vehicle_label", label);

  if (externalError) {
    auditLog({
      event: "departure_bus_assign_vehicle_check_failed",
      level: "error",
      tenantId,
      userId: context.userId ?? null,
      details: { vehicleLabel: label, dbCode: (externalError as { code?: string }).code ?? null },
    });
    return { ok: false, response: vehicleCheckFailedResponse() };
  }

  for (const row of externalData ?? []) {
    const otherServiceId = row.service_id as string;
    if (excludeServiceIds.has(otherServiceId)) continue;
    const otherService = (row.services as unknown) as DepartureVehicleOverlapServiceFields | null;
    if (!otherService) continue;
    const otherStart = departureServiceOperationalMinutes(otherService);
    if (otherStart == null) continue;
    const otherInterval = { start_min: otherStart, end_min: otherStart + VEHICLE_OVERLAP_DURATION_MINUTES };

    for (const w of windows) {
      if (w.date !== otherService.date) continue;
      if (vehicleIntervalsOverlap({ start_min: w.start, end_min: w.end }, otherInterval, 0)) {
        auditLog({
          event: "departure_bus_assign_vehicle_overlap",
          level: "warn",
          tenantId,
          userId: context.userId ?? null,
          details: { vehicleLabel: label, kind: "external_assignment" },
        });
        return { ok: false, response: vehicleOverlapResponse() };
      }
    }
  }

  return { ok: true };
}

function driverOverlapResponse(): NextResponse {
  return NextResponse.json(
    { ok: false, error: "DRIVER_OVERLAP", message: "L'autista è già impegnato in un altro servizio nello stesso orario." },
    { status: 409 }
  );
}

function driverOverlapCheckFailedResponse(): NextResponse {
  return NextResponse.json(
    { ok: false, error: "DRIVER_OVERLAP_CHECK_FAILED", message: "Errore durante la verifica degli impegni dell'autista." },
    { status: 500 }
  );
}

// ── CONC-02 residuo: nessun controllo di sovrapposizione oraria per lo stesso
// autista era applicato in questa route, a differenza di assign-service (già
// corretto). Stesso schema di checkDepartureBatchVehicleOverlap (CONC-03
// residuo) sopra, riusato per driver_user_id invece di vehicle_label: stessa
// finestra fissa 30 minuti, stessa deduplica delle finestre del batch, stessa
// assenza di controllo "interno al batch" — identica motivazione già
// documentata sopra (un batch multi-fermata è lo STESSO autista che fa più
// tappe in sequenza: orari diversi all'interno del batch non sono mai un
// conflitto driver, sono la natura stessa del giro). Il controllo esterno
// resta comunque applicato per ogni finestra del batch, escludendo i
// service_id del batch corrente.
async function checkDepartureBatchDriverOverlap(
  admin: SupabaseClient,
  tenantId: string,
  input: {
    driverUserId: string;
    services: Array<DepartureVehicleOverlapServiceFields & { id: string }>;
  },
  context: { userId?: string }
): Promise<{ ok: true } | { ok: false; response: NextResponse }> {
  const driverUserId = input.driverUserId?.trim();
  if (!driverUserId) return { ok: true };

  type Window = { date: string; start: number; end: number };
  const windowsByKey = new Map<string, Window>();
  for (const svc of input.services) {
    const start = departureServiceOperationalMinutes(svc);
    if (start == null) continue;
    const key = `${svc.date}|${start}`;
    if (!windowsByKey.has(key)) {
      windowsByKey.set(key, { date: svc.date, start, end: start + VEHICLE_OVERLAP_DURATION_MINUTES });
    }
  }
  const windows = Array.from(windowsByKey.values());
  if (windows.length === 0) return { ok: true };

  const excludeServiceIds = new Set(input.services.map((s) => s.id));

  const { data: externalData, error: externalError } = await admin
    .from("assignments")
    .select(
      "service_id, services!inner(date, time, direction, pickup_hotel, arrival_time, orario_barca, porto_bruno, barca_compagnia, booking_service_kind, service_type_code, vessel, ferry_details)"
    )
    .eq("tenant_id", tenantId)
    .eq("driver_user_id", driverUserId);

  if (externalError) {
    auditLog({
      event: "departure_bus_assign_driver_overlap_check_failed",
      level: "error",
      tenantId,
      userId: context.userId ?? null,
      details: { dbCode: (externalError as { code?: string }).code ?? null },
    });
    return { ok: false, response: driverOverlapCheckFailedResponse() };
  }

  for (const row of externalData ?? []) {
    const otherServiceId = row.service_id as string;
    if (excludeServiceIds.has(otherServiceId)) continue;
    const otherService = (row.services as unknown) as DepartureVehicleOverlapServiceFields | null;
    if (!otherService) continue;
    const otherStart = departureServiceOperationalMinutes(otherService);
    if (otherStart == null) continue;
    const otherInterval = { start_min: otherStart, end_min: otherStart + VEHICLE_OVERLAP_DURATION_MINUTES };

    for (const w of windows) {
      if (w.date !== otherService.date) continue;
      if (vehicleIntervalsOverlap({ start_min: w.start, end_min: w.end }, otherInterval, 0)) {
        auditLog({
          event: "departure_bus_assign_driver_overlap",
          level: "warn",
          tenantId,
          userId: context.userId ?? null,
          details: { kind: "external_assignment" },
        });
        return { ok: false, response: driverOverlapResponse() };
      }
    }
  }

  return { ok: true };
}

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
        .select(
          "id, date, time, pickup_hotel, direction, hotel_id, meeting_point, arrival_time, orario_barca, porto_bruno, barca_compagnia, booking_service_kind, service_type_code, vessel, ferry_details"
        )
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

      // CONC-02 residuo: verifica overlap orario esterno dello stesso autista,
      // prima di qualunque scrittura su assignments.
      const driverOverlapCheck = await checkDepartureBatchDriverOverlap(
        auth.admin,
        tenantId,
        {
          driverUserId,
          services: batchServices.map((s) => ({ ...s, id: s.id as string })) as Array<DepartureVehicleOverlapServiceFields & { id: string }>,
        },
        { userId: auth.user.id }
      );
      if (!driverOverlapCheck.ok) return driverOverlapCheck.response;

      // CONC-03 residuo: verifica overlap mezzo (interno al batch + esterno),
      // prima di qualunque scrittura su assignments.
      const vehicleOverlapCheck = await checkDepartureBatchVehicleOverlap(
        auth.admin,
        tenantId,
        {
          vehicleLabel,
          services: batchServices.map((s) => ({ ...s, id: s.id as string })) as Array<DepartureVehicleOverlapServiceFields & { id: string }>,
        },
        { userId: auth.user.id }
      );
      if (!vehicleOverlapCheck.ok) return vehicleOverlapCheck.response;

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
