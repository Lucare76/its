import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

function loadEnv(filePath = ".env") {
  const raw = fs.readFileSync(filePath, "utf8");
  return Object.fromEntries(
    raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^([^=]+)=(.*)$/);
        return match ? [match[1], match[2].replace(/^"|"$/g, "")] : null;
      })
      .filter(Boolean)
  );
}

function hasPractice(value) {
  return /\[practice:[^\]]+\]/i.test(String(value ?? ""));
}

function extractPractice(value) {
  return String(value ?? "").match(/\[practice:([^\]]+)\]/i)?.[1] ?? null;
}

function hasPdfImport(value) {
  return /\[pdf_import\]/i.test(String(value ?? ""));
}

function isMalformedYear(value) {
  return /^00\d{2}-\d{2}-\d{2}$/.test(String(value ?? ""));
}

function classify(row) {
  if (row.inbound_email_id) return "pdf_recent_no_time";
  if (isMalformedYear(row.date)) return "legacy_bad_date";
  if (hasPdfImport(row.notes) && hasPractice(row.notes)) return "pdf_legacy_no_time";
  if (hasPractice(row.notes)) return "legacy_with_reference";
  if (!row.hotel_id && !row.inbound_email_id && !row.notes) return "legacy_orphan";
  return "legacy_other";
}

const env = loadEnv();
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const { data, error } = await supabase
  .from("services")
  .select("id, tenant_id, date, time, arrival_time, outbound_time, customer_name, hotel_id, inbound_email_id, billing_party_name, notes, status, created_at")
  .eq("time", "00:00")
  .order("created_at", { ascending: true })
  .limit(500);

if (error) {
  throw new Error(error.message);
}

const rows = data ?? [];
const buckets = new Map();

for (const row of rows) {
  const bucket = classify(row);
  const current = buckets.get(bucket) ?? [];
  current.push({
    id: row.id,
    date: row.date,
    customer_name: row.customer_name,
    billing_party_name: row.billing_party_name,
    practice: extractPractice(row.notes),
    inbound_email_id: row.inbound_email_id,
    hotel_id: row.hotel_id,
    status: row.status,
    created_at: row.created_at,
    notes_preview: String(row.notes ?? "").slice(0, 220)
  });
  buckets.set(bucket, current);
}

const report = {
  generated_at: new Date().toISOString(),
  total_midnight_services: rows.length,
  bucket_counts: Object.fromEntries(Array.from(buckets.entries()).map(([key, value]) => [key, value.length])),
  buckets: Object.fromEntries(Array.from(buckets.entries()).map(([key, value]) => [key, value]))
};

const outDir = path.join(process.cwd(), "scripts", "reports");
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, "midnight-services-audit.json");
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

console.log(`Audit written to ${outPath}`);
console.log(JSON.stringify(report.bucket_counts, null, 2));
