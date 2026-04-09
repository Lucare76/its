import { spawnSync } from "node:child_process";

const run = spawnSync("supabase", ["db", "execute", "--file", "supabase/seed/seed.sql"], {
  stdio: "inherit",
  shell: process.platform === "win32"
});

if (run.status !== 0) {
  console.error("Seed demo non eseguito. Installa Supabase CLI e collega il progetto.");
  console.error("Fallback: esegui manualmente supabase/seed/seed.sql nel SQL Editor di Supabase.");
  process.exit(run.status ?? 1);
}

console.log("Seed demo completato.");
