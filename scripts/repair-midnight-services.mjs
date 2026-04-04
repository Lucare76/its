import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

function loadEnv(path = ".env") {
  const raw = fs.readFileSync(path, "utf8");
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

function normalizeClock(value) {
  const match = String(value ?? "").trim().match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) return null;
  return `${match[1]}:${match[2]}`;
}

function parseRecoverablePrefix(customerName) {
  const match = String(customerName ?? "").match(/^([01]\d|2[0-3]):([0-5]\d)\s+(.+)$/);
  if (!match) return null;
  const recoveredTime = normalizeClock(`${match[1]}:${match[2]}`);
  const cleanedCustomerName = match[3].trim().replace(/\s+/g, " ");
  if (!recoveredTime || !cleanedCustomerName) return null;
  return { recoveredTime, cleanedCustomerName };
}

function appendMarker(notes, marker) {
  const base = String(notes ?? "").trim();
  if (!base) return marker;
  if (base.includes(marker)) return base;
  return `${base} | ${marker}`;
}

const apply = process.argv.includes("--apply");
const env = loadEnv();
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const { data, error } = await supabase
  .from("services")
  .select("id, tenant_id, date, time, arrival_time, outbound_time, customer_name, hotel_id, inbound_email_id, notes, status, created_at")
  .eq("time", "00:00")
  .order("created_at", { ascending: true })
  .limit(500);

if (error) {
  throw new Error(error.message);
}

const recoverable = (data ?? [])
  .map((row) => ({ row, parsed: parseRecoverablePrefix(row.customer_name) }))
  .filter((item) => item.parsed && !item.row.inbound_email_id);

console.log(JSON.stringify({
  mode: apply ? "apply" : "dry-run",
  totalMidnight: (data ?? []).length,
  recoverable: recoverable.map(({ row, parsed }) => ({
    id: row.id,
    date: row.date,
    from: row.customer_name,
    toCustomerName: parsed.cleanedCustomerName,
    recoveredTime: parsed.recoveredTime
  }))
}, null, 2));

if (!apply || recoverable.length === 0) {
  process.exit(0);
}

for (const { row, parsed } of recoverable) {
  const marker = `[legacy_time_recovered:${parsed.recoveredTime}]`;
  const { error: updateError } = await supabase
    .from("services")
    .update({
      time: parsed.recoveredTime,
      arrival_time: parsed.recoveredTime,
      outbound_time: parsed.recoveredTime,
      customer_name: parsed.cleanedCustomerName,
      notes: appendMarker(row.notes, marker)
    })
    .eq("id", row.id)
    .eq("tenant_id", row.tenant_id);

  if (updateError) {
    throw new Error(`Update failed for ${row.id}: ${updateError.message}`);
  }
}

console.log(`Updated ${recoverable.length} services.`);
