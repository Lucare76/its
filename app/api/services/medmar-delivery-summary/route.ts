/**
 * GET /api/services/medmar-delivery-summary
 *
 * Contatore coda Medmar (biglietti-medmar UX PARTE 3) + "Credito e
 * fabbisogno Medmar" (evoluzione dello stesso box): sola lettura su
 * medmar_delivery_attempts / medmar_issuing_attempts / services, nessuna
 * mutazione, nessuna chiamata Medmar (no preflight live/lock/booking/
 * payment). Restituisce solo conteggi/importi/metadati minimi — mai PDF,
 * token, indirizzi email o contenuto delle email.
 */

import { NextRequest, NextResponse } from "next/server";
import { type SupabaseClient } from "@supabase/supabase-js";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import {
  summarizeMedmarDeliveryAttempts,
  summarizeMedmarIssuedAndDelivered,
  estimateMedmarUpcoming3Days,
  resolveMedmarCreditInfo,
  evaluateMedmarCredit,
  type MedmarDeliverySummaryRow,
  type MedmarIssuingActivityRow,
  type MedmarDeliveryActivityRow,
  type MedmarCandidateServiceRow,
} from "@/lib/server/medmar-booking/delivery-summary";

export const runtime = "nodejs";

const ROME_TIME_ZONE = "Europe/Rome";

/** Mezzanotte locale Europe/Rome (oggi) espressa come ISO UTC, senza dipendenze esterne. */
export function startOfTodayRomeIso(now: Date): string {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: ROME_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  const romeAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  const offsetMs = romeAsUtc - now.getTime();
  const romeMidnightAsUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), 0, 0, 0);
  return new Date(romeMidnightAsUtc - offsetMs).toISOString();
}

/** Data (YYYY-MM-DD) di "oggi" in Europe/Rome — per il range di `services.date` della stima 3gg, stessa colonna/formato gia' usata da dateFrom/dateTo in app/(app)/biglietti-medmar/page.tsx. */
function todayDateKeyRome(now: Date): string {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: ROME_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(now); // en-CA => "YYYY-MM-DD"
}

function addDaysToDateKey(dateKey: string, days: number): string {
  const d = new Date(`${dateKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Mirror server-side di isMedmarService() in app/(app)/biglietti-medmar/page.tsx (vessel contiene "medmar", case-insensitive). */
const MEDMAR_VESSEL_FILTER = "%medmar%";

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const admin = auth.admin as SupabaseClient;
  const tenantId = auth.membership.tenant_id;

  const now = new Date();
  const windowStart = startOfTodayRomeIso(now);
  const todayKey = todayDateKeyRome(now);
  const plus3Key = addDaysToDateKey(todayKey, 3);

  const [deliveryResult, issuingResult, candidateServicesResult] = await Promise.all([
    admin
      .from("medmar_delivery_attempts")
      .select("id, issuing_attempt_id, status, created_at, updated_at, delivered_at, medmar_numero, last_error_code")
      .eq("tenant_id", tenantId),
    // Ultime 200 emissioni completate: sufficienti sia per "oggi" (un solo giorno di volumi operativi
    // reali resta ben dentro questo limite) sia come base storica per la media di estimateMedmarUpcoming3Days.
    admin
      .from("medmar_issuing_attempts")
      .select("id, status, completed_at, final_total_cents, service_ids")
      .eq("tenant_id", tenantId)
      .eq("status", "completed")
      .order("completed_at", { ascending: false })
      .limit(200),
    admin
      .from("services")
      .select("id, customer_name, notes, linked_service_id, inbound_email_id, import_id, source_quote_id")
      .eq("tenant_id", tenantId)
      .eq("is_draft", false)
      .neq("status", "cancelled")
      .neq("status", "pending_cancellation")
      .gte("date", todayKey)
      .lte("date", plus3Key)
      .ilike("vessel", MEDMAR_VESSEL_FILTER),
  ]);

  if (deliveryResult.error || issuingResult.error || candidateServicesResult.error) {
    return NextResponse.json({ ok: false, error: "Errore lettura dati Medmar." }, { status: 500 });
  }

  const deliveryRows = (deliveryResult.data ?? []) as MedmarDeliverySummaryRow[];
  const issuingRows = (issuingResult.data ?? []) as MedmarIssuingActivityRow[];
  const candidateServices = (candidateServicesResult.data ?? []) as MedmarCandidateServiceRow[];

  const queueSummary = summarizeMedmarDeliveryAttempts(deliveryRows, now.toISOString(), windowStart);
  const activity = summarizeMedmarIssuedAndDelivered(
    issuingRows,
    deliveryRows as MedmarDeliveryActivityRow[],
    windowStart
  );

  const alreadyIssuedServiceIds = new Set<string>(issuingRows.flatMap((r) => r.service_ids));
  const historicalAmountsCents = issuingRows
    .map((r) => r.final_total_cents)
    .filter((v): v is number => typeof v === "number");
  const forecast = estimateMedmarUpcoming3Days(candidateServices, alreadyIssuedServiceIds, historicalAmountsCents);

  const credit = resolveMedmarCreditInfo({ MEDMAR_MANUAL_CREDIT_CENTS: process.env.MEDMAR_MANUAL_CREDIT_CENTS });
  const creditEvaluation = evaluateMedmarCredit(credit.available_cents, forecast.upcoming_3d_estimated_amount_cents);

  return NextResponse.json({
    ok: true,
    tenant_id: tenantId,
    timezone: ROME_TIME_ZONE,
    ...queueSummary,
    activity,
    forecast,
    credit,
    credit_evaluation: creditEvaluation,
  });
}
