/**
 * GET|POST /api/cron/vehicle-expiry-check
 *
 * Vercel Cron invoca l'endpoint via GET (senza body). POST resta disponibile
 * per i test manuali e accetta nel body `today` (YYYY-MM-DD) e `dry_run`.
 * Entrambi richiedono `Authorization: Bearer <CRON_SECRET>`.
 *
 * Una email per ogni scadenza (non più il riepilogo giornaliero):
 *  - assicurazione: 7 giorni prima della scadenza inserita e il giorno stesso
 *  - seconda rata assicurazione (pagamento semestrale): 7 giorni prima e il giorno
 *  - collaudo, bollo, estintori, carta tachigrafo autista, taratura tachigrafo:
 *    15 giorni prima e il giorno stesso
 * Ogni avviso parte una sola volta: vedi lib/server/vehicle-expiry-alerts.ts.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sendEmail } from "@/lib/server/send-email";
import { emailButton, emailDataTable, emailHighlightBox, emailHtml, fmtDate } from "@/lib/server/email-layout";
import { insuranceSuspensionStatus } from "@/lib/vehicle-compliance";
import {
  ALERT_DOC_LABEL, alertKey, alertSubject, planAlerts,
  type AlertCandidate, type PlannedAlert,
} from "@/lib/server/vehicle-expiry-alerts";

export const runtime = "nodejs";
export const maxDuration = 60;

const NOTIFY_EMAILS = ["info@ischiatransferservice.it", "luca_renna@hotmail.com"];
/** Limite di email per esecuzione: il resto parte il giorno dopo (niente raffiche). */
const MAX_ALERTS_PER_RUN = 40;
const APP_URL = "https://ischia-transfer.vercel.app";

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function buildAlertHtml(alert: PlannedAlert): string {
  const what = ALERT_DOC_LABEL[alert.docType];
  const status = alert.daysLeft > 0
    ? `scade tra <strong>${alert.daysLeft} ${alert.daysLeft === 1 ? "giorno" : "giorni"}</strong>`
    : alert.daysLeft === 0 ? "<strong>scade oggi</strong>" : `<strong>è scaduta da ${-alert.daysLeft} giorni</strong>`;
  const link = alert.vehicleId ? `${APP_URL}/fleet-ops/vehicle/${alert.vehicleId}` : `${APP_URL}/fleet-ops/scadenze`;
  return emailHtml(`
    <p>${what} del mezzo <strong>${alert.vehicleLabel}</strong>${alert.plate ? ` (${alert.plate})` : ""}: ${status}.</p>
    ${emailDataTable([
      ["Mezzo", alert.vehicleLabel],
      ["Targa", alert.plate ?? "—"],
      ["Documento", what],
      ["Scadenza", fmtDate(alert.dueDate)],
      ...(alert.detail ? [["Dettaglio", alert.detail] as [string, string]] : []),
    ])}
    ${alert.stage === "due" ? emailHighlightBox("Se è già stata rinnovata, aggiorna la scadenza nel gestionale.", "#fff7ed", "#fed7aa") : ""}
    ${emailButton("Apri le scadenze del mezzo", link)}
  `, { title: alertSubject(alert), preheader: `${what} · ${fmtDate(alert.dueDate)}` });
}

type CheckOptions = { today?: unknown; dry_run?: unknown };

async function runVehicleExpiryCheck(request: NextRequest, readOptions: () => Promise<CheckOptions>) {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/^["']|["']$/g, "");
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim().replace(/^["']|["']$/g, "");
  if (!supabaseUrl || !serviceRole) {
    return NextResponse.json({ ok: false, error: "Missing env" }, { status: 500 });
  }

  const admin = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false } });
  const body = await readOptions();
  const today = isIsoDate(body.today) ? body.today : new Date().toISOString().slice(0, 10);
  const dryRun = body.dry_run === true;

  const [vehiclesRes, insurancesRes, inspectionsRes, extinguishersRes, tachographsRes, driversRes, sentRes] = await Promise.all([
    admin.from("vehicles").select("id, tenant_id, label, plate, habitual_driver_profile_id, insurance_expiry, road_tax_expiry, inspection_expiry, tachograph_enabled").eq("active", true),
    admin.from("vehicle_insurances").select("vehicle_id, expiry_date, suspended_from, suspended_until, reactivated_on, payment_frequency, second_installment_date").eq("is_current", true),
    admin.from("vehicle_inspections").select("vehicle_id, expiry_date").eq("is_current", true),
    admin.from("vehicle_extinguishers").select("id, vehicle_id, expiry_date, serial_number").eq("active", true),
    admin.from("vehicle_tachographs").select("vehicle_id, expiry_date").eq("is_current", true),
    admin.from("driver_profiles").select("id, full_name, tachograph_card_expiry").eq("active", true).not("tachograph_card_expiry", "is", null),
    admin.from("vehicle_compliance_alerts_sent").select("tenant_id, subject_key, doc_type, due_date, stage").gte("due_date", addDays(today, -60)),
  ]);

  const queryError = [vehiclesRes, insurancesRes, inspectionsRes, extinguishersRes, tachographsRes, driversRes, sentRes]
    .find((result) => result.error)?.error;
  if (queryError) return NextResponse.json({ ok: false, error: queryError.message }, { status: 500 });

  type Insurance = { vehicle_id: string; expiry_date: string; suspended_from: string | null; suspended_until: string | null; reactivated_on: string | null; payment_frequency: string | null; second_installment_date: string | null };
  const insuranceMap = new Map<string, Insurance>();
  for (const row of (insurancesRes.data ?? []) as Insurance[]) insuranceMap.set(row.vehicle_id, row);
  const inspectionMap = new Map<string, string>();
  for (const row of (inspectionsRes.data ?? []) as Array<{ vehicle_id: string; expiry_date: string }>) inspectionMap.set(row.vehicle_id, row.expiry_date);
  const tachographMap = new Map<string, string>();
  for (const row of (tachographsRes.data ?? []) as Array<{ vehicle_id: string; expiry_date: string }>) tachographMap.set(row.vehicle_id, row.expiry_date);
  const extinguishers = (extinguishersRes.data ?? []) as Array<{ id: string; vehicle_id: string; expiry_date: string; serial_number: string | null }>;
  const drivers = new Map<string, { name: string; expiry: string }>();
  for (const row of (driversRes.data ?? []) as Array<{ id: string; full_name: string; tachograph_card_expiry: string | null }>) {
    if (row.tachograph_card_expiry) drivers.set(row.id, { name: row.full_name, expiry: row.tachograph_card_expiry });
  }
  const alreadySent = new Set(
    ((sentRes.data ?? []) as Array<{ tenant_id: string; subject_key: string; doc_type: string; due_date: string; stage: "advance" | "due" }>)
      .map((row) => alertKey({ tenantId: row.tenant_id, subjectKey: row.subject_key, docType: row.doc_type, dueDate: row.due_date }, row.stage)),
  );

  const candidates: AlertCandidate[] = [];
  const driverCardsSeen = new Set<string>();
  type Vehicle = { id: string; tenant_id: string; label: string; plate: string | null; habitual_driver_profile_id: string | null; insurance_expiry: string | null; road_tax_expiry: string | null; inspection_expiry: string | null; tachograph_enabled: boolean | null };
  for (const vehicle of (vehiclesRes.data ?? []) as Vehicle[]) {
    const base = { tenantId: vehicle.tenant_id, vehicleId: vehicle.id, vehicleLabel: vehicle.label, plate: vehicle.plate };
    const policy = insuranceMap.get(vehicle.id);
    const suspended = insuranceSuspensionStatus(today, policy?.suspended_from, policy?.suspended_until, policy?.reactivated_on) === "suspended";
    const insuranceExpiry = policy?.expiry_date ?? vehicle.insurance_expiry;
    // Polizza sospesa (mezzo fermo): niente avvisi di scadenza finché non viene riattivata.
    if (insuranceExpiry && !suspended) {
      candidates.push({ ...base, subjectKey: vehicle.id, docType: "insurance", dueDate: insuranceExpiry });
    }
    if (policy?.payment_frequency === "semiannual" && policy.second_installment_date && !suspended) {
      candidates.push({ ...base, subjectKey: vehicle.id, docType: "insurance_installment", dueDate: policy.second_installment_date });
    }
    const inspectionExpiry = inspectionMap.get(vehicle.id) ?? vehicle.inspection_expiry;
    if (inspectionExpiry) candidates.push({ ...base, subjectKey: vehicle.id, docType: "inspection", dueDate: inspectionExpiry });
    if (vehicle.road_tax_expiry) candidates.push({ ...base, subjectKey: vehicle.id, docType: "road_tax", dueDate: vehicle.road_tax_expiry });
    const calibration = tachographMap.get(vehicle.id);
    if (vehicle.tachograph_enabled && calibration) {
      candidates.push({ ...base, subjectKey: vehicle.id, docType: "tachograph_calibration", dueDate: calibration });
    }
    for (const ext of extinguishers.filter((row) => row.vehicle_id === vehicle.id)) {
      candidates.push({ ...base, subjectKey: `ext:${ext.id}`, docType: "extinguisher", dueDate: ext.expiry_date, detail: ext.serial_number ? `Matricola ${ext.serial_number}` : undefined });
    }
    const driver = vehicle.habitual_driver_profile_id ? drivers.get(vehicle.habitual_driver_profile_id) : undefined;
    // La carta è dell'autista: un solo avviso anche se è abituale su più mezzi.
    if (driver && vehicle.habitual_driver_profile_id && !driverCardsSeen.has(vehicle.habitual_driver_profile_id)) {
      driverCardsSeen.add(vehicle.habitual_driver_profile_id);
      candidates.push({ ...base, subjectKey: `driver:${vehicle.habitual_driver_profile_id}`, docType: "tachograph_card", dueDate: driver.expiry, detail: `Autista: ${driver.name}` });
    }
  }

  const planned = planAlerts(candidates, today, alreadySent);
  const batch = planned.slice(0, MAX_ALERTS_PER_RUN);
  const preview = batch.map((alert) => ({ subject: alertSubject(alert), docType: alert.docType, stage: alert.stage, dueDate: alert.dueDate, vehicle: alert.vehicleLabel, plate: alert.plate }));

  if (dryRun || batch.length === 0) {
    return NextResponse.json({ ok: true, dry_run: dryRun, today, alerts: batch.length, pending: planned.length - batch.length, sent: 0, preview });
  }

  let sent = 0;
  const failures: string[] = [];
  for (const alert of batch) {
    const result = await sendEmail({ to: NOTIFY_EMAILS, subject: alertSubject(alert), html: buildAlertHtml(alert) });
    if (!result.ok) {
      failures.push(`${alertSubject(alert)}: ${result.error ?? "errore invio"}`);
      continue;
    }
    // Email non configurata (es. sviluppo): non si registra, così partirà davvero più avanti.
    if (result.skipped) continue;
    // Registrato solo se inviato: se l'invio fallisce, si riprova al prossimo giro.
    const { error } = await admin.from("vehicle_compliance_alerts_sent").insert({
      tenant_id: alert.tenantId, vehicle_id: alert.vehicleId, subject_key: alert.subjectKey,
      doc_type: alert.docType, due_date: alert.dueDate, stage: alert.stage,
    });
    if (error && error.code !== "23505") failures.push(`${alertSubject(alert)}: inviata ma non registrata (${error.message})`);
    sent += 1;
  }

  return NextResponse.json(
    { ok: failures.length === 0, dry_run: false, today, alerts: batch.length, pending: planned.length - batch.length, sent, failures, preview },
    { status: failures.length > 0 && sent === 0 ? 502 : 200 },
  );
}

export async function GET(request: NextRequest) {
  return runVehicleExpiryCheck(request, async () => ({}));
}

export async function POST(request: NextRequest) {
  return runVehicleExpiryCheck(request, async () => (await request.json().catch(() => ({}))) as CheckOptions);
}
