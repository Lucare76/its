import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ImapFlow } from "imapflow";

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

function env(name: string, fallback = "") {
  return process.env[name]?.trim() || fallback;
}

function buildMimeMessage(input: {
  from: string;
  to: string;
  subject: string;
  bodyText: string;
  filename: string;
  base64: string;
}) {
  const boundary = `----=_Part_${randomUUID()}`;
  return [
    `From: ${input.from}`,
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: 7bit",
    "",
    input.bodyText,
    "",
    `--${boundary}`,
    `Content-Type: application/pdf; name="${input.filename}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${input.filename}"`,
    "",
    input.base64.replace(/(.{76})/g, "$1\r\n"),
    "",
    `--${boundary}--`,
    ""
  ].join("\r\n");
}

async function main() {
  loadDotEnvLocal();

  const host = env("IMAP_HOST", env("EMAIL_HOST"));
  const user = env("IMAP_USER", env("EMAIL_USER"));
  const pass = env("IMAP_PASS", env("EMAIL_PASSWORD"));
  const mailbox = env("IMAP_MAILBOX", env("EMAIL_IMAP_MAILBOX", "INBOX"));
  const port = Number(env("IMAP_PORT", env("EMAIL_PORT", "993")));
  const secure = ["1", "true", "yes", "on"].includes(env("IMAP_TLS", env("EMAIL_IMAP_TLS", "true")).toLowerCase());

  if (!host || !user || !pass) {
    throw new Error("Env IMAP/EMAIL mancanti.");
  }

  const samplePath = process.argv[2] ?? "samples/review-test.pdf";
  if (!fs.existsSync(samplePath)) {
    throw new Error(`File sample non trovato: ${samplePath}`);
  }

  const filename = path.basename(samplePath);
  const pdfBase64 = fs.readFileSync(samplePath).toString("base64");
  const subject = `Mailbox PDF test ${Date.now()}`;
  const message = buildMimeMessage({
    from: env("MAILBOX_TEST_FROM", "rennasday@gmail.com"),
    to: user,
    subject,
    bodyText: "Email tecnica di test con PDF allegato per import operativo.",
    filename,
    base64: pdfBase64
  });

  const client = new ImapFlow({
    host,
    port,
    secure,
    auth: { user, pass },
    logger: false
  });

  try {
    await client.connect();
    await client.append(mailbox, message, []);
    console.log(JSON.stringify({ ok: true, mailbox, subject, filename }, null, 2));
  } finally {
    try {
      await client.logout();
    } catch {
      // ignore logout failures
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
