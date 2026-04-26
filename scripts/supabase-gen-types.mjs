import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const args = new Set(process.argv.slice(2));
const checkMode = args.has("--check");
const outputPath = resolve("lib/supabase/types.ts");
const projectId = process.env.SUPABASE_PROJECT_ID;
const accessToken = process.env.SUPABASE_ACCESS_TOKEN;

if (!projectId) {
  console.error("SUPABASE_PROJECT_ID non configurato.");
  process.exit(1);
}

if (!accessToken) {
  console.error("SUPABASE_ACCESS_TOKEN non configurato.");
  process.exit(1);
}

const result = spawnSync(
  "supabase",
  ["gen", "types", "typescript", "--project-id", projectId, "--schema", "public"],
  {
    encoding: "utf8",
    shell: true,
    env: { ...process.env, SUPABASE_ACCESS_TOKEN: accessToken },
  },
);

if (result.status !== 0) {
  process.stderr.write(result.stderr || "Errore durante supabase gen types.\n");
  process.exit(result.status ?? 1);
}

const generated = result.stdout.replace(/\r\n/g, "\n");

if (checkMode) {
  const current = readFileSync(outputPath, "utf8").replace(/\r\n/g, "\n");
  if (current !== generated) {
    console.error(`Tipi Supabase non allineati. Rigenera con: node scripts/supabase-gen-types.mjs`);
    process.exit(1);
  }
  console.log("Tipi Supabase allineati.");
  process.exit(0);
}

writeFileSync(outputPath, generated, "utf8");
console.log(`Tipi Supabase rigenerati in ${outputPath}`);
