import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

function loadDotEnvLocal() {
  const envPath = path.resolve(".env.local");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^"|"$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

async function login() {
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const email = process.env.PDF_PREVIEW_USER_EMAIL || "admin@demo.com";
  const password = process.env.PDF_PREVIEW_USER_PASSWORD || "demo123";
  const signIn = await supabase.auth.signInWithPassword({ email, password });
  if (signIn.error || !signIn.data.session?.access_token) {
    throw new Error(signIn.error?.message ?? "Login fallito");
  }
  return signIn.data.session.access_token;
}

function buildForm(samplePath, subject, fromEmail) {
  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(samplePath)], { type: "application/pdf" }), path.basename(samplePath));
  form.append("subject", subject);
  form.append("from_email", fromEmail);
  return form;
}

async function main() {
  loadDotEnvLocal();
  let samplePath = process.argv[2] ?? "samples/prova 2.pdf";
  if (samplePath.endsWith("review-test.pdf")) {
    const uniquePractice = `99/${Date.now().toString().slice(-6)}`;
    const uniquePath = `samples/review-test-${Date.now()}.pdf`;
    const generated = spawnSync("node", ["scripts/generate-synthetic-agency-pdf.mjs", uniquePractice, uniquePath], {
      stdio: "inherit",
      shell: false
    });
    if (generated.status !== 0) {
      throw new Error("Generazione PDF sintetico fallita");
    }
    samplePath = uniquePath;
  }
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "http://127.0.0.1:3010").replace(/\/$/, "");
  const token = await login();
  const fromEmail = process.env.PDF_PREVIEW_SENDER_EMAIL || "booking@aleste-viaggi.it";
  const subject = `Review Flow ${Date.now()} ${path.basename(samplePath)}`;
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const draftResponse = await fetch(`${appUrl}/api/email/import-pdf`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: buildForm(samplePath, subject, fromEmail)
  });
  const draftBody = await draftResponse.json();
  let inboundEmailId = draftBody.inbound_email_id ?? null;
  let sourceMode = "new_draft";

  if ((!draftResponse.ok || !inboundEmailId) && !draftBody?.duplicate) {
    throw new Error(`Draft failed: ${JSON.stringify(draftBody)}`);
  }

  if (!inboundEmailId) {
    const { data: inboundRows, error: inboundError } = await admin
      .from("inbound_emails")
      .select("id, parsed_json, created_at")
      .order("created_at", { ascending: false })
      .limit(200);
    if (inboundError) {
      throw new Error(inboundError.message);
    }
    const fallbackDraft = (inboundRows ?? []).find((row) => {
      const state = row.parsed_json?.pdf_import?.import_state;
      return state === "draft";
    });
    if (!fallbackDraft?.id) {
      throw new Error(`No reusable draft found after duplicate import: ${JSON.stringify(draftBody)}`);
    }
    inboundEmailId = fallbackDraft.id;
    sourceMode = "existing_draft";
  }

  const reviewPayload = {
    inbound_email_id: inboundEmailId,
    reviewed_values: {
      customer_full_name: "GIUSEPPE TESTREVIEW",
      customer_phone: "3330009999",
      customer_email: "review@example.com",
      arrival_date: "2026-06-01",
      outbound_time: "15:10",
      departure_date: "2026-06-05",
      return_time: "09:40",
      arrival_place: "PORTO DI ISCHIA",
      hotel_or_destination: "HOTEL PARADISO REVIEW",
      passengers: 3,
      booking_kind: "transfer_port_hotel",
      service_type: "transfer_port_hotel",
      transport_mode: "road_transfer",
      billing_party_name: "Agenzia Test Operativa",
      source_total_amount_cents: 5000,
      source_price_per_pax_cents: 1667,
      source_amount_currency: "EUR",
      practice_number: `REV-${Date.now()}`,
      ns_reference: "OPERATORE CMS",
      notes: "Review manuale test operatore"
    }
  };

  const reviewResponse = await fetch(`${appUrl}/api/email/pdf-imports/review`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(reviewPayload)
  });
  const reviewBody = await reviewResponse.json();
  if (!reviewResponse.ok) {
    throw new Error(`Review failed: ${JSON.stringify(reviewBody)}`);
  }

  const confirmResponse = await fetch(`${appUrl}/api/email/confirm-pdf`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ inbound_email_id: inboundEmailId })
  });
  const confirmBody = await confirmResponse.json();
  if (!confirmResponse.ok || !confirmBody.final_service_id) {
    throw new Error(`Confirm failed: ${JSON.stringify(confirmBody)}`);
  }

  const { data: serviceRow, error: serviceError } = await admin
    .from("services")
    .select("id, customer_name, phone, customer_email, arrival_date, arrival_time, departure_date, departure_time, pax, notes, status, booking_service_kind, service_type_code, billing_party_name, source_total_amount_cents, source_price_per_pax_cents, source_amount_currency, outbound_time, return_time")
    .eq("id", confirmBody.final_service_id)
    .maybeSingle();
  if (serviceError || !serviceRow?.id) {
    throw new Error(serviceError?.message ?? "Service finale non trovato");
  }

  const { data: inboundRow, error: inboundError } = await admin
    .from("inbound_emails")
    .select("parsed_json")
    .eq("id", inboundEmailId)
    .maybeSingle();
  if (inboundError || !inboundRow?.parsed_json) {
    throw new Error(inboundError?.message ?? "Inbound review non trovata");
  }

  console.log(
    JSON.stringify(
        {
        source_mode: sourceMode,
        inbound_email_id: inboundEmailId,
        review_saved: inboundRow.parsed_json?.pdf_import?.has_manual_review ?? false,
        reviewed_at: inboundRow.parsed_json?.pdf_import?.reviewed_at ?? null,
        confirm_outcome: confirmBody.outcome,
        final_service_id: confirmBody.final_service_id,
        final_service: serviceRow,
        effective_normalized: inboundRow.parsed_json?.pdf_import?.effective_normalized ?? null
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
