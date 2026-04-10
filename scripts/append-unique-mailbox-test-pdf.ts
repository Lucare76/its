import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
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

function escapePdfText(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function buildPdf(lines: string[]) {
  const content = [
    "BT",
    "/F1 11 Tf",
    "50 790 Td",
    "14 TL",
    ...lines.flatMap((line, index) => (index === 0 ? [`(${escapePdfText(line)}) Tj`] : ["T*", `(${escapePdfText(line)}) Tj`])),
    "ET"
  ].join("\n");

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content, "utf8")} >>\nstream\n${content}\nendstream`
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefStart = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let index = 1; index < offsets.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, "utf8");
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

  const marker = Date.now().toString().slice(-6);
  const practice = `99/${marker}`;
  const nsRef = `MAILBOX-${marker}`;
  const filename = `mailbox-test-${marker}.pdf`;
  const subject = `Mailbox PDF unique test ${practice}`;
  const pdfBuffer = buildPdf([
    `CONFERMA D'ORDINE n. ${practice} Data 13-mar-26`,
    "PRATICA DATA 1 BENEFICIARIO ns riferimento NS REFERENTE PAX",
    `${practice} 13-mar-26 ROSSI MARIO ${nsRef} 2`,
    "PROGRAMMA DESCRIZIONE DAL AL",
    "26/TRANSFER PACCHETTO TRANSFER 13-mar-26 17-mar-26",
    "DAL AL DESCRIZIONE IMPORTO TASSE PAX NUM TOTALE",
    "13-mar 15:10 TRAGHETTO NAPOLI + TRS H. ISCHIA 15:10 12,50 2 (1) 25,00",
    "13-mar 13-mar AUTO ISCHIA/HOTEL 2 (2)",
    "17-mar 09:40 TRS H. ISCHIA + TRAGHETTO NAPOLI 09:40 12,50 2 (1) 25,00",
    "17-mar 17-mar AUTO HOTEL / ISCHIA 2 (2)",
    "Dalle15:10 M.p.: PORTO DI NAPOLI PORTA DI MASSA da: NAPOLI CON MEDMAR a: CELL: 3330001111 dest: Grand Hotel Royal Ischia Porto",
    "Dalle09:40 M.p.: Grand Hotel Royal Ischia Porto da: HOTEL a: PORTO PER NAPOLI CON MEDMAR dest: PORTO DI NAPOLI",
    "Cliente: ROSSI MARIO",
    "Cellulare/Tel. 3330001111",
    "Ufficio Booking - Agenzia Test Operativa"
  ]);

  const message = buildMimeMessage({
    from: env("MAILBOX_TEST_FROM", "rennasday@gmail.com"),
    to: user,
    subject,
    bodyText: `Email tecnica di test con PDF univoco allegato. pratica ${practice}`,
    filename,
    base64: pdfBuffer.toString("base64")
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
    console.log(JSON.stringify({ ok: true, mailbox, subject, filename, practice, ns_reference: nsRef }, null, 2));
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
