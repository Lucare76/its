// Carica .env.local (e .env) prima di tutti i test di integrazione —
// stesso comportamento del runtime Next.js.
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());
