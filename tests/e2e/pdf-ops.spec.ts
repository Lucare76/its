import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

type PreparedDraft = {
  inbound_email_id: string;
  draft_service_id: string;
  customer_name: string;
  external_reference: string;
  import_state: string;
};

function readEnvFile(): Record<string, string> {
  const parse = (filePath: string): Record<string, string> => {
    if (!fs.existsSync(filePath)) return {};
    return Object.fromEntries(
      fs.readFileSync(filePath, "utf8")
        .split(/\r?\n/).map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#") && l.includes("="))
        .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, "")]; })
    );
  };
  return { ...parse(path.resolve(".env")), ...parse(path.resolve(".env.local")) };
}

const localEnv = readEnvFile();
const adminEmail = process.env.PDF_PREVIEW_USER_EMAIL || localEnv.PDF_PREVIEW_USER_EMAIL || "admin@demo.com";
const adminPassword = process.env.PDF_PREVIEW_USER_PASSWORD || localEnv.PDF_PREVIEW_USER_PASSWORD || "demo123";
const inferredPort = process.env.E2E_PORT || "3010";
const baseURL = process.env.E2E_BASE_URL || `http://localhost:${inferredPort}`;
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || localEnv.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || localEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || localEnv.SUPABASE_SERVICE_ROLE_KEY || "";
const isRealApp = process.env.E2E_REAL_APP === "true";

let preparedDraft: PreparedDraft | null = null;
let storageKey = "";
let storageValue = "";
let e2eSessionValue = "";
let uploadPdfPath = "";
let accessToken = "";
let adminClient: ReturnType<typeof createClient> | null = null;

async function openWithSupabaseSession(page: Page, targetPath: string) {
  await page.addInitScript(
    ({ value }) => {
      window.localStorage.setItem("__it_e2e_session", value);
    },
    { value: e2eSessionValue }
  );
  await page.addInitScript(
    ({ key, value }) => {
      window.localStorage.setItem(key, value);
    },
    { key: storageKey, value: storageValue }
  );
  await page.goto(targetPath);
  await page.waitForURL((url) => url.pathname === targetPath, { timeout: 20_000 });
  await page.evaluate(
    ({ key, value, e2eValue }) => {
      window.localStorage.setItem("__it_e2e_session", e2eValue);
      window.localStorage.setItem(key, value);
    },
    { key: storageKey, value: storageValue, e2eValue: e2eSessionValue }
  );
  await page.reload();
  await page.waitForURL((url) => url.pathname === targetPath, { timeout: 20_000 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const sessionInvalid = await page.getByText("Sessione non valida. Rifai login.").isVisible().catch(() => false);
    const tenantMissing = await page.getByText("Tenant non configurato per questo utente. Completa onboarding.").isVisible().catch(() => false);
    if (!sessionInvalid && !tenantMissing) break;
    await page.waitForTimeout(300);
    await page.reload();
    await page.waitForURL((url) => url.pathname === targetPath, { timeout: 20_000 });
  }
}

async function getPdfLinkedServiceId(inboundEmailId: string) {
  if (!adminClient) throw new Error("Client admin E2E non disponibile.");
  const inbound = await adminClient
    .from("inbound_emails")
    .select("parsed_json")
    .eq("id", inboundEmailId)
    .maybeSingle();
  if (inbound.error || !inbound.data) {
    throw new Error(inbound.error?.message ?? "Inbound email E2E non disponibile.");
  }
  const linkedServiceId = (inbound.data.parsed_json as { pdf_import?: { linked_service_id?: string | null } } | null)
    ?.pdf_import?.linked_service_id ?? null;
  return linkedServiceId;
}

async function getServiceSnapshot(serviceId: string) {
  if (!adminClient) throw new Error("Client admin E2E non disponibile.");
  const service = await adminClient
    .from("services")
    .select("id, status, is_draft")
    .eq("id", serviceId)
    .maybeSingle();
  if (service.error || !service.data) {
    throw new Error(service.error?.message ?? "Servizio E2E non disponibile.");
  }
  return service.data;
}

async function buildReviewPayload(inboundEmailId: string) {
  if (!adminClient) throw new Error("Client admin E2E non disponibile.");
  const inbound = await adminClient
    .from("inbound_emails")
    .select("parsed_json")
    .eq("id", inboundEmailId)
    .maybeSingle();
  if (inbound.error || !inbound.data) {
    throw new Error(inbound.error?.message ?? "Inbound email E2E non disponibile.");
  }
  const parsed = (inbound.data.parsed_json ?? {}) as {
    pdf_import?: {
      effective_normalized?: Record<string, unknown> | null;
      original_normalized?: Record<string, unknown> | null;
      normalized?: Record<string, unknown> | null;
    };
  };
  const normalized = parsed.pdf_import?.effective_normalized
    ?? parsed.pdf_import?.original_normalized
    ?? parsed.pdf_import?.normalized
    ?? {};
  const dedupeComponents = (normalized.dedupe_components ?? {}) as {
    practice_number?: string | null;
    ns_reference?: string | null;
  };
  const bookingKind = typeof normalized.booking_kind === "string" ? normalized.booking_kind : "transfer_port_hotel";
  const serviceType = typeof normalized.service_type === "string"
    ? normalized.service_type
    : bookingKind === "bus_city_hotel"
      ? "bus_line"
      : bookingKind === "excursion"
        ? "excursion"
        : bookingKind === "transfer_airport_hotel"
          ? "transfer_airport_hotel"
          : "transfer_port_hotel";

  return {
    inbound_email_id: inboundEmailId,
    reviewed_values: {
      customer_full_name: typeof normalized.customer_full_name === "string" ? normalized.customer_full_name : null,
      customer_phone: typeof normalized.customer_phone === "string" ? normalized.customer_phone : null,
      customer_email: typeof normalized.customer_email === "string" ? normalized.customer_email : null,
      billing_party_name: typeof normalized.billing_party_name === "string" ? normalized.billing_party_name : null,
      arrival_date: typeof normalized.arrival_date === "string" ? normalized.arrival_date : new Date().toISOString().slice(0, 10),
      outbound_time: "10:30",
      departure_date: typeof normalized.departure_date === "string" ? normalized.departure_date : null,
      return_time: typeof normalized.return_time === "string" ? normalized.return_time : null,
      arrival_place: typeof normalized.arrival_place === "string" ? normalized.arrival_place : null,
      hotel_or_destination: typeof normalized.hotel_or_destination === "string" ? normalized.hotel_or_destination : null,
      passengers: typeof normalized.passengers === "number" ? normalized.passengers : 1,
      source_total_amount_cents: typeof normalized.source_total_amount_cents === "number" ? normalized.source_total_amount_cents : null,
      source_price_per_pax_cents: typeof normalized.source_price_per_pax_cents === "number" ? normalized.source_price_per_pax_cents : null,
      source_amount_currency: typeof normalized.source_amount_currency === "string" ? normalized.source_amount_currency : "EUR",
      booking_kind: bookingKind,
      service_type: serviceType,
      transport_mode: typeof normalized.transport_mode === "string" ? normalized.transport_mode : "road_transfer",
      train_arrival_number: typeof normalized.train_arrival_number === "string" ? normalized.train_arrival_number : null,
      train_departure_number: typeof normalized.train_departure_number === "string" ? normalized.train_departure_number : null,
      bus_city_origin: typeof normalized.bus_city_origin === "string" ? normalized.bus_city_origin : null,
      practice_number: typeof dedupeComponents.practice_number === "string" ? dedupeComponents.practice_number : null,
      ns_reference: typeof dedupeComponents.ns_reference === "string" ? dedupeComponents.ns_reference : null,
      notes: "Review salvata da Playwright"
    }
  };
}

async function ensureDraftConfirmed(page: Page, draft: PreparedDraft) {
  if (!adminClient || !accessToken) {
    throw new Error("Contesto E2E non inizializzato.");
  }

  const currentService = await adminClient
    .from("services")
    .select("id, is_draft, status")
    .eq("id", draft.draft_service_id)
    .maybeSingle();
  if (currentService.error) {
    throw new Error(currentService.error.message);
  }

  const alreadyConfirmed = currentService.data?.is_draft === false
    && (currentService.data.status === "new" || currentService.data.status === "assigned");
  if (alreadyConfirmed) {
    return draft.draft_service_id;
  }

  const confirmResponse = await page.request.post(`${baseURL}/api/email/confirm-pdf`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "content-type": "application/json"
    },
    data: { inbound_email_id: draft.inbound_email_id }
  });
  const confirmJson = await confirmResponse.json().catch(() => null) as {
    ok?: boolean;
    error?: string;
    outcome?: string;
    final_service_id?: string;
    existing_service_id?: string;
  } | null;
  if (!confirmResponse.ok || !confirmJson?.ok) {
    const reviewResponse = await page.request.post(`${baseURL}/api/email/pdf-imports/review`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "content-type": "application/json"
      },
      data: await buildReviewPayload(draft.inbound_email_id)
    });
    const reviewJson = await reviewResponse.json().catch(() => null) as { ok?: boolean; error?: string } | null;
    if (!reviewResponse.ok || !reviewJson?.ok) {
      throw new Error(reviewJson?.error ?? "Review PDF E2E fallita.");
    }

    const retryConfirmResponse = await page.request.post(`${baseURL}/api/email/confirm-pdf`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "content-type": "application/json"
      },
      data: { inbound_email_id: draft.inbound_email_id }
    });
    const retryConfirmJson = await retryConfirmResponse.json().catch(() => null) as {
      ok?: boolean;
      error?: string;
      outcome?: string;
      final_service_id?: string;
      existing_service_id?: string;
    } | null;
    if (!retryConfirmResponse.ok || !retryConfirmJson?.ok) {
      throw new Error(
        [
          confirmJson?.error ?? "Conferma PDF E2E fallita.",
          retryConfirmJson?.error ?? "Conferma PDF E2E fallita dopo review."
        ].join(" / ")
      );
    }

    return retryConfirmJson.final_service_id
      ?? retryConfirmJson.existing_service_id
      ?? await getPdfLinkedServiceId(draft.inbound_email_id)
      ?? draft.draft_service_id;
  }

  return confirmJson.final_service_id
    ?? confirmJson.existing_service_id
    ?? await getPdfLinkedServiceId(draft.inbound_email_id)
    ?? draft.draft_service_id;
}

test.describe.serial("PDF ops UI", () => {
  test.skip(!isRealApp || !baseURL || !supabaseUrl || !supabaseAnonKey || !serviceRoleKey, "Richiede E2E_REAL_APP=true e env Supabase complete.");

  test.beforeAll(async () => {
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const signIn = await supabase.auth.signInWithPassword({ email: adminEmail, password: adminPassword });
    if (signIn.error || !signIn.data.session) {
      throw new Error(signIn.error?.message ?? "Login Supabase E2E fallito");
    }
    accessToken = signIn.data.session.access_token;
    adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const userId = signIn.data.user?.id;
    if (!userId) {
      throw new Error("User id E2E non disponibile.");
    }
    const membershipResult = await adminClient
      .from("memberships")
      .select("tenant_id, role")
      .eq("user_id", userId)
      .limit(1)
      .maybeSingle();
    const tenantId = membershipResult.data?.tenant_id;
    const role = membershipResult.data?.role;
    if (membershipResult.error || !tenantId || !role) {
      throw new Error(membershipResult.error?.message ?? "Membership E2E non disponibile");
    }
    const projectRef = new URL(supabaseUrl).hostname.split(".")[0] || "local";
    storageKey = `sb-${projectRef}-auth-token`;
    storageValue = JSON.stringify(signIn.data.session);
    e2eSessionValue = JSON.stringify({ userId, tenantId, role });

    const stdout = execFileSync("node", ["scripts/prepare-pdf-e2e-draft.mjs"], {
      encoding: "utf8",
      env: {
        ...process.env,
        NEXT_PUBLIC_APP_URL: baseURL
      }
    });
    preparedDraft = JSON.parse(stdout.trim()) as PreparedDraft;

    const uploadPdfPractice = `E2E-UPLOAD-${String(Date.now()).slice(-6)}`;
    uploadPdfPath = path.resolve(`samples/review-test-e2e-${Date.now()}.pdf`);
    execFileSync("node", ["scripts/generate-synthetic-agency-pdf.mjs", uploadPdfPractice, uploadPdfPath], {
      encoding: "utf8",
      env: process.env
    });
  });

  test("upload da /pdf-imports", async ({ page }) => {
    if (!uploadPdfPath) throw new Error("PDF upload E2E non preparato.");

    await openWithSupabaseSession(page, "/inbox");
    await expect(page.getByRole("heading", { name: "Prenotazioni" })).toBeVisible();
    await page.getByTestId("pdf-upload-open").click();

    await page.getByTestId("pdf-upload-input").setInputFiles(uploadPdfPath);
    await expect(page.getByTestId("pdf-upload-status")).toContainText("File selezionato");

    await page.getByTestId("pdf-upload-preview").click();
    await expect(page.getByTestId("pdf-upload-status")).toContainText("Anteprima parser pronta.", { timeout: 90_000 });

    await page.getByTestId("pdf-upload-draft").click();
    await expect(page.getByText(`PDF importato. Bozza creata in Inbox per ${path.basename(uploadPdfPath)}.`)).toBeVisible({ timeout: 90_000 });
  });

  test("ignore da /pdf-imports", async ({ page }) => {
    const stdout = execFileSync("node", ["scripts/prepare-pdf-e2e-draft.mjs"], {
      encoding: "utf8",
      env: {
        ...process.env,
        NEXT_PUBLIC_APP_URL: baseURL
      }
    });
    const draftToIgnore = JSON.parse(stdout.trim()) as PreparedDraft;

    await openWithSupabaseSession(page, "/inbox");
    await expect(page.getByRole("heading", { name: "Prenotazioni" })).toBeVisible();

    const row = page.getByTestId(`pdf-import-row-${draftToIgnore.inbound_email_id}`);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.click();
    await page.getByTestId("pdf-review-open").click();
    await expect(page.getByText("PDF Advanced Review")).toBeVisible();
    await page.getByTestId("pdf-ignore-import").click();
    await expect(row).toContainText("da approvare", { timeout: 30_000 });
  });

  test("review/edit e conferma finale da /pdf-imports", async ({ page }) => {
    if (!preparedDraft) throw new Error("Draft PDF E2E non preparato.");

    await openWithSupabaseSession(page, "/inbox");
    await expect(page.getByRole("heading", { name: "Prenotazioni" })).toBeVisible();

    const row = page.getByTestId(`pdf-import-row-${preparedDraft.inbound_email_id}`);
    await expect(row).toBeVisible();
    await row.click();

    await page.getByTestId("pdf-review-open").click();
    await expect(page.getByTestId("pdf-import-status-badge")).toContainText("Draft");
    await page.getByTestId("pdf-review-field-outbound-time").fill("10:30");
    await page.getByTestId("pdf-review-field-notes").click();
    await page.getByTestId("pdf-review-field-notes").fill("Review salvata da Playwright");
    await expect(page.getByTestId("pdf-review-field-notes")).toHaveValue("REVIEW SALVATA DA PLAYWRIGHT");

    await page.getByTestId("pdf-review-save").click();
    await expect(page.getByText("Modifiche review salvate.")).toBeVisible();

    await page.getByTestId("pdf-confirm-import").click();
    await expect(page.getByText("Import PDF confermato.")).toBeVisible();
    await expect.poll(
      async () => await getPdfLinkedServiceId(preparedDraft.inbound_email_id),
      { timeout: 30_000, message: "Il PDF confermato deve collegarsi a un servizio finale." }
    ).toBeTruthy();
    const confirmedServiceId = await getPdfLinkedServiceId(preparedDraft.inbound_email_id);
    if (!confirmedServiceId) throw new Error("Service id finale PDF non disponibile dopo la conferma.");
    await expect.poll(
      async () => {
        const snapshot = await getServiceSnapshot(confirmedServiceId);
        return `${snapshot.is_draft}:${snapshot.status}`;
      },
      { timeout: 30_000, message: "Il servizio confermato deve uscire dal draft ed entrare nel dispatch." }
    ).toBe("false:new");
  });

  test("booking PDF confermato visibile e filtrabile in /dispatch", async ({ page }) => {
    if (!preparedDraft?.draft_service_id) throw new Error("Servizio draft non disponibile.");
    const linkedServiceId = await ensureDraftConfirmed(page, preparedDraft);

    await openWithSupabaseSession(page, "/dispatch");
    await expect(page.getByRole("heading", { name: "Dispatch" })).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("dispatch-tab-all").click();
    await page.getByTestId("dispatch-search").fill(preparedDraft.customer_name);
    await expect(page.getByTestId(`dispatch-row-${linkedServiceId}`)).toBeVisible({ timeout: 30_000 });
  });
});
