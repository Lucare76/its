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

function buildForm(samplePath, subject, fromEmail) {
  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(samplePath)], { type: "application/pdf" }), path.basename(samplePath));
  form.append("subject", subject);
  form.append("from_email", fromEmail);
  return form;
}

async function main() {
  loadDotEnvLocal();
  const samplePath = process.argv[2] ?? "samples/prova1.pdf";
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "http://127.0.0.1:3010").replace(/\/$/, "");
  const token = await login();
  const fromEmail = process.env.PDF_PREVIEW_SENDER_EMAIL || "booking@aleste-viaggi.it";
  const subject = process.env.PDF_PREVIEW_SUBJECT || `Controlled PDF import ${path.basename(samplePath)}`;

  const previewResponse = await fetch(`${appUrl}/api/email/preview-pdf`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: buildForm(samplePath, subject, fromEmail)
  });
  const previewBody = await previewResponse.json();
  if (!previewResponse.ok) throw new Error(`Preview failed: ${JSON.stringify(previewBody)}`);

  const draftResponse = await fetch(`${appUrl}/api/email/import-pdf`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: buildForm(samplePath, subject, fromEmail)
  });
  const draftBody = await draftResponse.json();
  if (!draftResponse.ok) throw new Error(`Draft failed: ${JSON.stringify(draftBody)}`);

  let confirmBody = null;
  let confirmDuplicateBody = null;
  if (draftBody.inbound_email_id) {
    const confirmResponse = await fetch(`${appUrl}/api/email/confirm-pdf`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ inbound_email_id: draftBody.inbound_email_id })
    });
    confirmBody = await confirmResponse.json();
    if (!confirmResponse.ok) throw new Error(`Confirm failed: ${JSON.stringify(confirmBody)}`);

    const confirmDuplicateResponse = await fetch(`${appUrl}/api/email/confirm-pdf`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ inbound_email_id: draftBody.inbound_email_id })
    });
    confirmDuplicateBody = await confirmDuplicateResponse.json();
  }

  console.log(
    JSON.stringify(
      {
        preview: {
          reliability: previewBody.preview?.reliability,
          parser: previewBody.preview?.parser?.selected_key,
          dedupe_key: previewBody.normalized?.dedupe_key
        },
        draft: draftBody,
        confirm: confirmBody,
        confirm_duplicate: confirmDuplicateBody
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
