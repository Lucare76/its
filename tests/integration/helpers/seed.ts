import { randomUUID } from "crypto";
import { makeAdminClient, makeAnonClient } from "./client";
import type { SupabaseClient } from "@supabase/supabase-js";

export type TestContext = {
  admin: SupabaseClient;
  tenantId: string;
  userId: string;
  token: string;
  cleanup: () => Promise<void>;
};

/**
 * Crea un tenant isolato con un utente admin e restituisce il JWT.
 * Chiamare `cleanup()` in afterAll per rimuovere tutti i dati.
 */
export async function createTestContext(): Promise<TestContext> {
  const admin = makeAdminClient();
  const anon = makeAnonClient();
  const tenantId = randomUUID();
  const email = `integration-test-${Date.now()}@test.invalid`;
  const password = randomUUID();

  // 1. Crea tenant
  const { error: tenantErr } = await admin
    .from("tenants")
    .insert({ id: tenantId, name: "Integration Test Tenant" });
  if (tenantErr) throw new Error(`createTestContext: tenant — ${tenantErr.message}`);

  // 2. Crea utente auth
  const { data: userRes, error: userErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (userErr || !userRes.user) throw new Error(`createTestContext: user — ${userErr?.message}`);
  const userId = userRes.user.id;

  // 3. Membership admin
  const { error: memErr } = await admin.from("memberships").insert({
    tenant_id: tenantId,
    user_id: userId,
    role: "admin",
    full_name: "Test Admin",
  });
  if (memErr) throw new Error(`createTestContext: membership — ${memErr.message}`);

  // 4. Login per ottenere JWT
  const { data: session, error: signInErr } = await anon.auth.signInWithPassword({
    email,
    password,
  });
  if (signInErr || !session.session)
    throw new Error(`createTestContext: sign-in — ${signInErr?.message}`);
  const token = session.session.access_token;

  const cleanup = async () => {
    // FK order: inbound_booking_imports/assignments/trip_groups/status_events → service_pricing → services
    // → pricing_rules → price_lists → vehicles/hotels/routes/agency_aliases/agencies → memberships → tenants → user
    await admin.from("inbound_booking_imports").delete().eq("tenant_id", tenantId);
    await admin.from("daily_availability_confirmations").delete().eq("tenant_id", tenantId);
    await admin.from("vehicle_commitments").delete().eq("tenant_id", tenantId);
    await admin.from("vehicle_time_blocks").delete().eq("tenant_id", tenantId);
    await admin.from("vehicle_daily_availability").delete().eq("tenant_id", tenantId);
    await admin.from("driver_daily_availability").delete().eq("tenant_id", tenantId);
    await admin.from("assignments").delete().eq("tenant_id", tenantId);
    await admin.from("booking_qr_codes").delete().eq("tenant_id", tenantId);
    await admin.from("trip_groups").delete().eq("tenant_id", tenantId);
    await admin.from("status_events").delete().eq("tenant_id", tenantId);
    await admin.from("service_pricing").delete().eq("tenant_id", tenantId);
    await admin.from("services").delete().eq("tenant_id", tenantId);
    await admin.from("pricing_rules").delete().eq("tenant_id", tenantId);
    await admin.from("price_lists").delete().eq("tenant_id", tenantId);
    await admin.from("vehicles").delete().eq("tenant_id", tenantId);
    await admin.from("hotels").delete().eq("tenant_id", tenantId);
    await admin.from("routes").delete().eq("tenant_id", tenantId);
    await admin.from("agency_aliases").delete().eq("tenant_id", tenantId);
    await admin.from("agencies").delete().eq("tenant_id", tenantId);
    await admin.from("memberships").delete().eq("tenant_id", tenantId);
    await admin.from("tenants").delete().eq("id", tenantId);
    await admin.auth.admin.deleteUser(userId);
  };

  return { admin, tenantId, userId, token, cleanup };
}

/** Inserisce un hotel minimo e ritorna il suo id. */
export async function seedHotel(
  admin: SupabaseClient,
  tenantId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const id = randomUUID();
  const { error } = await admin.from("hotels").insert({
    id,
    tenant_id: tenantId,
    name: "Hotel Test",
    address: "Via Test 1, Ischia",
    lat: 40.7329,
    lng: 13.9477,
    zone: "Ischia Porto",
    ...overrides,
  });
  if (error) throw new Error(`seedHotel: ${error.message}`);
  return id;
}

/** Inserisce un veicolo attivo e ritorna il suo id. */
export async function seedVehicle(
  admin: SupabaseClient,
  tenantId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const id = randomUUID();
  const { error } = await admin.from("vehicles").insert({
    id,
    tenant_id: tenantId,
    label: "Van Test 8",
    capacity: 8,
    active: true,
    ...overrides,
  });
  if (error) throw new Error(`seedVehicle: ${error.message}`);
  return id;
}

/**
 * Crea un secondo utente auth con ruolo driver nello stesso tenant.
 * Aggiunge il suo id ad additionalUsers per il cleanup.
 */
export async function seedDriver(
  admin: SupabaseClient,
  tenantId: string,
  additionalUsers: string[],
): Promise<string> {
  const email = `driver-test-${Date.now()}@test.invalid`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: randomUUID(),
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`seedDriver: ${error?.message}`);
  const driverUserId = data.user.id;
  additionalUsers.push(driverUserId);

  const { error: memErr } = await admin.from("memberships").insert({
    tenant_id: tenantId,
    user_id: driverUserId,
    role: "driver",
    full_name: "Autista Test",
  });
  if (memErr) throw new Error(`seedDriver membership: ${memErr.message}`);
  return driverUserId;
}

/** Inserisce un'agenzia e ritorna il suo id. */
export async function seedAgency(
  admin: SupabaseClient,
  tenantId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const id = randomUUID();
  const { error } = await admin.from("agencies").insert({
    id,
    tenant_id: tenantId,
    name: "Agenzia Test",
    active: true,
    ...overrides,
  });
  if (error) throw new Error(`seedAgency: ${error.message}`);
  return id;
}

/** Inserisce una tratta e ritorna il suo id. */
export async function seedRoute(
  admin: SupabaseClient,
  tenantId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const id = randomUUID();
  const { error } = await admin.from("routes").insert({
    id,
    tenant_id: tenantId,
    name: "Tratta Test",
    origin_label: "Ischia Porto",
    destination_label: "Hotel Verde",
    active: true,
    ...overrides,
  });
  if (error) throw new Error(`seedRoute: ${error.message}`);
  return id;
}

/** Inserisce un listino prezzi e ritorna il suo id. */
export async function seedPriceList(
  admin: SupabaseClient,
  tenantId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const id = randomUUID();
  const { error } = await admin.from("price_lists").insert({
    id,
    tenant_id: tenantId,
    currency: "EUR",
    is_default: true,
    valid_from: "2026-01-01",
    valid_to: null,
    active: true,
    agency_id: null,
    ...overrides,
  });
  if (error) throw new Error(`seedPriceList: ${error.message}`);
  return id;
}

/** Inserisce una regola tariffaria e ritorna il suo id. */
export async function seedPricingRule(
  admin: SupabaseClient,
  tenantId: string,
  priceListId: string,
  routeId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const id = randomUUID();
  const { error } = await admin.from("pricing_rules").insert({
    id,
    tenant_id: tenantId,
    price_list_id: priceListId,
    route_id: routeId,
    agency_id: null,
    service_type: null,
    direction: null,
    pax_min: 1,
    pax_max: null,
    rule_kind: "fixed",
    internal_cost_cents: 2000,
    public_price_cents: 5000,
    agency_price_cents: 4000,
    priority: 1,
    vehicle_type: null,
    time_from: null,
    time_to: null,
    season_from: null,
    season_to: null,
    needs_manual_review: false,
    active: true,
    ...overrides,
  });
  if (error) throw new Error(`seedPricingRule: ${error.message}`);
  return id;
}

/** Inserisce un servizio di trasferimento e ritorna il suo id. */
export async function seedService(
  admin: SupabaseClient,
  tenantId: string,
  hotelId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const id = randomUUID();
  const { error } = await admin.from("services").insert({
    id,
    tenant_id: tenantId,
    date: "2026-05-10",
    time: "10:00",
    direction: "arrival",
    vessel: "SNAV Test",
    pax: 2,
    hotel_id: hotelId,
    customer_name: "Rossi Mario",
    phone: "+39 333 1234567",
    service_type: "transfer",
    status: "new",
    notes: "",
    meeting_point: "Ischia Porto",
    ...overrides,
  });
  if (error) throw new Error(`seedService: ${error.message}`);
  return id;
}

/** Conferma la disponibilità giornaliera per sbloccare l'auto-assign. */
export async function seedAvailabilityConfirmation(
  admin: SupabaseClient,
  tenantId: string,
  date: string,
  confirmedBy: string,
): Promise<void> {
  const { error } = await admin.from("daily_availability_confirmations").upsert({
    tenant_id: tenantId,
    date,
    confirmed: true,
    confirmed_at: new Date().toISOString(),
    confirmed_by: confirmedBy,
  }, { onConflict: "tenant_id,date" });
  if (error) throw new Error(`seedAvailabilityConfirmation: ${error.message}`);
}

export async function seedVehicleCommitment(
  admin: SupabaseClient,
  tenantId: string,
  vehicleId: string,
  date: string,
  overrides: Record<string, unknown> = {}
): Promise<string> {
  const id = randomUUID();
  const { error } = await admin.from("vehicle_commitments").insert({
    id,
    tenant_id: tenantId,
    vehicle_id: vehicleId,
    commitment_date: date,
    commitment_type: "officina",
    notes: "Test impegno",
    ...overrides,
  });
  if (error) throw new Error(`seedVehicleCommitment: ${error.message}`);
  return id;
}
