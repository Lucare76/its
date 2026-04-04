#!/usr/bin/env node

const url = process.env.INBOUND_URL || "https://ischia-transfer.vercel.app/api/inbound/email";
const token = process.env.EMAIL_INBOUND_TOKEN;

if (!token) {
  console.error("Missing EMAIL_INBOUND_TOKEN env var");
  process.exit(1);
}

const payload = {
  subject: process.env.INBOUND_SUBJECT || "Nuovo transfer",
  from: process.env.INBOUND_FROM || "agency@example.com",
  body_text:
    process.env.INBOUND_BODY_TEXT ||
    "Transfer arrivo 2026-03-08 ore 09:00 pax 2 Hotel La Villarosa",
  attachments: []
};

const response = await fetch(url, {
  method: "POST",
  headers: {
    "x-inbound-token": token,
    "content-type": "application/json"
  },
  body: JSON.stringify(payload)
});

const text = await response.text();
let json;
try {
  json = JSON.parse(text);
} catch {
  json = { raw: text };
}

if (!response.ok || json?.ok === false) {
  console.error(JSON.stringify({ status: response.status, ...json }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ status: response.status, ...json }, null, 2));
