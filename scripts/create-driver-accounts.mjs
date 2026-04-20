// Script one-shot: crea account auth + membership per ogni autista
// Email: nome@ischiatransferservice.it  |  Password: numero di telefono
// Esegui con: node scripts/create-driver-accounts.mjs

import { readFileSync } from "fs";
const envContent = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const getEnv = (k) => { const m = envContent.match(new RegExp(`^${k}=(.+)$`, "m")); return m ? m[1].trim().replace(/^["']|["']$/g, "") : null; };
const SUPABASE_URL = getEnv("NEXT_PUBLIC_SUPABASE_URL");
const SERVICE_KEY  = getEnv("SUPABASE_SERVICE_ROLE_KEY");
const TENANT_ID    = "d200b89a-64c7-4f8d-a430-95a33b83047a";
const DOMAIN       = "ischiatransferservice.it";

const drivers = [
  { name: "ANDY",             email: "andy",             phone: "3427771061" },
  { name: "GIUSEPPE",         email: "giuseppe",         phone: "3343411775" },
  { name: "MARIO",            email: "mario",            phone: "3351812522" },
  { name: "LEO",              email: "leo",              phone: "3387406460" },
  { name: "ILARIA",           email: "ilaria",           phone: "3479245399" },
  { name: "JAMAL",            email: "jamal",            phone: "3773536817" },
  { name: "ALBERTO SEBON",    email: "albertosebon",     phone: "3923533798" },
  { name: "ANGIOLETTO",       email: "angioletto",       phone: null         }, // nessun telefono — skip
  { name: "BIAGIO ISCHIA",    email: "biagioischia",     phone: "3407230797" },
  { name: "BIAGIO POZZUOLI",  email: "biaggiopozzuoli",  phone: "3381937706" },
  { name: "ALBERTO D'ABUNDO", email: "albertodabundo",   phone: "3347743084" },
];

async function createUser(email, password, fullName) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message ?? data.msg ?? JSON.stringify(data));
  return data.id;
}

async function insertMembership(userId, fullName) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/memberships`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      user_id: userId,
      tenant_id: TENANT_ID,
      role: "driver",
      full_name: fullName,
    }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.message ?? data.details ?? JSON.stringify(data));
  }
}

for (const d of drivers) {
  if (!d.phone) {
    console.log(`⚠️  SKIP ${d.name} — nessun numero di telefono`);
    continue;
  }
  const email = `${d.email}@${DOMAIN}`;
  try {
    const userId = await createUser(email, d.phone, d.name);
    await insertMembership(userId, d.name);
    console.log(`✅  ${d.name.padEnd(20)} → ${email}`);
  } catch (err) {
    // Se utente già esiste, segnala ma non bloccare
    if (err.message?.includes("already been registered") || err.message?.includes("already exists")) {
      console.log(`⏭️  ${d.name.padEnd(20)} → già esistente, skip`);
    } else {
      console.error(`❌  ${d.name.padEnd(20)} → ERRORE: ${err.message}`);
    }
  }
}

console.log("\nFatto. ANGIOLETTO va creato manualmente (telefono mancante).");
