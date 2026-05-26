/**
 * Script ONE-SHOT: crea i profili autista mancanti nel tenant ISCHIA TRANSFER.
 *
 * Autisti da creare (rilevati dal Piano del Giorno 07/05/2026):
 *   - RICCARDO      (mezzo abituale: VITO EXTRA LONG)
 *   - MARIO ZABATTA (mezzo abituale: DUCATO GRIGIO)
 *
 * ⚠️  NON eseguire automaticamente. Attendere conferma esplicita dell'utente.
 *
 * Esecuzione:
 *   pnpm exec tsx scripts/create-missing-drivers.ts
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

function loadEnv() {
  for (const file of [".env.local", ".env"]) {
    try {
      const content = readFileSync(file, "utf8");
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
        const idx = trimmed.indexOf("=");
        const key = trimmed.slice(0, idx).trim();
        const value = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
        process.env[key] ??= value;
      }
    } catch {
      // file opzionale
    }
  }
}

function norm(v: unknown) {
  return String(v ?? "").replace(/\s+/g, " ").trim().toUpperCase();
}

async function resolveTenant(admin: ReturnType<typeof createClient>) {
  const { data, error } = await admin.from("tenants").select("id,name").limit(50);
  if (error) throw error;
  const tenants = (data ?? []) as { id: string | null; name: string | null }[];
  const tenant = tenants.find((row) => norm(row.name).includes("ISCHIA TRANSFER"));
  if (!tenant?.id) throw new Error(`Tenant "ISCHIA TRANSFER" non trovato. Tenant disponibili: ${tenants.map((t) => t.name).join(", ")}`);
  return { id: tenant.id as string, name: tenant.name as string };
}

type DriverToCreate = {
  full_name: string;
  phone: string | null;
  notes: string;
};

const DRIVERS_TO_CREATE: DriverToCreate[] = [
  { full_name: "RICCARDO", phone: null, notes: "mezzo abituale: VITO EXTRA LONG" },
  { full_name: "MARIO ZABATTA", phone: null, notes: "mezzo abituale: DUCATO GRIGIO" },
];

type ProfileRow = {
  id: string;
  full_name: string;
  phone: string | null;
  active: boolean;
  user_id: string | null;
};

async function ensureDriver(
  admin: ReturnType<typeof createClient>,
  tenantId: string,
  driver: DriverToCreate,
): Promise<{ action: "created" | "reactivated" | "already_exists"; id: string; full_name: string }> {
  // Cerca per nome esatto (case-insensitive)
  const { data: existing, error: fetchErr } = await admin
    .from("driver_profiles")
    .select("id,full_name,phone,active,user_id")
    .eq("tenant_id", tenantId)
    .ilike("full_name", driver.full_name)
    .maybeSingle();

  if (fetchErr) throw new Error(`Errore ricerca "${driver.full_name}": ${fetchErr.message}`);

  const row = existing as ProfileRow | null;

  if (row?.id) {
    if (row.active) {
      return { action: "already_exists", id: row.id, full_name: row.full_name };
    }
    // Riattiva profilo disattivato
    const { error: reactivateErr } = await admin
      .from("driver_profiles")
      .update({ active: true, phone: driver.phone ?? row.phone })
      .eq("id", row.id)
      .eq("tenant_id", tenantId);
    if (reactivateErr) throw new Error(`Errore riattivazione "${driver.full_name}": ${reactivateErr.message}`);
    return { action: "reactivated", id: row.id, full_name: row.full_name };
  }

  // Crea nuovo profilo
  const { data: created, error: insertErr } = await admin
    .from("driver_profiles")
    .insert({
      tenant_id: tenantId,
      full_name: driver.full_name,
      phone: driver.phone ?? null,
      active: true,
    })
    .select("id,full_name")
    .single();

  if (insertErr || !created?.id) {
    throw new Error(`Errore creazione "${driver.full_name}": ${insertErr?.message ?? "id non restituito"}`);
  }
  return { action: "created", id: created.id as string, full_name: created.full_name as string };
}

async function main() {
  loadEnv();

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!supabaseUrl || !serviceKey) throw new Error("Mancano NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY.");

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const tenant = await resolveTenant(admin);
  console.log(`\nTenant: ${tenant.name} (${tenant.id})\n`);

  const results: object[] = [];

  for (const driver of DRIVERS_TO_CREATE) {
    const result = await ensureDriver(admin, tenant.id, driver);
    console.log(`[${result.action.toUpperCase()}] ${result.full_name} → id=${result.id}  (${driver.notes})`);
    results.push({ ...result, notes: driver.notes });
  }

  console.log("\n── Riepilogo ──────────────────────────────────────────────────────────");
  console.log(JSON.stringify(results, null, 2));

  // Verifica finale: elenca tutti i profili attivi del tenant
  const { data: allProfiles, error: listErr } = await admin
    .from("driver_profiles")
    .select("id,full_name,phone,active,user_id")
    .eq("tenant_id", tenant.id)
    .eq("active", true)
    .order("full_name");
  if (listErr) throw new Error(`Errore lista finale: ${listErr.message}`);

  console.log(`\nProfili attivi dopo lo script (${(allProfiles ?? []).length}):`);
  for (const profile of allProfiles ?? []) {
    const p = profile as ProfileRow;
    const access = p.user_id ? `✓ user_id=${p.user_id}` : "✗ senza accesso";
    console.log(`  ${p.full_name.padEnd(24)} ${access}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : JSON.stringify(err, null, 2));
  process.exit(1);
});
