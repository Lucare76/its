import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import type { PricingAuthContext } from "@/lib/server/pricing-auth";
import { requireQuotesAccess } from "@/lib/server/quotes-access";
import { emailHtml } from "@/lib/server/email-layout";

export const runtime = "nodejs";

const quoteSchema = z.object({
  service_kind: z.string().min(2).max(120),
  route_label: z.string().min(2).max(200),
  price_cents: z.number().int().min(0),
  currency: z.string().length(3).default("EUR"),
  passenger_count: z.number().int().min(1).max(120).nullable(),
  valid_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  notes: z.string().max(2000).nullable(),
  waypoints: z.array(z.string().min(2).max(120)).max(20),
  client_name: z.string().max(200).nullable().optional(),
  client_email: z.string().email().nullable().optional(),
});

async function loadQuotes(auth: PricingAuthContext) {
  const tenantId = auth.membership.tenant_id;
  const [quotesResult, waypointsResult, flagsResult] = await Promise.all([
    auth.admin.from("quotes").select("*").eq("tenant_id", tenantId).order("created_at", { ascending: false }),
    auth.admin.from("quote_waypoints").select("*").eq("tenant_id", tenantId).order("sort_order"),
    auth.admin.from("tenant_user_feature_flags").select("*").eq("tenant_id", tenantId).eq("feature_code", "quotes_access")
  ]);
  const error = quotesResult.error || waypointsResult.error || flagsResult.error;
  if (error) throw new Error(error.message);
  return {
    quotes: quotesResult.data ?? [],
    waypoints: waypointsResult.data ?? [],
    quote_users: flagsResult.data ?? []
  };
}

function buildQuoteEmail(quote: Record<string, unknown>, waypoints: string[], responseUrl: string): string {
  const price = ((quote.price_cents as number) / 100).toFixed(2);
  const validUntil = quote.valid_until ? new Date(quote.valid_until as string).toLocaleDateString("it-IT") : "Aperta";
  const waypointRows = waypoints.length
    ? `<tr><td style="padding:8px 16px;font-size:13px;color:#64748b;border-bottom:1px solid #f1f5f9;">Punti di carico</td><td style="padding:8px 16px;font-size:13px;color:#0f172a;border-bottom:1px solid #f1f5f9;">${waypoints.join(" → ")}</td></tr>`
    : "";
  const notesRow = quote.notes
    ? `<tr><td style="padding:8px 16px;font-size:13px;color:#64748b;">Note</td><td style="padding:8px 16px;font-size:13px;color:#0f172a;">${String(quote.notes)}</td></tr>`
    : "";

  const body = `
    <p style="font-size:15px;color:#475569;margin:0 0 20px;">
      Gentile <strong>${String(quote.client_name ?? "Cliente")}</strong>,<br/>
      di seguito il preventivo per il servizio richiesto.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border-radius:10px;overflow:hidden;border:1px solid #e2e8f0;margin-bottom:24px;">
      <tr><td style="padding:8px 16px;font-size:13px;color:#64748b;border-bottom:1px solid #f1f5f9;">Servizio</td><td style="padding:8px 16px;font-size:13px;font-weight:600;color:#0f172a;border-bottom:1px solid #f1f5f9;">${String(quote.service_kind)}</td></tr>
      <tr><td style="padding:8px 16px;font-size:13px;color:#64748b;border-bottom:1px solid #f1f5f9;">Tratta</td><td style="padding:8px 16px;font-size:13px;color:#0f172a;border-bottom:1px solid #f1f5f9;">${String(quote.route_label)}</td></tr>
      ${waypointRows}
      <tr><td style="padding:8px 16px;font-size:13px;color:#64748b;border-bottom:1px solid #f1f5f9;">Passeggeri</td><td style="padding:8px 16px;font-size:13px;color:#0f172a;border-bottom:1px solid #f1f5f9;">${String(quote.passenger_count ?? "N/D")}</td></tr>
      <tr><td style="padding:8px 16px;font-size:13px;color:#64748b;border-bottom:1px solid #f1f5f9;">Importo</td><td style="padding:8px 16px;font-size:15px;font-weight:800;color:#0f172a;border-bottom:1px solid #f1f5f9;">${String(quote.currency)} ${price}</td></tr>
      <tr><td style="padding:8px 16px;font-size:13px;color:#64748b;border-bottom:${notesRow ? "1px solid #f1f5f9" : "0"};">Validità offerta</td><td style="padding:8px 16px;font-size:13px;color:#0f172a;border-bottom:${notesRow ? "1px solid #f1f5f9" : "0"};">${validUntil}</td></tr>
      ${notesRow}
    </table>
    <div style="text-align:center;margin:28px 0;">
      <a href="${responseUrl}&action=accepted" style="display:inline-block;background:#166534;color:#fff;text-decoration:none;padding:12px 28px;border-radius:10px;font-weight:700;font-size:14px;margin:0 6px;">✅ Accetta preventivo</a>
      <a href="${responseUrl}&action=rejected" style="display:inline-block;background:#991b1b;color:#fff;text-decoration:none;padding:12px 28px;border-radius:10px;font-weight:700;font-size:14px;margin:0 6px;">❌ Rifiuta</a>
    </div>
    <p style="font-size:12px;color:#94a3b8;text-align:center;margin-top:20px;">Questa offerta è valida fino al ${validUntil}. Per informazioni contattaci via email.</p>
  `;
  return emailHtml(body, { title: `Preventivo — ${String(quote.route_label)}`, preheader: `Preventivo ${String(quote.currency)} ${price} · ${String(quote.route_label)}` });
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
      const insertResult = await auth.admin
        .from("quotes")
        .insert({
          tenant_id: tenantId,
          created_by_user_id: auth.user.id,
          owner_label: "owen",
          service_kind: parsed.service_kind,
          route_label: parsed.route_label,
          price_cents: parsed.price_cents,
          currency: parsed.currency.toUpperCase(),
          passenger_count: parsed.passenger_count ?? null,
          valid_until: parsed.valid_until ?? null,
          notes: parsed.notes ?? null,
          client_name: parsed.client_name ?? null,
          client_email: parsed.client_email ?? null,
        })
        .select("id")
        .single();
      if (insertResult.error || !insertResult.data?.id) throw new Error(insertResult.error?.message ?? "Preventivo non creato.");
      if (parsed.waypoints.length > 0) {
        await auth.admin.from("quote_waypoints").insert(
          parsed.waypoints.map((label, index) => ({
            tenant_id: tenantId,
            quote_id: insertResult.data.id,
            label,
            sort_order: index + 1
          }))
        );
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

      const { data: wps } = await auth.admin.from("quote_waypoints").select("label").eq("quote_id", quoteId).order("sort_order");
      const waypointLabels = (wps ?? []).map((w: { label: string }) => w.label);

      const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://ischiatransferservice.it";
      const responseUrl = `${appUrl}/quote/respond?token=${String(quote.response_token ?? quote.id)}`;
      const html = buildQuoteEmail(quote as Record<string, unknown>, waypointLabels, responseUrl);

      const apiKey = process.env.RESEND_API_KEY;
      const fromEmail = process.env.AGENCY_BOOKING_FROM_EMAIL ?? "noreply@ischiatransferservice.it";
      if (apiKey) {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            from: `Ischia Transfer Service <${fromEmail}>`,
            to: [String(quote.client_email)],
            subject: `Preventivo — ${String(quote.route_label)} · ${String(quote.currency)} ${((quote.price_cents as number) / 100).toFixed(2)}`,
            html,
          }),
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
