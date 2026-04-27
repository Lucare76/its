/**
 * Verifica che hotel_vehicle_limits sia correttamente seeded nel DB.
 *
 * La migrazione 0142 usa LIKE match sui nomi hotel per trovare hotel_id.
 * Se il nome non corrisponde, hotel_id rimane NULL e il limite non viene
 * mai applicato dall'auto-assign (che filtra per hotel_id).
 *
 * Uso: node scripts/verify-hotel-limits.mjs
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// ── Leggi .env.local ─────────────────────────────────────────────────────────

function readEnvFile() {
  const envPath = resolve(".env.local");
  if (!existsSync(envPath)) return {};
  return Object.fromEntries(
    readFileSync(envPath, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#") && l.includes("="))
      .map((l) => {
        const idx = l.indexOf("=");
        return [l.slice(0, idx).trim(), l.slice(idx + 1).trim().replace(/^"|"$/g, "")];
      })
  );
}

const env = readEnvFile();
const supabaseUrl   = process.env.NEXT_PUBLIC_SUPABASE_URL      || env.NEXT_PUBLIC_SUPABASE_URL      || "";
const serviceRole   = process.env.SUPABASE_SERVICE_ROLE_KEY     || env.SUPABASE_SERVICE_ROLE_KEY     || "";

if (!supabaseUrl || !serviceRole) {
  console.error("❌  NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY richiesti (da .env.local)");
  process.exit(1);
}

const admin = createClient(supabaseUrl, serviceRole, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ── Recupera tenant ITS ───────────────────────────────────────────────────────

const { data: tenants } = await admin.from("tenants").select("id, name").limit(10);
if (!tenants?.length) { console.error("❌  Nessun tenant trovato"); process.exit(1); }

console.log("\n📋  Tenant disponibili:");
tenants.forEach((t, i) => console.log(`   ${i + 1}. ${t.name} (${t.id})`));

// Usa il tenant di produzione: esclude "demo", preferisce "transfer"
const tenant =
  tenants.find((t) => t.name?.toLowerCase().includes("transfer")) ??
  tenants.find((t) => !t.name?.toLowerCase().includes("demo") && !t.name?.toLowerCase().includes("test")) ??
  tenants[0];
console.log(`\n✅  Tenant selezionato: ${tenant.name} (${tenant.id})\n`);

// ── Query hotel_vehicle_limits ────────────────────────────────────────────────

const { data: limits, error: limErr } = await admin
  .from("hotel_vehicle_limits")
  .select("id, hotel_id, hotel_name, max_capacity")
  .eq("tenant_id", tenant.id)
  .order("hotel_name");

if (limErr) { console.error("❌  Errore query hotel_vehicle_limits:", limErr.message); process.exit(1); }

console.log(`🏨  hotel_vehicle_limits trovati: ${limits?.length ?? 0}`);

if (!limits?.length) {
  console.log("\n⚠️  La tabella hotel_vehicle_limits è VUOTA per questo tenant.");
  console.log("   Esegui la migrazione 0142_hotel_vehicle_limits_seed.sql nel SQL editor di Supabase.\n");
  process.exit(1);
}

const withId   = limits.filter((l) => l.hotel_id);
const withNull = limits.filter((l) => !l.hotel_id);

console.log(`   ✅  Con hotel_id valido: ${withId.length}`);
console.log(`   ⚠️  Con hotel_id NULL:   ${withNull.length}`);

if (withNull.length) {
  console.log("\n❌  I seguenti hotel NON sono stati abbinati al DB (hotel_id = NULL):");
  console.log("   Il vincolo capienza NON verrà applicato dall'auto-assign:\n");
  withNull.forEach((l) => console.log(`   • "${l.hotel_name}" (cap. ${l.max_capacity} pax)`));
}

// ── Query hotels DB per suggerire correzioni ──────────────────────────────────

if (withNull.length) {
  const { data: hotels } = await admin
    .from("hotels")
    .select("id, name")
    .eq("tenant_id", tenant.id)
    .eq("is_active", true)
    .order("name");

  console.log("\n🔍  Hotel presenti nel DB (per confronto nomi):");
  hotels?.forEach((h) => console.log(`   • "${h.name}" (${h.id})`));

  console.log("\n💡  Per correggere: esegui nel SQL editor di Supabase:\n");
  withNull.forEach((l) => {
    const candidate = hotels?.find((h) =>
      h.name.toLowerCase().includes(l.hotel_name.toLowerCase()) ||
      l.hotel_name.toLowerCase().includes(h.name.toLowerCase())
    );
    if (candidate) {
      console.log(`-- "${l.hotel_name}" → probabile match: "${candidate.name}"`);
      console.log(`UPDATE public.hotel_vehicle_limits`);
      console.log(`  SET hotel_id = '${candidate.id}'`);
      console.log(`  WHERE hotel_name = '${l.hotel_name}' AND tenant_id = '${tenant.id}';\n`);
    } else {
      console.log(`-- "${l.hotel_name}" → nessun match trovato in hotels. Verifica il nome.`);
    }
  });
}

// ── Riepilogo limiti attivi ───────────────────────────────────────────────────

if (withId.length) {
  console.log("\n✅  Limiti attivi (hotel_id valido):");
  const by14 = withId.filter((l) => l.max_capacity === 14);
  const by40 = withId.filter((l) => l.max_capacity === 40);
  const other = withId.filter((l) => l.max_capacity !== 14 && l.max_capacity !== 40);

  if (by14.length) {
    console.log(`\n   Cap. max 14 pax (${by14.length} hotel):`);
    by14.forEach((l) => console.log(`   • ${l.hotel_name}`));
  }
  if (by40.length) {
    console.log(`\n   Cap. max 40 pax (${by40.length} hotel):`);
    by40.forEach((l) => console.log(`   • ${l.hotel_name}`));
  }
  if (other.length) {
    console.log(`\n   Altri limiti (${other.length} hotel):`);
    other.forEach((l) => console.log(`   • ${l.hotel_name} — ${l.max_capacity} pax`));
  }
}

if (withNull.length === 0 && limits.length > 0) {
  console.log("\n🎉  Tutti i limiti hotel sono correttamente abbinati — auto-assign li applicherà.\n");
} else {
  console.log(`\n⚠️  ${withNull.length} limiti non applicati. Usa le UPDATE sopra per correggere.\n`);
}
