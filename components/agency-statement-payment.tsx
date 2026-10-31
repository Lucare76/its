"use client";
import { useEffect, useState } from "react";
export function AgencyStatementPayment({
  invoiceId,
  residual,
  accessToken,
  reviewToken,
}: {
  invoiceId: string;
  residual: number;
  accessToken?: string;
  reviewToken?: string;
}) {
  const [open, setOpen] = useState(false),
    [amount, setAmount] = useState(""),
    [paidOn, setPaidOn] = useState(() => new Date().toISOString().slice(0, 10)),
    [method, setMethod] = useState("Bonifico"),
    [note, setNote] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [pending, setPending] = useState(false);
  useEffect(() => {
    let active = true;
    const headers = accessToken
      ? { Authorization: `Bearer ${accessToken}` }
      : undefined;
    fetch(
      `/api/agency/invoice-payments${reviewToken ? `?token=${encodeURIComponent(reviewToken)}` : ""}`,
      { headers },
    )
      .then((r) => r.json())
      .then((b) => {
        if (active)
          setPending(
            (b.reports ?? []).some(
              (r: { invoice_id: string; status: string }) =>
                r.invoice_id === invoiceId && r.status === "pending",
            ),
          );
      })
      .catch(() => {
        if (active)
          setMessage("Impossibile verificare le segnalazioni precedenti.");
      });
    return () => {
      active = false;
    };
  }, [accessToken, reviewToken, invoiceId]);
  async function submit() {
    const cents = Math.round(Number(amount.replace(",", ".")) * 100);
    if (!Number.isSafeInteger(cents) || cents <= 0 || cents > residual) {
      setMessage("Inserisci un importo valido entro il residuo.");
      return;
    }
    setBusy(true);
    try {
      const r = await fetch("/api/agency/invoice-payments", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({
          invoice_id: invoiceId,
          amount_cents: cents,
          paid_on: paidOn,
          method,
          note,
          token: reviewToken,
        }),
      });
      const b = await r.json();
      if (!r.ok) {
        setMessage(b.error ?? "Invio non riuscito.");
        return;
      }
      setPending(true);
      setOpen(false);
      setMessage(
        "Pagamento segnalato. ITS verificherà l’incasso: il saldo resta invariato fino alla conferma.",
      );
    } catch {
      setMessage("Errore di rete. Riprova.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mt-3 rounded-xl border border-slate-200 bg-white p-3 text-sm">
      {pending ? (
        <p className="font-semibold text-amber-800">
          Pagamento da verificare da ITS
        </p>
      ) : residual > 0 ? (
        <button
          type="button"
          className="btn-secondary"
          onClick={() => {
            setAmount((residual / 100).toFixed(2));
            setOpen(!open);
          }}
        >
          Segnala pagamento effettuato
        </button>
      ) : (
        <p className="font-semibold text-emerald-700">
          Nessun residuo da pagare
        </p>
      )}
      {open && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label>
            Importo €
            <input
              className="input-saas w-full"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
          <label>
            Data pagamento
            <input
              type="date"
              className="input-saas w-full"
              value={paidOn}
              onChange={(e) => setPaidOn(e.target.value)}
            />
          </label>
          <label>
            Modalità
            <select
              className="input-saas w-full"
              value={method}
              onChange={(e) => setMethod(e.target.value)}
            >
              {["Bonifico", "Contanti", "Carta", "Altro"].map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
          <label>
            Riferimento / note
            <input
              className="input-saas w-full"
              value={note}
              maxLength={1000}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="btn-primary"
            disabled={busy}
            onClick={() => void submit()}
          >
            {busy ? "Invio…" : "Invia segnalazione a ITS"}
          </button>
        </div>
      )}
      {message && (
        <p role="status" className="mt-2 text-slate-700">
          {message}
        </p>
      )}
    </div>
  );
}
