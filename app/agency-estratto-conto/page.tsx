"use client";

import { useEffect, useMemo, useState } from "react";

type InvoiceLineItem = {
  service_id: string;
  numero_pratica: string;
  cliente_nome: string;
  data_servizio: string;
  tipo_servizio: string;
  importo_cents: number;
};

type InvoiceInfo = {
  id: string;
  agency_name: string;
  period_from: string;
  period_to: string;
  total_cents: number;
  services_count: number;
  invoice_data: InvoiceLineItem[];
  agency_review_status: "pending" | "approved" | "disputed";
};

type DisputeRow = {
  id: string;
  service_id: string;
  proposed_price_cents: number;
  status: "pending" | "approved" | "rejected";
};

type EditState = { price: string; note: string };

function formatDate(iso: string) {
  return iso?.split("-").reverse().join("/") ?? iso;
}

function formatEur(cents: number) {
  return `${(cents / 100).toFixed(2).replace(".", ",")} €`;
}

function statusLabel(status: DisputeRow["status"]) {
  if (status === "pending") return { text: "⏳ In attesa di revisione ITS", color: "#92400e", bg: "#fef9c3" };
  if (status === "approved") return { text: "✓ Correzione approvata", color: "#166534", bg: "#dcfce7" };
  return { text: "✗ Correzione rifiutata", color: "#991b1b", bg: "#fee2e2" };
}

export default function EstrattoContoPubblicoPage() {
  const [token, setToken] = useState<string | null>(null);
  const [invoice, setInvoice] = useState<InvoiceInfo | null>(null);
  const [disputes, setDisputes] = useState<DisputeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState("");
  const [edits, setEdits] = useState<Map<string, EditState>>(new Map());
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [doneStatus, setDoneStatus] = useState<"approved" | "disputed" | null>(null);

  const load = async (t: string) => {
    const res = await fetch(`/api/agency/statement-token?token=${encodeURIComponent(t)}`);
    const body = await res.json().catch(() => null) as { ok?: boolean; invoice?: InvoiceInfo; disputes?: DisputeRow[]; error?: string } | null;
    if (body?.ok && body.invoice) {
      setInvoice(body.invoice);
      setDisputes(body.disputes ?? []);
    } else {
      setErrorMsg(body?.error ?? "Token non valido o scaduto.");
    }
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const t = params.get("token");
    setToken(t);
    if (!t) { setLoading(false); return; }
    load(t).finally(() => setLoading(false));
  }, []);

  const toggleEdit = (item: InvoiceLineItem) => {
    setEdits((prev) => {
      const next = new Map(prev);
      if (next.has(item.service_id)) {
        next.delete(item.service_id);
      } else {
        next.set(item.service_id, { price: (item.importo_cents / 100).toFixed(2).replace(".", ","), note: "" });
      }
      return next;
    });
  };

  const updateEdit = (serviceId: string, patch: Partial<EditState>) => {
    setEdits((prev) => {
      const next = new Map(prev);
      const current = next.get(serviceId);
      if (current) next.set(serviceId, { ...current, ...patch });
      return next;
    });
  };

  const editsCount = edits.size;

  const submitApprove = async () => {
    if (!token) return;
    setSubmitting(true);
    setSubmitError("");
    try {
      const res = await fetch("/api/agency/statement-token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, action: "approve" }),
      });
      const body = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !body?.ok) { setSubmitError(body?.error ?? "Errore invio."); return; }
      setDoneStatus("approved");
    } catch {
      setSubmitError("Errore di rete.");
    } finally {
      setSubmitting(false);
    }
  };

  const submitDispute = async () => {
    if (!token || editsCount === 0) return;
    for (const [, e] of edits) {
      const parsed = Number(e.price.trim().replace(",", "."));
      if (!Number.isFinite(parsed) || parsed < 0) { setSubmitError("Uno degli importi non è valido."); return; }
    }
    setSubmitting(true);
    setSubmitError("");
    try {
      const corrections = Array.from(edits.entries()).map(([service_id, e]) => ({
        service_id,
        proposed_price_cents: Math.round(Number(e.price.trim().replace(",", ".")) * 100),
        note: e.note.trim() || undefined,
      }));
      const res = await fetch("/api/agency/statement-token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, action: "dispute", corrections }),
      });
      const body = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !body?.ok) { setSubmitError(body?.error ?? "Errore invio."); return; }
      setDoneStatus("disputed");
    } catch {
      setSubmitError("Errore di rete.");
    } finally {
      setSubmitting(false);
    }
  };

  const alreadyReviewed = useMemo(() => invoice && invoice.agency_review_status !== "pending", [invoice]);

  if (loading) {
    return (
      <div style={{ fontFamily: "sans-serif", maxWidth: 480, margin: "80px auto", padding: 24, textAlign: "center" }}>
        <p style={{ color: "#64748b" }}>Caricamento...</p>
      </div>
    );
  }

  if (!invoice) {
    return (
      <div style={{ fontFamily: "sans-serif", maxWidth: 480, margin: "80px auto", padding: 24, textAlign: "center" }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>❌</div>
        <h2 style={{ color: "#991b1b", marginBottom: 8 }}>Link non valido</h2>
        <p style={{ color: "#475569" }}>{errorMsg || "Il link è scaduto o non valido. Contatta l'operatore."}</p>
      </div>
    );
  }

  if (doneStatus === "approved" || (alreadyReviewed && invoice.agency_review_status === "approved")) {
    return (
      <div style={{ fontFamily: "sans-serif", maxWidth: 480, margin: "80px auto", padding: 24, textAlign: "center" }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>✅</div>
        <h2 style={{ color: "#166534", marginBottom: 8 }}>Estratto conto confermato</h2>
        <p style={{ color: "#475569" }}>Grazie, l&apos;abbiamo segnato come corretto senza correzioni.</p>
      </div>
    );
  }

  if (doneStatus === "disputed" || (alreadyReviewed && invoice.agency_review_status === "disputed")) {
    return (
      <div style={{ fontFamily: "sans-serif", maxWidth: 480, margin: "80px auto", padding: 24, textAlign: "center" }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>📨</div>
        <h2 style={{ color: "#92400e", marginBottom: 8 }}>Correzioni inviate</h2>
        <p style={{ color: "#475569" }}>Il nostro team le rivedrà a breve. Riceverai un riscontro per ogni pratica.</p>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: "sans-serif", maxWidth: 640, margin: "40px auto", padding: 24 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: "#0f2744", marginBottom: 4 }}>Estratto conto</h1>
      <p style={{ color: "#64748b", marginBottom: 4, fontSize: 14 }}>{invoice.agency_name}</p>
      <p style={{ color: "#64748b", marginBottom: 24, fontSize: 13 }}>
        {formatDate(invoice.period_from)} — {formatDate(invoice.period_to)} · {invoice.services_count} pratiche · {formatEur(invoice.total_cents)}
      </p>

      <p style={{ fontSize: 12, color: "#94a3b8", marginBottom: 16 }}>
        Rivedi ogni riga. Se un importo è sbagliato, clicca &quot;Modifica&quot; e correggilo. Quando hai finito, invia tutto insieme in fondo alla pagina.
      </p>

      <div>
        {invoice.invoice_data.map((item) => {
          const dispute = disputes.find((d) => d.service_id === item.service_id);
          const badge = dispute ? statusLabel(dispute.status) : null;
          const editing = edits.get(item.service_id);
          return (
            <div key={item.service_id} style={{ background: editing ? "#fffbeb" : "#f8fafc", border: `1px solid ${editing ? "#fcd34d" : "#e2e8f0"}`, borderRadius: 12, padding: 16, marginBottom: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <p style={{ fontWeight: 700, fontSize: 14, color: "#1e293b", margin: 0 }}>{item.cliente_nome}</p>
                  <p style={{ fontSize: 12, color: "#64748b", margin: "2px 0 0" }}>
                    {formatDate(item.data_servizio)} · {item.tipo_servizio} · pratica {item.numero_pratica}
                  </p>
                  {badge && (
                    <span style={{ display: "inline-block", marginTop: 6, fontSize: 11, fontWeight: 600, color: badge.color, background: badge.bg, borderRadius: 999, padding: "2px 8px" }}>
                      {badge.text}
                    </span>
                  )}
                  {editing && (
                    <div style={{ marginTop: 10 }}>
                      <label style={{ display: "block", fontSize: 12, color: "#92400e", fontWeight: 600 }}>
                        Prezzo corretto (€)
                        <input
                          type="text"
                          inputMode="decimal"
                          value={editing.price}
                          onChange={(e) => updateEdit(item.service_id, { price: e.target.value })}
                          style={{ display: "block", width: 140, marginTop: 4, padding: "6px 8px", border: "1px solid #fcd34d", borderRadius: 6, fontSize: 13 }}
                        />
                      </label>
                      <label style={{ display: "block", fontSize: 12, color: "#92400e", fontWeight: 600, marginTop: 8 }}>
                        Motivazione
                        <textarea
                          rows={2}
                          value={editing.note}
                          onChange={(e) => updateEdit(item.service_id, { note: e.target.value })}
                          placeholder="Spiega perché il prezzo è sbagliato..."
                          style={{ display: "block", width: "100%", marginTop: 4, padding: "6px 8px", border: "1px solid #fcd34d", borderRadius: 6, fontSize: 13, resize: "vertical", boxSizing: "border-box" }}
                        />
                      </label>
                    </div>
                  )}
                </div>
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  <p style={{ fontWeight: 700, fontSize: 15, color: "#1e293b", margin: 0 }}>{formatEur(item.importo_cents)}</p>
                  {!dispute && (
                    <button
                      onClick={() => toggleEdit(item)}
                      style={{ marginTop: 6, background: editing ? "#92400e" : "none", color: editing ? "#fff" : "#92400e", border: "1px solid #d97706", borderRadius: 8, padding: "4px 10px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}
                    >
                      {editing ? "Annulla" : "Modifica"}
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ position: "sticky", bottom: 0, background: "#fff", borderTop: "1px solid #e2e8f0", padding: "16px 0", marginTop: 8 }}>
        {submitError && <p style={{ color: "#dc2626", fontSize: 13, marginBottom: 10 }}>{submitError}</p>}
        {editsCount === 0 ? (
          <button
            onClick={() => void submitApprove()}
            disabled={submitting}
            style={{ width: "100%", background: submitting ? "#94a3b8" : "#16a34a", color: "#fff", border: "none", borderRadius: 10, padding: "14px 0", fontSize: 15, fontWeight: 700, cursor: submitting ? "not-allowed" : "pointer" }}
          >
            {submitting ? "Invio..." : "✓ Tutto corretto, conferma"}
          </button>
        ) : (
          <button
            onClick={() => void submitDispute()}
            disabled={submitting}
            style={{ width: "100%", background: submitting ? "#94a3b8" : "#d97706", color: "#fff", border: "none", borderRadius: 10, padding: "14px 0", fontSize: 15, fontWeight: 700, cursor: submitting ? "not-allowed" : "pointer" }}
          >
            {submitting ? "Invio..." : `Invia ${editsCount} correzion${editsCount === 1 ? "e" : "i"}`}
          </button>
        )}
      </div>
    </div>
  );
}
