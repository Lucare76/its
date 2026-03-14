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

async function login() {
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const email = process.env.PDF_PREVIEW_USER_EMAIL || "admin@demo.com";
  const password = process.env.PDF_PREVIEW_USER_PASSWORD || "demo123";
  const signIn = await supabase.auth.signInWithPassword({ email, password });
  if (signIn.error || !signIn.data.session?.access_token) {
    throw new Error(signIn.error?.message ?? "Login fallito");
  }
  return signIn.data.session.access_token;
}

async function previewPdf(appUrl, token, samplePath, fromEmail, subject) {
  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(samplePath)], { type: "application/pdf" }), path.basename(samplePath));
  form.append("subject", subject);
  form.append("from_email", fromEmail);
  const response = await fetch(`${appUrl}/api/email/preview-pdf`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(JSON.stringify(body));
  }
  return body;
}

async function main() {
  loadDotEnvLocal();
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "http://127.0.0.1:3010").replace(/\/$/, "");
  const token = await login();
  const tests = [
    { file: "samples/prova1.pdf", fromEmail: "booking@aleste-viaggi.it", subject: "Aleste sample 1" },
    { file: "samples/prova 2.pdf", fromEmail: "booking@aleste-viaggi.it", subject: "Aleste sample 2" },
    { file: "samples/review-test.pdf", fromEmail: "ops@manual-upload.local", subject: "Fallback sample review test" }
  ];

  const results = [];
  for (const test of tests) {
    const body = await previewPdf(appUrl, token, test.file, test.fromEmail, test.subject);
    results.push({
      file: test.file,
      parser_key: body.preview?.parser?.selected_key ?? null,
      parser_mode: body.preview?.parser?.mode ?? null,
      selection_confidence: body.preview?.parser?.selection_confidence ?? null,
      selection_reason: body.preview?.parser?.selection_reason ?? null,
      fallback_reason: body.preview?.parser?.fallback_reason ?? null,
      reliability: body.preview?.reliability ?? null,
      customer: body.preview?.extracted?.customer_full_name ?? null,
      practice: body.normalized?.dedupe_components?.practice_number ?? null
    });
  }

  console.log(JSON.stringify(results, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
