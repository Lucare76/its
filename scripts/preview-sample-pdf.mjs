import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

function loadDotEnvLocal() {
  const envPath = path.resolve(".env.local");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^"|"$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

async function main() {
  loadDotEnvLocal();

  const samplePath = process.argv[2] ?? "samples/prova1.pdf";
  if (!fs.existsSync(samplePath)) {
    console.error(`File non trovato: ${samplePath}`);
    process.exit(1);
  }

  const baseUrl = (process.env.NEXT_PUBLIC_APP_URL || "http://127.0.0.1:3010").replace(/\/$/, "");
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) {
    console.error("Env Supabase mancanti.");
    process.exit(1);
  }

  const email = process.env.PDF_PREVIEW_USER_EMAIL || "admin@demo.com";
  const password = process.env.PDF_PREVIEW_USER_PASSWORD || "demo123";
  const fromEmail = process.env.PDF_PREVIEW_SENDER_EMAIL || "agency@example.com";
  const subject = process.env.PDF_PREVIEW_SUBJECT || `Preview locale ${path.basename(samplePath)}`;

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const signIn = await supabase.auth.signInWithPassword({ email, password });
  if (signIn.error || !signIn.data.session?.access_token) {
    console.error("Login fallito:", signIn.error?.message ?? "sessione assente");
    process.exit(1);
  }

  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(samplePath)], { type: "application/pdf" }), path.basename(samplePath));
  form.append("subject", subject);
  form.append("from_email", fromEmail);

  const response = await fetch(`${baseUrl}/api/email/preview-pdf`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${signIn.data.session.access_token}`
    },
    body: form
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    console.error("Errore preview:", body ?? response.statusText);
    process.exit(1);
  }

  console.log(JSON.stringify(body, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
