import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
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

function marker(key, value) {
  return value ? `[${key}:${value}]` : null;
}

async function main() {
  loadDotEnvLocal();

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
    throw new Error("Env Supabase mancanti per setup E2E.");
  }

  const authClient = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const email = process.env.PDF_PREVIEW_USER_EMAIL || "admin@demo.com";
  const password = process.env.PDF_PREVIEW_USER_PASSWORD || "demo123";
  const signIn = await authClient.auth.signInWithPassword({ email, password });
  const userId = signIn.data.user?.id;
  if (signIn.error || !userId) {
    throw new Error(signIn.error?.message ?? "Login setup E2E fallito");
  }

  const membershipResult = await adminClient
    .from("memberships")
    .select("tenant_id")
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();
  const tenantId = membershipResult.data?.tenant_id;
  if (membershipResult.error || !tenantId) {
    throw new Error(membershipResult.error?.message ?? "Membership tenant non trovata");
  }

  const hotelResult = await adminClient
    .from("hotels")
    .select("id, name")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  const hotelId = hotelResult.data?.id;
  const hotelName = hotelResult.data?.name ?? "HOTEL E2E";
  if (hotelResult.error || !hotelId) {
    throw new Error(hotelResult.error?.message ?? "Hotel tenant non trovato");
  }

  const timestamp = Date.now();
  const uniqueRef = `E2E-DRAFT-${String(timestamp).slice(-6)}`;
  const arrivalBase = new Date();
  const departureBase = new Date(arrivalBase.getTime() + 4 * 24 * 60 * 60 * 1000);
  const arrivalDate = arrivalBase.toISOString().slice(0, 10);
  const arrivalTime = "15:10";
  const departureDate = departureBase.toISOString().slice(0, 10);
  const departureTime = "09:40";
  const customerFullName = "DRAFT OPERATIVO";
  const pdfHash = createHash("sha256").update(`pdf-${uniqueRef}`).digest("hex").slice(0, 24);
  const textHash = createHash("sha256").update(`text-${uniqueRef}`).digest("hex").slice(0, 24);
  const dedupeKey = createHash("sha256").update(`${uniqueRef}|${arrivalDate}|${hotelName}`).digest("hex").slice(0, 24);
  const compositeKey = `draft-operativo-${arrivalDate}-${hotelName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

  const normalized = {
    parser_key: "agency_default",
    parser_score: 150,
    parsing_quality: "medium",
    agency_name: "Agenzia Test Operativa",
    external_reference: uniqueRef,
    booking_kind: "transfer_port_hotel",
    service_type_deduced: "transfer",
    customer_first_name: "DRAFT",
    customer_last_name: "OPERATIVO",
    customer_full_name: customerFullName,
    customer_email: null,
    customer_phone: "3330001111",
    arrival_date: arrivalDate,
    arrival_time: arrivalTime,
    departure_date: departureDate,
    departure_time: departureTime,
    arrival_place: "PORTO DI ISCHIA",
    hotel_or_destination: hotelName,
    passengers: 2,
    notes: "Draft E2E preparato automaticamente",
    fields_found: [
      "agency_name",
      "booking_kind",
      "service_type_deduced",
      "customer_first_name",
      "customer_last_name",
      "customer_full_name",
      "customer_phone",
      "arrival_date",
      "arrival_time",
      "departure_date",
      "departure_time",
      "arrival_place",
      "hotel_or_destination",
      "passengers",
      "notes"
    ],
    missing_fields: ["customer_email"],
    include_ferry_tickets: false,
    carrier_company: "MEDMAR",
    pdf_hash: pdfHash,
    text_hash: textHash,
    dedupe_key: dedupeKey,
    dedupe_components: {
      practice_number: uniqueRef,
      ns_reference: "PLAYWRIGHT-DRAFT",
      customer_name: customerFullName,
      arrival_date: arrivalDate,
      hotel: hotelName,
      pdf_hash: pdfHash,
      text_hash: textHash,
      composite_key: compositeKey
    },
    parser_logs: ["e2e_setup:draft_created"]
  };

  const inboundEmailId = randomUUID();
  const serviceNotes = [
    "[needs_review] Draft creato da PDF preview",
    marker("source", "pdf"),
    marker("import_mode", "draft"),
    marker("imported_from_pdf_preview", "true"),
    marker("parser", normalized.parser_key),
    marker("parsing_quality", normalized.parsing_quality),
    marker("external_ref", normalized.external_reference),
    marker("practice", normalized.dedupe_components.practice_number),
    marker("ns_ref", normalized.dedupe_components.ns_reference),
    marker("pdf_hash", normalized.pdf_hash),
    marker("pdf_text_hash", normalized.text_hash),
    marker("pdf_dedupe", normalized.dedupe_key),
    marker("pdf_composite", normalized.dedupe_components.composite_key),
    normalized.notes
  ]
    .filter(Boolean)
    .join(" | ");

  const inboundInsert = await adminClient.from("inbound_emails").insert({
    id: inboundEmailId,
    tenant_id: tenantId,
    raw_text: `Draft PDF E2E ${uniqueRef}`,
    from_email: "booking@aleste-viaggi.it",
    subject: `Draft PDF E2E ${uniqueRef}`,
    body_text: `Draft PDF E2E ${uniqueRef}`,
    body_html: null,
    extracted_text: `Practice ${uniqueRef} customer ${customerFullName}`,
    raw_json: { source: "e2e_setup", fixture: "pdf-draft" },
    parsed_json: {
      source: "pdf-import-controlled",
      from_email: "booking@aleste-viaggi.it",
      subject: `Draft PDF E2E ${uniqueRef}`,
      received_at: new Date().toISOString(),
      review_status: "needs_review",
      pdf_parser: {
        key: "agency_default",
        mode: "fallback",
        score: 150,
        selection_confidence: "medium",
        selection_reason: "e2e_setup_fixture",
        fallback_reason: "e2e_controlled_setup",
        candidates: [{ key: "agency_default", mode: "fallback", score: 150, reason: "e2e_setup_fixture" }]
      },
      parser_suggestions: { template_key: "agency-default" },
      pdf_import: {
        import_mode: "draft",
        import_state: "draft",
        parser_key: normalized.parser_key,
        parsing_quality: normalized.parsing_quality,
        fields_found: normalized.fields_found,
        missing_fields: normalized.missing_fields,
        parser_logs: normalized.parser_logs,
        raw_transfer_parser: { fixture: "e2e_draft" },
        dedupe: {
          key: normalized.dedupe_key,
          external_reference: normalized.external_reference,
          ...normalized.dedupe_components
        },
        original_normalized: normalized,
        normalized,
        effective_normalized: normalized,
        reviewed_values: null,
        has_manual_review: false,
        reviewed_by: null,
        reviewed_at: null,
        linked_service_id: null
      }
    }
  });
  if (inboundInsert.error) {
    throw new Error(inboundInsert.error.message);
  }

  const serviceInsert = await adminClient
    .from("services")
    .insert({
      tenant_id: tenantId,
      inbound_email_id: inboundEmailId,
      is_draft: true,
      date: arrivalDate,
      time: arrivalTime,
      service_type: "transfer",
      direction: "arrival",
      vessel: "MEDMAR",
      pax: 2,
      hotel_id: hotelId,
      customer_name: customerFullName,
      phone: "3330001111",
      notes: serviceNotes,
      status: "needs_review",
      created_by_user_id: userId,
      booking_service_kind: "transfer_port_hotel",
      customer_first_name: "DRAFT",
      customer_last_name: "OPERATIVO",
      customer_email: null,
      arrival_date: arrivalDate,
      arrival_time: arrivalTime,
      departure_date: departureDate,
      departure_time: departureTime,
      include_ferry_tickets: false,
      ferry_details: {
        arrival_place: "PORTO DI ISCHIA",
        carrier_company: "MEDMAR"
      },
      excursion_details: {
        source: "pdf",
        import_mode: "draft",
        external_reference: uniqueRef
      }
    })
    .select("id")
    .single();
  if (serviceInsert.error || !serviceInsert.data?.id) {
    throw new Error(serviceInsert.error?.message ?? "Creazione draft service E2E fallita");
  }

  const updatedParsedJson = {
    source: "pdf-import-controlled",
    from_email: "booking@aleste-viaggi.it",
    subject: `Draft PDF E2E ${uniqueRef}`,
    received_at: new Date().toISOString(),
    review_status: "needs_review",
    pdf_parser: {
      key: "agency_default",
      mode: "fallback",
      score: 150,
      selection_confidence: "medium",
      selection_reason: "e2e_setup_fixture",
      fallback_reason: "e2e_controlled_setup",
      candidates: [{ key: "agency_default", mode: "fallback", score: 150, reason: "e2e_setup_fixture" }]
    },
    parser_suggestions: { template_key: "agency-default" },
    pdf_import: {
      import_mode: "draft",
      import_state: "draft",
      parser_key: normalized.parser_key,
      parsing_quality: normalized.parsing_quality,
      fields_found: normalized.fields_found,
      missing_fields: normalized.missing_fields,
      parser_logs: normalized.parser_logs,
      raw_transfer_parser: { fixture: "e2e_draft" },
      dedupe: {
        key: normalized.dedupe_key,
        external_reference: normalized.external_reference,
        ...normalized.dedupe_components
      },
      original_normalized: normalized,
      normalized,
      effective_normalized: normalized,
      reviewed_values: null,
      has_manual_review: false,
      reviewed_by: null,
      reviewed_at: null,
      linked_service_id: serviceInsert.data.id
    }
  };
  const inboundUpdate = await adminClient
    .from("inbound_emails")
    .update({ parsed_json: updatedParsedJson })
    .eq("id", inboundEmailId)
    .eq("tenant_id", tenantId);
  if (inboundUpdate.error) {
    throw new Error(inboundUpdate.error.message);
  }

  console.log(
    JSON.stringify(
      {
        inbound_email_id: inboundEmailId,
        draft_service_id: serviceInsert.data.id,
        external_reference: uniqueRef,
        import_state: "draft"
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
