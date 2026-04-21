"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

/* ------------------------------------------------------------------ types */

type QuoteDetail = {
  id: string;
  route_label: string;
  service_kind: string;
  price_cents: number;
  currency: string;
  passenger_count: number | null;
  arrival_date: string | null;
  departure_date: string | null;
  valid_until: string | null;
  notes: string | null;
  client_name: string | null;
  waypoints: string[];
  pickup_waypoints?: string[];
  dropoff_waypoints?: string[];
};

/* ------------------------------------------------------------------ fetch quote details (public by token) */

async function fetchQuote(token: string): Promise<QuoteDetail | null> {
  try {
    const res = await fetch(`/api/quote/details?token=${encodeURIComponent(token)}`, {
      cache: "no-store",
    });
    if (!res.ok) return null;
    const body = await res.json() as { ok?: boolean; quote?: QuoteDetail };
    return body.ok ? body.quote ?? null : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ helpers */

function fmtPrice(cents: number, currency: string) {
  return `${currency} ${(cents / 100).toFixed(2)}`;
}

function fmtDate(iso: string) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("it-IT", {
    day: "2-digit", month: "long", year: "numeric", timeZone: "Europe/Rome",
  });
}

/* ================================================================ RESPOND CONTENT */

function RespondContent() {
  const params = useSearchParams();
  const success = params.get("success");
  const error = params.get("error");
  const route = decodeURIComponent(params.get("route") ?? "");
  const status = params.get("status") ?? "";
  const token = params.get("token") ?? "";

  /* ---------- success screens */
  if (success === "accepted") {
    return (
      <div className="text-center py-4">
        <div className="text-5xl mb-4">✅</div>
        <h1 className="text-xl font-extrabold text-emerald-700 mb-2">Preventivo accettato!</h1>
        <p className="text-sm text-slate-500 max-w-xs mx-auto">
          Hai accettato il preventivo per <strong>{route}</strong>.
          Il team di Ischia Transfer Service ti contatterà a breve per confermare i dettagli.
        </p>
      </div>
    );
  }

  if (success === "rejected") {
    return (
      <div className="text-center py-4">
        <div className="text-5xl mb-4">❌</div>
        <h1 className="text-xl font-extrabold text-rose-700 mb-2">Preventivo rifiutato</h1>
        <p className="text-sm text-slate-500 max-w-xs mx-auto">
          Hai rifiutato il preventivo per <strong>{route}</strong>.
          Se hai bisogno di ulteriori informazioni, contattaci via email.
        </p>
      </div>
    );
  }

  if (error === "alreadyresponded") {
    return (
      <div className="text-center py-4">
        <div className="text-5xl mb-4">ℹ️</div>
        <h1 className="text-xl font-bold text-slate-800 mb-2">Già risposto</h1>
        <p className="text-sm text-slate-500">
          Questo preventivo è già stato {status === "accepted" ? "accettato" : status === "rejected" ? "rifiutato" : status === "expired" ? "scaduto" : "gestito"}.
        </p>
      </div>
    );
  }

  if (error === "notfound" || (!token && !success && !error)) {
    return (
      <div className="text-center py-4">
        <div className="text-5xl mb-4">⚠️</div>
        <h1 className="text-xl font-bold text-slate-800 mb-2">Link non valido</h1>
        <p className="text-sm text-slate-500">Il link è scaduto o non è valido. Contatta Ischia Transfer Service per assistenza.</p>
      </div>
    );
  }

  /* ---------- show quote for response */
  return <QuoteResponseForm token={token} />;
}

/* ================================================================ QUOTE FORM */

function QuoteResponseForm({ token }: { token: string }) {
  const params = useSearchParams();
  const action = params.get("action");

  /* When action is present, the response is handled server-side (redirect) so we just
     show the loading state briefly before the page reloads. This component is mainly
     shown when the user lands on the page without action param — they see the quote
     and click Accept/Reject. */

  const respondUrl = `/api/ops/quotes/respond?token=${encodeURIComponent(token)}`;

  return (
    <div className="space-y-5">
      <div className="text-center">
        <div className="text-4xl mb-2">📋</div>
        <h1 className="text-lg font-extrabold text-slate-900">Il tuo preventivo</h1>
        <p className="text-sm text-slate-500 mt-1">Ischia Transfer Service</p>
      </div>

      {/* Quote details fetched client-side */}
      <QuoteDetails token={token} />

      {/* CTA buttons */}
      <div className="flex flex-col gap-3 pt-2">
        <a
          href={`${respondUrl}&action=accepted`}
          style={{ display: "block", background: "#166534", color: "#fff", textDecoration: "none", textAlign: "center", padding: "14px 24px", borderRadius: "12px", fontWeight: 700, fontSize: "15px" }}
        >
          ✅ Accetta preventivo
        </a>
        <a
          href={`${respondUrl}&action=rejected`}
          style={{ display: "block", background: "#fff", color: "#991b1b", textDecoration: "none", textAlign: "center", padding: "14px 24px", borderRadius: "12px", fontWeight: 700, fontSize: "15px", border: "2px solid #fecaca" }}
        >
          ❌ Rifiuta
        </a>
      </div>

      <p style={{ fontSize: "11px", color: "#94a3b8", textAlign: "center" }}>
        Cliccando i bottoni accetti o rifiuti l&apos;offerta. Questa azione è definitiva.
      </p>
    </div>
  );
}

/* ================================================================ QUOTE DETAILS (client fetch) */

function QuoteDetails({ token }: { token: string }) {
  // React 19 use() would be ideal but we keep compatibility with react 18 patterns
  const [quote, setQuote] = React.useState<QuoteDetail | null | "loading">("loading");

  React.useEffect(() => {
    fetchQuote(token).then(setQuote);
  }, [token]);

  if (quote === "loading") {
    return (
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 animate-pulse">
        <div className="h-4 bg-slate-200 rounded w-3/4 mb-2" />
        <div className="h-4 bg-slate-200 rounded w-1/2" />
      </div>
    );
  }

  if (!quote) {
    return (
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-400 text-center">
        Dettagli non disponibili.
      </div>
    );
  }

  const rows: Array<{ label: string; value: string }> = [
    { label: "Servizio",   value: quote.service_kind },
    { label: "Tratta",     value: quote.route_label },
    { label: "Data arrivo", value: quote.arrival_date ? fmtDate(quote.arrival_date) : "Non indicata" },
    { label: "Data partenza", value: quote.departure_date ? fmtDate(quote.departure_date) : "Non indicata" },
    ...((quote.pickup_waypoints ?? quote.waypoints).length > 0 ? [{ label: "Punti di carico", value: (quote.pickup_waypoints ?? quote.waypoints).join(" → ") }] : []),
    ...((quote.dropoff_waypoints ?? []).length > 0 ? [{ label: "Punti di scarico", value: (quote.dropoff_waypoints ?? []).join(" → ") }] : []),
    ...(quote.passenger_count ? [{ label: "Passeggeri", value: `${quote.passenger_count} pax` }] : []),
    { label: "Importo",    value: fmtPrice(quote.price_cents, quote.currency) },
    { label: "Validità",   value: quote.valid_until ? fmtDate(quote.valid_until) : "Aperta" },
  ];

  return (
    <div className="space-y-3">
      {quote.client_name && (
        <p style={{ fontSize: "14px", color: "#475569" }}>
          Gentile <strong>{quote.client_name}</strong>, di seguito i dettagli dell&apos;offerta.
        </p>
      )}

      <table width="100%" cellPadding={0} cellSpacing={0} style={{ borderCollapse: "collapse", border: "1px solid #e2e8f0", borderRadius: "10px", overflow: "hidden" }}>
        <tbody>
          {rows.map((row, i) => (
            <tr key={row.label} style={{ borderBottom: i < rows.length - 1 ? "1px solid #f1f5f9" : "none" }}>
              <td style={{ padding: "10px 14px", fontSize: "13px", color: "#64748b", whiteSpace: "nowrap", width: "40%" }}>{row.label}</td>
              <td style={{ padding: "10px 14px", fontSize: row.label === "Importo" ? "16px" : "13px", fontWeight: row.label === "Importo" ? 800 : 400, color: "#0f172a" }}>{row.value}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {quote.notes && (
        <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: "10px", padding: "12px 14px", fontSize: "13px", color: "#92400e" }}>
          <strong>Note:</strong> {quote.notes}
        </div>
      )}
    </div>
  );
}

// We need React for useEffect/useState in QuoteDetails
import * as React from "react";

/* ================================================================ PAGE */

export default function QuoteRespondPage() {
  return (
    <div style={{ minHeight: "100vh", background: "#f8fafc", fontFamily: "Arial, sans-serif", display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "24px", paddingBottom: "40px" }}>
      <div style={{ background: "#fff", borderRadius: "20px", boxShadow: "0 4px 32px rgba(0,0,0,0.08)", padding: "36px 28px", maxWidth: "480px", width: "100%", margin: "0 16px" }}>
        <div style={{ textAlign: "center", marginBottom: "24px" }}>
          <p style={{ fontSize: "12px", color: "#94a3b8", margin: 0, fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase" }}>
            Ischia Transfer Service
          </p>
        </div>
        <Suspense fallback={<div style={{ textAlign: "center", padding: "32px 0", color: "#94a3b8", fontSize: "14px" }}>Caricamento...</div>}>
          <RespondContent />
        </Suspense>
      </div>
    </div>
  );
}
