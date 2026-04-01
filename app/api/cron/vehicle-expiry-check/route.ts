/**
 * POST /api/cron/vehicle-expiry-check
 *
 * Controlla ogni giorno i veicoli con scadenza assicurazione, bollo o collaudo
 * entro 7 giorni e invia una email di promemoria a info@ischiatransferservice.it
 *
 * Chiamato dal cron Vercel alle 08:00 ogni giorno.
 * Header richiesto: Authorization: Bearer <CRON_SECRET>
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const maxDuration = 60;

const NOTIFY_EMAIL = "info@ischiatransferservice.it";
const WARN_DAYS = 7;

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function diffDays(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00Z`);
  const b = new Date(`${to}T00:00:00Z`);
  return Math.floor((b.getTime() - a.getTime()) / 86400000);
}

async function sendEmail(subject: string, html: string) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.AGENCY_BOOKING_FROM_EMAIL ?? "noreply@ischiatransfer.it";
  if (!key) return;
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      from: `Ischia Transfer Service <${from}>`,
      to: [NOTIFY_EMAIL],
      subject,
      html,
    }),
  });
}

function buildEmailHtml(
  warnings: Array<{
    label: string;
    plate: string | null;
    docType: string;
    expiryDate: string;
    daysLeft: number;
  }>
): string {
  const rows = warnings
    .map(
      (w) => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-weight:600">${w.label}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-family:monospace">${w.plate ?? "—"}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0">${w.docType}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-weight:600;color:${w.daysLeft < 0 ? "#dc2626" : w.daysLeft <= 3 ? "#d97706" : "#92400e"}">
          ${w.daysLeft < 0 ? `SCADUTO da ${Math.abs(w.daysLeft)} giorni` : w.daysLeft === 0 ? "SCADE OGGI" : `Scade tra ${w.daysLeft} giorn${w.daysLeft === 1 ? "o" : "i"}`}
        </td>
        <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0">${formatDate(w.expiryDate)}</td>
      </tr>`
    )
    .join("");

  return `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"></head>
    <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1e293b;max-width:680px;margin:0 auto;padding:24px">
      <h2 style="color:#b45309;margin:0 0 8px">⚠ Promemoria scadenze documenti veicoli</h2>
      <p style="color:#64748b;margin:0 0 24px">I seguenti veicoli hanno documenti in scadenza entro ${WARN_DAYS} giorni.</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead>
          <tr style="background:#f8fafc">
            <th style="padding:8px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#94a3b8;border-bottom:2px solid #e2e8f0">Veicolo</th>
            <th style="padding:8px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#94a3b8;border-bottom:2px solid #e2e8f0">Targa</th>
            <th style="padding:8px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#94a3b8;border-bottom:2px solid #e2e8f0">Documento</th>
            <th style="padding:8px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#94a3b8;border-bottom:2px solid #e2e8f0">Stato</th>
            <th style="padding:8px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#94a3b8;border-bottom:2px solid #e2e8f0">Scadenza</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="margin:24px 0 0;font-size:12px;color:#94a3b8">
        Gestisci le scadenze su <a href="https://ischia-transfer.vercel.app/fleet-ops" style="color:#3b82f6">Ischia Transfer PMS → Flotta</a>
      </p>
    </body>
    </html>`;
}

export async function POST(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRole) {
    return NextResponse.json({ ok: false, error: "Missing env" }, { status: 500 });
  }

  const admin = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false } });

  const today = new Date().toISOString().slice(0, 10);
  const warnDate = addDays(today, WARN_DAYS);

  // Recupera tutti i veicoli attivi con almeno una scadenza entro WARN_DAYS giorni
  const { data: vehicles, error } = await admin
    .from("vehicles")
    .select("label, plate, insurance_expiry, road_tax_expiry, inspection_expiry")
    .eq("active", true)
    .or(
      [
        `insurance_expiry.lte.${warnDate}`,
        `road_tax_expiry.lte.${warnDate}`,
        `inspection_expiry.lte.${warnDate}`,
      ].join(",")
    );

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const warnings: Array<{
    label: string;
    plate: string | null;
    docType: string;
    expiryDate: string;
    daysLeft: number;
  }> = [];

  for (const v of vehicles ?? []) {
    const docs = [
      { docType: "Assicurazione", expiry: v.insurance_expiry as string | null },
      { docType: "Bollo",         expiry: v.road_tax_expiry   as string | null },
      { docType: "Collaudo",      expiry: v.inspection_expiry as string | null },
    ];
    for (const { docType, expiry } of docs) {
      if (!expiry) continue;
      const daysLeft = diffDays(today, expiry);
      if (daysLeft <= WARN_DAYS) {
        warnings.push({ label: v.label, plate: v.plate, docType, expiryDate: expiry, daysLeft });
      }
    }
  }

  if (warnings.length === 0) {
    return NextResponse.json({ ok: true, sent: false, warnings: 0 });
  }

  // Ordina: prima i più urgenti
  warnings.sort((a, b) => a.daysLeft - b.daysLeft);

  const subject = `⚠ ${warnings.length} scadenz${warnings.length === 1 ? "a" : "e"} veicoli entro ${WARN_DAYS} giorni — Ischia Transfer`;
  await sendEmail(subject, buildEmailHtml(warnings));

  return NextResponse.json({ ok: true, sent: true, warnings: warnings.length });
}
