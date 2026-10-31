"use client";

import { AgencyStatementPayment } from "@/components/agency-statement-payment";
import { formatInvoiceServiceDescription } from "@/lib/invoice-service-label";

import { useEffect, useState } from "react";
import { getClientSessionContext } from "@/lib/supabase/client-session";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";

type InvoiceLineItem = {
  service_id: string;
  numero_pratica: string;
  cliente_nome: string;
  data_servizio: string;
  tipo_servizio: string;
  descrizione_servizio?: string;
  pax?: number | null;
  importo_cents: number;
  arrival_date?:string|null;departure_date?:string|null;
};

type InvoiceRow = {
  id: string;
  invoice_number: string;
  date_basis: string;
  paid_cents: number;
  waived_cents: number;
  review_draft?: Array<{
    service_id: string;
    proposed_price_cents: number;
    note?: string;
  }>;
  period_from: string;
  period_to: string;
  status: string;
  total_cents: number;
  services_count: number;
  invoice_data: InvoiceLineItem[];
  created_at: string;
  sent_at: string | null;
  agency_review_status: "pending" | "approved" | "disputed";
};

type EditState = { price: string; note: string };

type DisputeRow = {
  id: string;
  agency_invoice_id: string;
  service_id: string;
  original_price_cents: number;
  proposed_price_cents: number;
  agency_note: string | null;
  status: "pending" | "approved" | "rejected";
  resolution_note: string | null;
  created_at: string;
  resolved_at: string | null;
};

function fmtDate(iso?: string | null) {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function fmtEur(cents: number | null | undefined) {
  if (cents == null) return "—";
  return `€${(cents / 100).toFixed(2).replace(".", ",")}`;
}

function DisputeBadge({ status }: { status: DisputeRow["status"] }) {
  if (status === "pending")
    return (
      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
        ⏳ Segnalazione in attesa
      </span>
    );
  if (status === "approved")
    return (
      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-800">
        ✓ Correzione approvata
      </span>
    );
  return (
    <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-semibold text-rose-800">
      ✗ Correzione rifiutata
    </span>
  );
}

export default function AgencyStatementPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [disputes, setDisputes] = useState<DisputeRow[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editsByInvoice, setEditsByInvoice] = useState<
    Map<string, Map<string, EditState>>
  >(new Map());
  const [submittingInvoiceId, setSubmittingInvoiceId] = useState<string | null>(
    null,
  );
  const [reviewError, setReviewError] = useState<string | null>(null);

  const loadAll = async (tk: string) => {
    const [invRes, dispRes] = await Promise.all([
      fetch("/api/agency/invoices", {
        headers: { Authorization: `Bearer ${tk}` },
      }),
      fetch("/api/agency/invoice-disputes", {
        headers: { Authorization: `Bearer ${tk}` },
      }),
    ]);
    const invBody = (await invRes.json().catch(() => null)) as {
      invoices?: InvoiceRow[];
      error?: string;
    } | null;
    const dispBody = (await dispRes.json().catch(() => null)) as {
      disputes?: DisputeRow[];
      error?: string;
    } | null;
    if (!invRes.ok) {
      setError(invBody?.error ?? "Errore caricamento estratti conto.");
      return;
    }
    setInvoices(invBody?.invoices ?? []);
    setEditsByInvoice(
      new Map(
        (invBody?.invoices ?? []).map((inv) => [
          inv.id,
          new Map(
            (inv.review_draft ?? []).map((c) => [
              c.service_id,
              {
                price: (c.proposed_price_cents / 100).toFixed(2),
                note: c.note ?? "",
              },
            ]),
          ),
        ]),
      ),
    );
    setDisputes(dispBody?.disputes ?? []);
  };

  useEffect(() => {
    let active = true;
    const load = async () => {
      const session = await getClientSessionContext();
      if (!active) return;
      if (!hasSupabaseEnv || !supabase || !session.tenantId) {
        setError("Area agenzia disponibile solo con Supabase reale.");
        setLoading(false);
        return;
      }
      if (session.role !== "agency" && session.role !== "admin") {
        setError("Ruolo non autorizzato.");
        setLoading(false);
        return;
      }
      const { data: sessionData } = await supabase.auth.getSession();
      const tk = sessionData.session?.access_token;
      if (!tk) {
        setError("Sessione non valida.");
        setLoading(false);
        return;
      }
      setToken(tk);
      await loadAll(tk);
      if (!active) return;
      setLoading(false);
    };
    void load();
    return () => {
      active = false;
    };
  }, []);

  const disputeForService = (serviceId: string, invoiceId: string) =>
    disputes.find(
      (d) => d.service_id === serviceId && d.agency_invoice_id === invoiceId,
    );

  const editsFor = (invoiceId: string) =>
    editsByInvoice.get(invoiceId) ?? new Map<string, EditState>();

  const toggleEdit = (invoiceId: string, item: InvoiceLineItem) => {
    setEditsByInvoice((prev) => {
      const next = new Map(prev);
      const current = new Map(
        next.get(invoiceId) ?? new Map<string, EditState>(),
      );
      if (current.has(item.service_id)) {
        current.delete(item.service_id);
      } else {
        current.set(item.service_id, {
          price: (item.importo_cents / 100).toFixed(2).replace(".", ","),
          note: "",
        });
      }
      next.set(invoiceId, current);
      return next;
    });
  };

  const updateEdit = (
    invoiceId: string,
    serviceId: string,
    patch: Partial<EditState>,
  ) => {
    setEditsByInvoice((prev) => {
      const next = new Map(prev);
      const current = new Map(
        next.get(invoiceId) ?? new Map<string, EditState>(),
      );
      const existing = current.get(serviceId);
      if (existing) current.set(serviceId, { ...existing, ...patch });
      next.set(invoiceId, current);
      return next;
    });
  };

  const saveDraft = async (invoiceId: string) => {
    if (!token) return;
    setSubmittingInvoiceId(invoiceId);
    try {
      const corrections = Array.from(editsFor(invoiceId)).map(
        ([service_id, e]) => ({
          service_id,
          proposed_price_cents: Math.round(
            Number(e.price.replace(",", ".")) * 100,
          ),
          note: e.note,
        }),
      );
      const r = await fetch(`/api/agency/invoices/${invoiceId}/review`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ action: "draft", corrections }),
      });
      const b = await r.json();
      setReviewError(
        r.ok
          ? "Bozza salvata. Nessuna email inviata."
          : (b.error ?? "Bozza non salvata."),
      );
    } catch {
      setReviewError("Errore di rete. Bozza non salvata.");
    } finally {
      setSubmittingInvoiceId(null);
    }
  };
  const submitApprove = async (invoiceId: string) => {
    if (!token) return;
    setSubmittingInvoiceId(invoiceId);
    setReviewError(null);
    const res = await fetch(`/api/agency/invoices/${invoiceId}/review`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ action: "approve" }),
    });
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    setSubmittingInvoiceId(null);
    if (!res.ok) {
      setReviewError(body?.error ?? "Errore invio.");
      return;
    }
    await loadAll(token);
  };

  const submitBatchDispute = async (invoiceId: string) => {
    if (!token) return;
    const edits = editsFor(invoiceId);
    if (edits.size === 0) return;
    for (const [, e] of edits) {
      const parsed = Number(e.price.trim().replace(",", "."));
      if (!Number.isFinite(parsed) || parsed < 0) {
        setReviewError("Uno degli importi non è valido.");
        return;
      }
    }
    setSubmittingInvoiceId(invoiceId);
    setReviewError(null);
    const corrections = Array.from(edits.entries()).map(([service_id, e]) => ({
      service_id,
      proposed_price_cents: Math.round(
        Number(e.price.trim().replace(",", ".")) * 100,
      ),
      note: e.note.trim() || undefined,
    }));
    const res = await fetch(`/api/agency/invoices/${invoiceId}/review`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ action: "dispute", corrections }),
    });
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    setSubmittingInvoiceId(null);
    if (!res.ok) {
      setReviewError(body?.error ?? "Errore invio.");
      return;
    }
    setEditsByInvoice((prev) => {
      const next = new Map(prev);
      next.delete(invoiceId);
      return next;
    });
    await loadAll(token);
  };

  return (
    <section className="mx-auto max-w-5xl page-section">
      <div className="section-head">
        <div>
          <h1 className="section-title">Estratto conto</h1>
          <p className="section-subtitle">
            Storico degli estratti conto ricevuti. Se un importo ti sembra
            sbagliato, segnalalo: verrà rivisto dal nostro team.
          </p>
        </div>
      </div>

      {error && <p className="text-sm text-rose-600">{error}</p>}
      {loading && <p className="text-sm text-slate-400">Caricamento...</p>}

      {!loading && invoices.length === 0 && !error && (
        <div className="rounded-xl bg-slate-50 border border-slate-100 px-4 py-6 text-center">
          <p className="text-sm font-medium text-slate-600">
            Nessun estratto conto ricevuto.
          </p>
        </div>
      )}

      <div className="space-y-3">
        {invoices.map((inv) => {
          const isOpen = expandedId === inv.id;
          return (
            <div key={inv.id} className="card p-4">
              <button
                type="button"
                onClick={() => setExpandedId(isOpen ? null : inv.id)}
                className="w-full flex items-center justify-between gap-3 text-left"
              >
                <div>
                  <p className="text-sm font-bold text-slate-800">
                    {inv.invoice_number} · {fmtDate(inv.period_from)} —{" "}
                    {fmtDate(inv.period_to)}
                  </p>
                  <p className="text-xs text-slate-500">
                    {inv.services_count} pratiche · inviato il{" "}
                    {inv.sent_at ? fmtDate(inv.sent_at.slice(0, 10)) : "—"}
                  </p>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <p className="text-lg font-bold text-slate-800">
                    {fmtEur(inv.total_cents)}
                  </p>
                  <span className="text-slate-400 text-sm">
                    {isOpen ? "▲" : "▼"}
                  </span>
                </div>
              </button>

              {isOpen && (
                <div className="mt-4 space-y-2 border-t border-slate-100 pt-4">
                  <p className="text-sm">
                    {inv.date_basis === "departure"
                      ? "Per data partenza"
                      : inv.date_basis === "arrival"
                        ? "Per data arrivo"
                        : "Storico"}{" "}
                    · Totale {fmtEur(inv.total_cents)} · Pagato{" "}
                    {fmtEur(inv.paid_cents ?? 0)} · Abbuoni{" "}
                    {fmtEur(inv.waived_cents ?? 0)} · Residuo{" "}
                    {fmtEur(
                      Math.max(
                        0,
                        inv.total_cents -
                          (inv.paid_cents ?? 0) -
                          (inv.waived_cents ?? 0),
                      ),
                    )}
                  </p>
                  <AgencyStatementPayment
                    invoiceId={inv.id}
                    residual={Math.max(
                      0,
                      inv.total_cents -
                        (inv.paid_cents ?? 0) -
                        (inv.waived_cents ?? 0),
                    )}
                    accessToken={token ?? undefined}
                  />
                  {inv.agency_review_status !== "pending" ? (
                    <p className="text-xs font-semibold text-slate-500">
                      {inv.agency_review_status === "approved"
                        ? "✓ Confermato corretto"
                        : "📨 Correzioni inviate"}{" "}
                      — nessuna ulteriore modifica possibile su questo estratto.
                    </p>
                  ) : null}
                  {inv.invoice_data.map((item) => {
                    const dispute = disputeForService(item.service_id, inv.id);
                    const edits = editsFor(inv.id);
                    const editing = edits.get(item.service_id);
                    const canEdit =
                      inv.agency_review_status === "pending" && !dispute;
                    return (
                      <div
                        key={item.service_id}
                        className={`rounded-xl border p-3 flex items-start justify-between gap-3 flex-wrap ${editing ? "border-amber-300 bg-amber-50" : "border-slate-100 bg-slate-50"}`}
                      >
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold text-slate-800">
                            {item.cliente_nome}
                          </p>
                          <p className="text-xs text-slate-500">
                            {fmtDate(item.data_servizio)} ·{" "}
                            {formatInvoiceServiceDescription(item)} · pratica{" "}
                            {item.numero_pratica}
                          </p>
                          {(item.arrival_date||item.departure_date)&&<p className="text-xs text-slate-500">Arrivo {fmtDate(item.arrival_date)} · Partenza {fmtDate(item.departure_date)}</p>}
                          {dispute && (
                            <div className="mt-1 flex items-center gap-2">
                              <DisputeBadge status={dispute.status} />
                              <span className="text-xs text-slate-400">
                                proposto {fmtEur(dispute.proposed_price_cents)}
                              </span>
                            </div>
                          )}
                          {editing && (
                            <div className="mt-2 space-y-2">
                              <div>
                                <label className="text-[11px] font-semibold text-amber-800">
                                  Prezzo corretto (€)
                                </label>
                                <input
                                  type="text"
                                  inputMode="decimal"
                                  value={editing.price}
                                  onChange={(e) =>
                                    updateEdit(inv.id, item.service_id, {
                                      price: e.target.value,
                                    })
                                  }
                                  className="mt-0.5 block w-28 rounded-md border border-amber-300 px-2 py-1 text-xs"
                                />
                              </div>
                              <div>
                                <label className="text-[11px] font-semibold text-amber-800">
                                  Motivazione
                                </label>
                                <textarea
                                  rows={2}
                                  value={editing.note}
                                  onChange={(e) =>
                                    updateEdit(inv.id, item.service_id, {
                                      note: e.target.value,
                                    })
                                  }
                                  placeholder="Spiega perché il prezzo è sbagliato..."
                                  className="mt-0.5 block w-full rounded-md border border-amber-300 px-2 py-1 text-xs resize-y"
                                />
                              </div>
                            </div>
                          )}
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <p className="text-sm font-bold text-slate-700">
                            {fmtEur(item.importo_cents)}
                          </p>
                          {canEdit && (
                            <button
                              type="button"
                              onClick={() => toggleEdit(inv.id, item)}
                              className={`rounded-lg border px-2.5 py-1 text-xs font-semibold ${editing ? "border-amber-600 bg-amber-600 text-white" : "border-amber-300 text-amber-700 hover:bg-amber-50"}`}
                            >
                              {editing ? "Annulla" : "Modifica"}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}

                  {inv.agency_review_status === "pending" && (
                    <div className="pt-2">
                      <p className="text-xs text-slate-500 mb-2">
                        Le modifiche restano in bozza. ITS riceve una sola
                        comunicazione con l’invio finale.
                      </p>
                      <button
                        type="button"
                        disabled={submittingInvoiceId === inv.id}
                        className="btn-secondary mb-2"
                        onClick={() => void saveDraft(inv.id)}
                      >
                        Salva bozza senza inviare
                      </button>
                      {reviewError && (
                        <p className="text-xs text-rose-600 mb-2">
                          {reviewError}
                        </p>
                      )}
                      {editsFor(inv.id).size === 0 ? (
                        <button
                          type="button"
                          onClick={() => void submitApprove(inv.id)}
                          disabled={submittingInvoiceId === inv.id}
                          className="w-full rounded-lg bg-emerald-600 px-3 py-2 text-xs font-bold text-white hover:bg-emerald-700 disabled:opacity-60"
                        >
                          {submittingInvoiceId === inv.id
                            ? "Invio..."
                            : "✓ Tutto corretto, conferma"}
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void submitBatchDispute(inv.id)}
                          disabled={submittingInvoiceId === inv.id}
                          className="w-full rounded-lg bg-amber-600 px-3 py-2 text-xs font-bold text-white hover:bg-amber-700 disabled:opacity-60"
                        >
                          {submittingInvoiceId === inv.id
                            ? "Invio..."
                            : `Invia revisione estratto conto (${editsFor(inv.id).size} correzioni)`}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
