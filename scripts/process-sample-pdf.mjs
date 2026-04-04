import fs from "node:fs";
import path from "node:path";

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
    const value = trimmed.slice(idx + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

async function main() {
  loadDotEnvLocal();

  const samplePath = process.argv[2] ?? "samples/agency-transfer-example.pdf";
  if (!fs.existsSync(samplePath)) {
    console.error(`File non trovato: ${samplePath}`);
    console.error("Esempi disponibili in samples/:");
    for (const item of fs.readdirSync("samples")) {
      console.error(`- ${item}`);
    }
    process.exit(1);
  }

  const inboundToken = process.env.EMAIL_INBOUND_TOKEN;
  if (!inboundToken) {
    console.error("EMAIL_INBOUND_TOKEN mancante.");
    process.exit(1);
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") || "http://localhost:3000";
  const base64 = fs.readFileSync(samplePath).toString("base64");
  const filename = path.basename(samplePath);

  const payload = {
    subject: process.env.INBOUND_SUBJECT || `Inbound sample ${filename}`,
    from: process.env.INBOUND_FROM || "rennasday@gmail.com",
    body_text: process.env.INBOUND_BODY_TEXT || "Import automatico da PDF allegato.",
    attachments: [
      {
        filename,
        mimetype: "application/pdf",
        base64
      }
    ]
  };

  const response = await fetch(`${appUrl}/api/inbound/email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-inbound-token": inboundToken
    },
    body: JSON.stringify(payload)
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    console.error("Errore inbound:", body ?? response.statusText);
    process.exit(1);
  }

  console.log("OK inbound draft creato:");
  console.log(JSON.stringify(body, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

