/**
 * POST /api/cron/vehicle-expiry-check
 *
 * Controlla ogni giorno i veicoli con scadenza assicurazione, bollo o collaudo
 * nella finestra di avviso e invia una email di promemoria.
 *
 * Regola business assicurazione:
 * - la data inserita e' la scadenza nominale della polizza
 * - il promemoria usa la scadenza effettiva includendo i 15 giorni di proroga
 * - esempio: polizza 2026-10-01 -> copertura fino al 2026-10-15 inclusa
 * - primo alert il 2026-10-07
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import path from "node:path";

export const runtime = "nodejs";
export const maxDuration = 60;

const NOTIFY_EMAILS = ["info@ischiatransferservice.it", "luca_renna@hotmail.com"];
const WARN_DAYS = 7;
const INSURANCE_GRACE_DAYS = 14;
const INSURANCE_WARN_WINDOW_DAYS = 8;

let cachedLogoDataUri: string | null | undefined;

type WarningItem = {
  label: string;
  plate: string | null;
  docType: string;
  expiryDate: string;
  effectiveExpiryDate: string;
  daysLeft: number;
  note?: string;
};

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

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function getEffectiveExpiry(docType: string, expiry: string): string {
  if (docType === "Assicurazione") {
    return addDays(expiry, INSURANCE_GRACE_DAYS);
  }
  return expiry;
}

function getWarnWindowDays(docType: string): number {
  return docType === "Assicurazione" ? INSURANCE_WARN_WINDOW_DAYS : WARN_DAYS;
}

function getLogoDataUri() {
  if (cachedLogoDataUri !== undefined) return cachedLogoDataUri;
  try {
    const filePath = path.join(process.cwd(), "public", "brand", "logo-ischia-transfer-email.png");
    const base64 = readFileSync(filePath).toString("base64");
    cachedLogoDataUri = `data:image/png;base64,${base64}`;
  } catch {
    cachedLogoDataUri = null;
  }
  return cachedLogoDataUri;
}

async function sendEmail(subject: string, html: string) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.AGENCY_BOOKING_FROM_EMAIL ?? "noreply@ischiatransfer.it";
  if (!key) {
    return { ok: false, error: "RESEND_API_KEY mancante" } as const;
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      from: `Ischia Transfer Service <${from}>`,
      to: NOTIFY_EMAILS,
      subject,
      html,
    }),
  });

  const responseText = await response.text().catch(() => "");
  if (!response.ok) {
    return {
      ok: false,
      error: `Resend ${response.status}${responseText ? `: ${responseText}` : ""}`,
    } as const;
  }

  return { ok: true, responseText } as const;
}

function buildStatusLabel(daysLeft: number) {
  if (daysLeft < 0) return `SCADUTO da ${Math.abs(daysLeft)} giorni`;
  if (daysLeft === 0) return "SCADE OGGI";
  return `Scade tra ${daysLeft} giorn${daysLeft === 1 ? "o" : "i"}`;
}

function buildEmailHtml(warnings: WarningItem[]): string {
  const logoDataUri = getLogoDataUri();
  const expiredCount = warnings.filter((item) => item.daysLeft < 0).length;
  const dueTodayCount = warnings.filter((item) => item.daysLeft === 0).length;
  const upcomingCount = warnings.filter((item) => item.daysLeft > 0).length;

  const rows = warnings
    .map((warning, index) => {
      const rowBg = index % 2 === 0 ? "#ffffff" : "#f8fafc";
      const badgeBg =
        warning.docType === "Assicurazione"
          ? "#dbeafe"
          : warning.docType === "Collaudo"
            ? "#fee2e2"
            : "#fef3c7";
      const badgeColor =
        warning.docType === "Assicurazione"
          ? "#1d4ed8"
          : warning.docType === "Collaudo"
            ? "#b91c1c"
            : "#92400e";
      const statusColor = warning.daysLeft < 0 ? "#dc2626" : warning.daysLeft <= 3 ? "#d97706" : "#0f766e";

      return `
        <tr>
          <td style="padding:12px 14px;border-bottom:1px solid #e2e8f0;background:${rowBg};font-size:14px;font-weight:700;color:#0f172a">${warning.label}</td>
          <td style="padding:12px 14px;border-bottom:1px solid #e2e8f0;background:${rowBg};font-size:13px;color:#475569;font-family:Consolas,'Courier New',monospace">${warning.plate ?? "-"}</td>
          <td style="padding:12px 14px;border-bottom:1px solid #e2e8f0;background:${rowBg}">
            <span style="display:inline-block;background:${badgeBg};color:${badgeColor};padding:5px 10px;border-radius:999px;font-size:12px;font-weight:700">${warning.docType}</span>
          </td>
          <td style="padding:12px 14px;border-bottom:1px solid #e2e8f0;background:${rowBg};font-size:14px;font-weight:700;color:${statusColor}">
            ${buildStatusLabel(warning.daysLeft)}
          </td>
          <td style="padding:12px 14px;border-bottom:1px solid #e2e8f0;background:${rowBg};font-size:14px;color:#0f172a;font-weight:700">
            ${formatDate(warning.effectiveExpiryDate)}
            ${warning.note ? `<div style="padding-top:4px;font-size:11px;line-height:1.5;color:#64748b;font-weight:400">${warning.note}</div>` : ""}
          </td>
        </tr>
      `;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Promemoria documenti flotta</title>
</head>
<body style="margin:0;padding:0;background:#eef4fb;font-family:Arial,'Segoe UI',sans-serif;color:#1e293b">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#eef4fb">
    <tr>
      <td align="center" style="padding:32px 16px">
        <table role="presentation" width="760" cellpadding="0" cellspacing="0" border="0" style="width:760px;max-width:760px;background:#ffffff;border:1px solid #dbe3ee;border-radius:28px;overflow:hidden;box-shadow:0 18px 48px rgba(15,23,42,0.10)">
          <tr>
            <td bgcolor="#173f6b" style="background-color:#173f6b;background:#173f6b;padding:34px 34px 28px">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td valign="middle" style="width:260px;padding-right:24px">
                    ${
                      logoDataUri
                        ? `<div style="display:inline-block;padding:0;margin:0"><img src="${logoDataUri}" alt="Ischia Transfer Service" width="184" style="display:block;width:184px;max-width:184px;height:auto;border:0;outline:none;text-decoration:none" /></div>`
                        : `<div style="display:inline-block;background:#ffffff;color:#133b67;font-size:18px;font-weight:800;line-height:44px;padding:0 16px;border-radius:12px">ITS</div>`
                    }
                  </td>
                  <td valign="middle" align="right">
                    <div style="display:inline-block;background:rgba(255,255,255,0.14);color:#e7f0f7;padding:8px 14px;border-radius:999px;font-size:12px;font-weight:700;border:1px solid rgba(255,255,255,0.18)">
                      ${warnings.length} scadenz${warnings.length === 1 ? "a" : "e"} nella finestra di attenzione
                    </div>
                  </td>
                </tr>
                <tr>
                  <td colspan="2" style="padding-top:22px">
                    <div style="font-size:11px;letter-spacing:0.22em;text-transform:uppercase;color:#bfd7ea;font-weight:700">Fleet Alert</div>
                    <div style="padding-top:8px;font-size:34px;line-height:1.04;color:#ffffff;font-weight:800">Promemoria documenti flotta</div>
                    <div style="padding-top:14px;font-size:15px;line-height:1.7;color:#e7f0f7;max-width:610px">
                      Monitoraggio automatico delle scadenze dei mezzi Ischia Transfer Service. Per l'assicurazione la data mostrata considera sempre anche i 15 giorni di proroga.
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:26px 26px 12px">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td width="33.33%" style="padding:0 7px 14px 0">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#fff5f5;border:1px solid #fecaca;border-radius:22px">
                      <tr><td style="padding:14px 16px">
                        <div style="font-size:11px;font-weight:800;letter-spacing:0.14em;text-transform:uppercase;color:#b91c1c">Scaduti</div>
                        <div style="padding-top:8px;font-size:34px;font-weight:800;color:#991b1b">${expiredCount}</div>
                      </td></tr>
                    </table>
                  </td>
                  <td width="33.33%" style="padding:0 7px 14px 7px">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#fff7ed;border:1px solid #fed7aa;border-radius:22px">
                      <tr><td style="padding:14px 16px">
                        <div style="font-size:11px;font-weight:800;letter-spacing:0.14em;text-transform:uppercase;color:#c2410c">Oggi</div>
                        <div style="padding-top:8px;font-size:34px;font-weight:800;color:#9a3412">${dueTodayCount}</div>
                      </td></tr>
                    </table>
                  </td>
                  <td width="33.33%" style="padding:0 0 14px 7px">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:22px">
                      <tr><td style="padding:14px 16px">
                        <div style="font-size:11px;font-weight:800;letter-spacing:0.14em;text-transform:uppercase;color:#1d4ed8">Prossime</div>
                        <div style="padding-top:8px;font-size:34px;font-weight:800;color:#1d4ed8">${upcomingCount}</div>
                      </td></tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:0 26px 26px">
              <div style="font-size:12px;font-weight:800;letter-spacing:0.18em;text-transform:uppercase;color:#64748b">Dettaglio mezzi</div>
              <div style="padding-top:8px;padding-bottom:16px;font-size:14px;line-height:1.7;color:#475569">
                Qui trovi l'elenco completo dei mezzi che risultano gia scaduti oppure nella finestra di attenzione, senza escludere i casi storici piu vecchi.
              </div>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #e2e8f0;border-radius:22px;overflow:hidden">
                <tr style="background:#f8fafc">
                  <td style="padding:12px 14px;font-size:11px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;border-bottom:1px solid #e2e8f0">Veicolo</td>
                  <td style="padding:12px 14px;font-size:11px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;border-bottom:1px solid #e2e8f0">Targa</td>
                  <td style="padding:12px 14px;font-size:11px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;border-bottom:1px solid #e2e8f0">Documento</td>
                  <td style="padding:12px 14px;font-size:11px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;border-bottom:1px solid #e2e8f0">Stato</td>
                  <td style="padding:12px 14px;font-size:11px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;border-bottom:1px solid #e2e8f0">Scadenza effettiva</td>
                </tr>
                ${rows}
              </table>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:20px;background:#f8fafc;border-radius:22px">
                <tr>
                  <td style="padding:16px 18px">
                    <div style="font-size:12px;font-weight:800;letter-spacing:0.16em;text-transform:uppercase;color:#64748b">Nota assicurazione</div>
                    <div style="padding-top:8px;font-size:13px;line-height:1.7;color:#475569">
                      La data mostrata per l'assicurazione e' la scadenza effettiva, comprensiva dei 15 giorni di proroga. Esempio: polizza del 01/10 -> copertura valida fino al 15/10 incluso.
                    </div>
                  </td>
                </tr>
              </table>
              <div style="padding-top:20px;font-size:12px;line-height:1.7;color:#64748b">
                Gestisci e aggiorna le scadenze su
                <a href="https://ischia-transfer.vercel.app/fleet-ops" style="color:#1d4ed8;font-weight:700;text-decoration:none">Ischia Transfer PMS -> Flotta</a>
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
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
  const body = (await request.json().catch(() => ({}))) as { today?: unknown; dry_run?: unknown };
  const today = isIsoDate(body.today) ? body.today : new Date().toISOString().slice(0, 10);
  const dryRun = body.dry_run === true;

  const { data: vehicles, error } = await admin
    .from("vehicles")
    .select("label, plate, insurance_expiry, road_tax_expiry, inspection_expiry")
    .eq("active", true);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const warnings: WarningItem[] = [];

  for (const vehicle of vehicles ?? []) {
    const docs = [
      { docType: "Assicurazione", expiry: vehicle.insurance_expiry as string | null },
      { docType: "Bollo", expiry: vehicle.road_tax_expiry as string | null },
      { docType: "Collaudo", expiry: vehicle.inspection_expiry as string | null },
    ];

    for (const { docType, expiry } of docs) {
      if (!expiry) continue;
      const effectiveExpiryDate = getEffectiveExpiry(docType, expiry);
      const daysLeft = diffDays(today, effectiveExpiryDate);

      if (daysLeft <= getWarnWindowDays(docType)) {
        warnings.push({
          label: vehicle.label,
          plate: vehicle.plate,
          docType,
          expiryDate: expiry,
          effectiveExpiryDate,
          daysLeft,
          note:
            docType === "Assicurazione"
              ? `Polizza ${formatDate(expiry)} + proroga 15 giorni => copertura fino al ${formatDate(effectiveExpiryDate)} inclusa`
              : undefined,
        });
      }
    }
  }

  if (warnings.length === 0) {
    return NextResponse.json({ ok: true, sent: false, warnings: 0, today, dry_run: dryRun });
  }

  warnings.sort((left, right) => left.daysLeft - right.daysLeft);

  const subject = `Avviso scadenze veicoli (${warnings.length}) - Ischia Transfer`;
  let delivery: { ok: boolean; error?: string; responseText?: string } = { ok: true };

  if (!dryRun) {
    delivery = await sendEmail(subject, buildEmailHtml(warnings));
    if (!delivery.ok) {
      return NextResponse.json(
        {
          ok: false,
          sent: false,
          dry_run: false,
          today,
          warnings: warnings.length,
          error: delivery.error,
          preview: warnings,
        },
        { status: 502 }
      );
    }
  }

  return NextResponse.json({
    ok: true,
    sent: !dryRun,
    dry_run: dryRun,
    today,
    warnings: warnings.length,
    preview: warnings,
    delivery: dryRun ? null : { ok: true },
  });
}
