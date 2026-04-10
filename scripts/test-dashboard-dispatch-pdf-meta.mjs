import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

function loadDotEnvLocal() {
  const envPath = path.resolve(".env.local");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^"|"$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

async function main() {
  loadDotEnvLocal();
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const { data: services, error } = await admin
    .from("services")
    .select("id, inbound_email_id, notes, excursion_details, customer_name, date, time, status")
    .ilike("notes", "%[source:pdf]%")
    .order("created_at", { ascending: false })
    .limit(5);
  if (error) throw error;

  const inboundIds = (services ?? []).map((item) => item.inbound_email_id).filter(Boolean);
  const { data: inboundRows, error: inboundError } = inboundIds.length
    ? await admin.from("inbound_emails").select("id, parsed_json").in("id", inboundIds)
    : { data: [], error: null };
  if (inboundError) throw inboundError;
  const inboundById = new Map((inboundRows ?? []).map((row) => [row.id, row.parsed_json]));

  const rows = (services ?? []).map((service) => {
    const parsedJson = inboundById.get(service.inbound_email_id) ?? {};
    const pdfImport = parsedJson?.pdf_import ?? {};
    const pdfParser = parsedJson?.pdf_parser ?? {};
    return {
      service_id: service.id,
      customer_name: service.customer_name,
      date: service.date,
      time: service.time,
      status: service.status,
      parser_key: pdfImport?.parser_key ?? pdfParser?.key ?? null,
      parser_mode: pdfParser?.mode ?? null,
      parsing_quality: pdfImport?.parsing_quality ?? null,
      manual_review: pdfImport?.has_manual_review ?? false,
      external_reference: pdfImport?.effective_normalized?.external_reference ?? pdfImport?.dedupe?.external_reference ?? null,
      agency_name: pdfImport?.effective_normalized?.agency_name ?? pdfImport?.original_normalized?.agency_name ?? null,
      import_state: pdfImport?.import_state ?? null
    };
  });

  console.log(JSON.stringify(rows, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
