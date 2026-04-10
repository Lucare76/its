import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const mode = process.argv[2];
const relativePath = mode === "seed" ? "supabase/seed_demo.sql" : "supabase/bootstrap.sql";
const absolutePath = path.resolve(process.cwd(), relativePath);

if (!existsSync(absolutePath)) {
  console.error(`File non trovato: ${absolutePath}`);
  process.exit(1);
}

console.log("");
console.log(`Apri Supabase -> SQL Editor -> New query`);
console.log(`Copia/incolla questo file e clicca Run:`);
console.log(absolutePath);
console.log("");
console.log("Nota: questi script non eseguono SQL automaticamente.");
console.log("L'esecuzione reale va fatta nel SQL Editor di Supabase.");
console.log("");

if (process.platform === "win32") {
  try {
    spawn("cmd", ["/c", "start", "", absolutePath], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // noop
  }
}
