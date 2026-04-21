import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import type { PricingAuthContext } from "@/lib/server/pricing-auth";
import { requireQuotesAccess } from "@/lib/server/quotes-access";
import { emailButton, emailDataTable, emailHtml } from "@/lib/server/email-layout";
import { getVerifiedFromEmail, resendFetch } from "@/lib/server/send-email";

export const runtime = "nodejs";

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const quoteServiceCodeSchema = z.enum([
  "transfer_port_hotel",
  "transfer_airport_hotel",
  "transfer_airport_hotel_exclusive",
  "transfer_airport_hotel_aliscafo",
  "transfer_train_hotel",
  "transfer_train_hotel_exclusive",
  "transfer_train_hotel_aliscafo",
  "bus_city_hotel",
  "excursion",
  "formula_snav",
  "formula_medmar_napoli",
  "formula_medmar_pozzuoli",
]);

const quoteSchema = z.object({
  quote_service_code: quoteServiceCodeSchema.optional(),
  quote_bus_line_id: z.string().uuid().nullable().optional(),
  service_kind: z.string().min(2).max(120),
  route_label: z.string().min(2).max(200),
  price_cents: z.number().int().min(0),
  currency: z.string().length(3).default("EUR"),
  passenger_count: z.number().int().min(1).max(120).nullable(),
  arrival_date: isoDateSchema.nullable().optional(),
  departure_date: isoDateSchema.nullable().optional(),
  valid_until: isoDateSchema.nullable(),
  notes: z.string().max(2000).nullable(),
  waypoints: z.array(z.string().min(2).max(120)).max(20).optional(),
  pickup_waypoints: z.array(z.string().min(2).max(120)).max(40).optional(),
  dropoff_waypoints: z.array(z.string().min(2).max(120)).max(40).optional(),
  client_name: z.string().max(200).nullable().optional(),
  client_email: z.string().email().nullable().optional(),
});

async function loadQuotes(auth: PricingAuthContext) {
  const tenantId = auth.membership.tenant_id;
  const [quotesResult, waypointsResult, flagsResult, busLinesResult, busStopsResult] = await Promise.all([
    auth.admin.from("quotes").select("*").eq("tenant_id", tenantId).order("created_at", { ascending: false }),
    auth.admin.from("quote_waypoints").select("*").eq("tenant_id", tenantId).order("sort_order"),
    auth.admin.from("tenant_user_feature_flags").select("*").eq("tenant_id", tenantId).eq("feature_code", "quotes_access"),
    auth.admin.from("tenant_bus_lines").select("id,code,name,family_code,family_name").eq("tenant_id", tenantId).eq("active", true).order("family_code").order("name"),
    auth.admin.from("tenant_bus_line_stops").select("id,bus_line_id,direction,stop_name,city,pickup_note,stop_order").eq("tenant_id", tenantId).eq("active", true).order("direction").order("stop_order"),
  ]);
  const error = quotesResult.error || waypointsResult.error || flagsResult.error || busLinesResult.error || busStopsResult.error;
  if (error) throw new Error(error.message);
  return {
    quotes: quotesResult.data ?? [],
    waypoints: waypointsResult.data ?? [],
    quote_users: flagsResult.data ?? [],
    bus_lines: busLinesResult.data ?? [],
    bus_stops: busStopsResult.data ?? [],
  };
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(value: unknown, fallback = "Non indicata"): string {
  if (!value) return fallback;
  const [year, month, day] = String(value).split("-");
  if (!year || !month || !day) return escapeHtml(value);
  return `${day}/${month}/${year}`;
}

function buildQuoteEmail(quote: Record<string, unknown>, pickupWaypoints: string[], dropoffWaypoints: string[], responseUrl: string): string {
  const price = ((quote.price_cents as number) / 100).toFixed(2);
  const currency = escapeHtml(quote.currency ?? "EUR");
  const routeLabel = escapeHtml(quote.route_label);
  const validUntil = quote.valid_until ? formatDate(quote.valid_until) : "Aperta";
  const rows: Array<[string, string]> = [
    ["Servizio", escapeHtml(quote.service_kind)],
    ["Tratta", routeLabel],
    ["Data arrivo", formatDate(quote.arrival_date)],
    ["Data partenza", formatDate(quote.departure_date)],
    ...(pickupWaypoints.length > 0 ? ([["Punti di carico", pickupWaypoints.map(escapeHtml).join(" -> ")]] as Array<[string, string]>) : []),
    ...(dropoffWaypoints.length > 0 ? ([["Punti di scarico", dropoffWaypoints.map(escapeHtml).join(" -> ")]] as Array<[string, string]>) : []),
    ["Passeggeri", quote.passenger_count ? `${escapeHtml(quote.passenger_count)} pax` : "Non indicati"],
    ["Validita offerta", validUntil],
  ];
  const notesBlock = quote.notes
    ? `<div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:12px;padding:14px 16px;margin:18px 0;font-size:13px;color:#9a3412;"><strong>Note operative:</strong><br/>${escapeHtml(quote.notes)}</div>`
    : "";

  const body = `
    <p style="font-size:15px;color:#475569;margin:0 0 18px;">
      Gentile <strong>${escapeHtml(quote.client_name ?? "Cliente")}</strong>,<br/>
      abbiamo preparato il preventivo per il servizio richiesto.
    </p>
    <div style="background:linear-gradient(135deg,#0f2744,#1e3a5f);border-radius:14px;padding:20px 24px;margin-bottom:24px;">
      <div style="font-size:11px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:rgba(255,255,255,0.55);margin-bottom:6px;">Preventivo transfer</div>
      <div style="font-size:22px;font-weight:800;color:#ffffff;">${routeLabel}</div>
      <div style="font-size:30px;font-weight:800;color:#ffffff;margin-top:12px;">${currency} ${price}</div>
      <div style="font-size:13px;color:rgba(255,255,255,0.72);margin-top:4px;">Arrivo ${formatDate(quote.arrival_date)} · Partenza ${formatDate(quote.departure_date)}</div>
    </div>
    ${emailDataTable(rows)}
    ${notesBlock}
    <p style="font-size:14px;color:#475569;margin:18px 0 8px;">
      Puoi confermare o rifiutare direttamente da qui. Dopo la conferma ti ricontatteremo per gli ultimi dettagli operativi.
    </p>
    ${emailButton("Accetta preventivo", `${responseUrl}&action=accepted`, "#166534")}
    ${emailButton("Rifiuta", `${responseUrl}&action=rejected`, "#991b1b")}
    <p style="font-size:12px;color:#94a3b8;text-align:center;margin-top:20px;">Offerta valida fino al ${validUntil}. Per informazioni contattaci via email.</p>
  `;
  return emailHtml(body, { title: `Preventivo - ${routeLabel}`, preheader: `Preventivo ${currency} ${price} - ${routeLabel}` });
}

function normalizeStopName(value: string) {
  return value.trim().replace(/\s+/g, " ").toUpperCase();
}

async function ensureBusStops(
  auth: PricingAuthContext,
  busLineId: string | null | undefined,
  direction: "arrival" | "departure",
  labels: string[]
) {
  if (!busLineId || labels.length === 0) return;
  const tenantId = auth.membership.tenant_id;
  const normalizedLabels = [...new Set(labels.map(normalizeStopName).filter(Boolean))];
  if (normalizedLabels.length === 0) return;

  const existingResult = await auth.admin
    .from("tenant_bus_line_stops")
    .select("stop_name,stop_order")
    .eq("tenant_id", tenantId)
    .eq("bus_line_id", busLineId)
    .eq("direction", direction);
  if (existingResult.error) throw new Error(existingResult.error.message);

  const existingNames = new Set((existingResult.data ?? []).map((stop: { stop_name: string }) => normalizeStopName(stop.stop_name)));
  const maxOrder = Math.max(0, ...(existingResult.data ?? []).map((stop: { stop_order: number }) => Number(stop.stop_order) || 0));
  const missing = normalizedLabels.filter((label) => !existingNames.has(label));
  if (missing.length === 0) return;

  const { error } = await auth.admin.from("tenant_bus_line_stops").insert(
    missing.map((label, index) => ({
      tenant_id: tenantId,
      bus_line_id: busLineId,
      direction,
      stop_name: label,
      city: label,
      pickup_note: "Creata da preventivo",
      stop_order: maxOrder + index + 1,
      order_index: maxOrder + index + 1,
      is_manual: true,
      active: true,
    }))
  );
  if (error) throw new Error(error.message);
}

export async function GET(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;
    const denied = await requireQuotesAccess(auth);
    if (denied) return denied;
    return NextResponse.json({ ok: true, ...(await loadQuotes(auth)) });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;
    const denied = await requireQuotesAccess(auth);
    if (denied) return denied;
    const tenantId = auth.membership.tenant_id;
    const body = await request.json().catch(() => null);
    const action = String(body?.action ?? "create_quote");

    if (action === "create_quote") {
      const parsed = quoteSchema.parse(body);
      if (parsed.quote_service_code === "bus_city_hotel" && !parsed.quote_bus_line_id) {
        return NextResponse.json({ ok: false, error: "Seleziona una linea bus per il preventivo." }, { status: 400 });
      }
      const insertResult = await auth.admin
        .from("quotes")
        .insert({
          tenant_id: tenantId,
          created_by_user_id: auth.user.id,
          owner_label: "owen",
          quote_service_code: parsed.quote_service_code ?? null,
          quote_bus_line_id: parsed.quote_service_code === "bus_city_hotel" ? parsed.quote_bus_line_id ?? null : null,
          service_kind: parsed.service_kind,
          route_label: parsed.route_label,
          price_cents: parsed.price_cents,
          currency: parsed.currency.toUpperCase(),
          passenger_count: parsed.passenger_count ?? null,
          arrival_date: parsed.arrival_date ?? null,
          departure_date: parsed.departure_date ?? null,
          valid_until: parsed.valid_until ?? null,
          notes: parsed.notes ?? null,
          client_name: parsed.client_name ?? null,
          client_email: parsed.client_email ?? null,
        })
        .select("id")
        .single();
      if (insertResult.error || !insertResult.data?.id) throw new Error(insertResult.error?.message ?? "Preventivo non creato.");
      const pickupWaypoints = parsed.pickup_waypoints?.length ? parsed.pickup_waypoints : (parsed.waypoints ?? []);
      const dropoffWaypoints = parsed.dropoff_waypoints ?? [];
      if (parsed.quote_service_code === "bus_city_hotel") {
        await ensureBusStops(auth, parsed.quote_bus_line_id, "arrival", pickupWaypoints);
        await ensureBusStops(auth, parsed.quote_bus_line_id, "departure", dropoffWaypoints);
      }
      const waypointRows = [
        ...pickupWaypoints.map((label, index) => ({
            tenant_id: tenantId,
            quote_id: insertResult.data.id,
            label,
            waypoint_type: "pickup",
            sort_order: index + 1,
        })),
        ...dropoffWaypoints.map((label, index) => ({
          tenant_id: tenantId,
          quote_id: insertResult.data.id,
          label,
          waypoint_type: "dropoff",
          sort_order: index + 1,
        })),
      ];
      if (waypointRows.length > 0) {
        await auth.admin.from("quote_waypoints").insert(waypointRows);
      }
    }

    if (action === "delete_quote") {
      const quoteId = String(body?.quote_id ?? "");
      if (!quoteId) return NextResponse.json({ ok: false, error: "quote_id mancante." }, { status: 400 });
      await auth.admin.from("quotes").delete().eq("id", quoteId).eq("tenant_id", tenantId);
    }

    if (action === "send_quote") {
      const quoteId = String(body?.quote_id ?? "");
      if (!quoteId) return NextResponse.json({ ok: false, error: "quote_id mancante." }, { status: 400 });

      const { data: quote } = await auth.admin.from("quotes").select("*").eq("id", quoteId).eq("tenant_id", tenantId).single();
      if (!quote) return NextResponse.json({ ok: false, error: "Preventivo non trovato." }, { status: 404 });
      if (!quote.client_email) return NextResponse.json({ ok: false, error: "Email cliente non impostata." }, { status: 400 });

      const { data: wps } = await auth.admin.from("quote_waypoints").select("label, waypoint_type").eq("quote_id", quoteId).order("sort_order");
      const pickupLabels = (wps ?? []).filter((w: { waypoint_type?: string | null }) => (w.waypoint_type ?? "pickup") === "pickup").map((w: { label: string }) => w.label);
      const dropoffLabels = (wps ?? []).filter((w: { waypoint_type?: string | null }) => w.waypoint_type === "dropoff").map((w: { label: string }) => w.label);

      const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://ischiatransferservice.it";
      const responseUrl = `${appUrl}/quote/respond?token=${String(quote.response_token ?? quote.id)}`;
      const html = buildQuoteEmail(quote as Record<string, unknown>, pickupLabels, dropoffLabels, responseUrl);

      const apiKey = process.env.RESEND_API_KEY;
      const fromEmail = getVerifiedFromEmail();
      if (apiKey) {
        const res = await resendFetch(apiKey, {
          from: `Ischia Transfer Service <${fromEmail}>`,
          to: [String(quote.client_email)],
          subject: `Preventivo - ${String(quote.route_label)} - ${String(quote.currency)} ${((quote.price_cents as number) / 100).toFixed(2)}`,
          html,
        });
        if (!res.ok) {
          const err = await res.text().catch(() => "");
          return NextResponse.json({ ok: false, error: `Email non inviata: ${err.slice(0, 200)}` }, { status: 500 });
        }
      }

      await auth.admin.from("quotes").update({ status: "sent" }).eq("id", quoteId).eq("tenant_id", tenantId);
    }

    if (action === "update_status") {
      const quoteId = String(body?.quote_id ?? "");
      const newStatus = String(body?.status ?? "");
      const allowed = ["draft", "sent", "accepted", "rejected", "expired"];
      if (!quoteId || !allowed.includes(newStatus)) return NextResponse.json({ ok: false, error: "Parametri non validi." }, { status: 400 });
      await auth.admin.from("quotes").update({ status: newStatus }).eq("id", quoteId).eq("tenant_id", tenantId);
    }

    if (action === "grant_owen_access") {
      const userId = String(body?.user_id ?? "");
      if (auth.membership.role !== "admin") return NextResponse.json({ ok: false, error: "Solo admin." }, { status: 403 });
      await auth.admin.from("tenant_user_feature_flags").upsert(
        { tenant_id: tenantId, user_id: userId, feature_code: "quotes_access", enabled: true },
        { onConflict: "tenant_id,user_id,feature_code" }
      );
    }

    return NextResponse.json({ ok: true, ...(await loadQuotes(auth)) });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
