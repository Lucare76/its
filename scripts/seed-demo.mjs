import { spawnSync } from "node:child_process";

const seedFile = "supabase/seed_demo.sql";

const run = spawnSync("supabase", ["db", "execute", "--file", seedFile], {
  stdio: "inherit",
  shell: process.platform === "win32"
});

if (run.status !== 0) {
  console.error("Seed demo non eseguito. Installa Supabase CLI e collega il progetto.");
  console.error(`Fallback: esegui manualmente ${seedFile} nel SQL Editor di Supabase.`);
  process.exit(run.status ?? 1);
}

console.log("Seed demo completato.");
console.log("Se hai gia creato gli utenti demo in Supabase Auth, esegui anche supabase/attach_demo_users.sql.");
