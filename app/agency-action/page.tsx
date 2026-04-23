"use client";

import { useEffect, useState } from "react";

interface ServiceInfo {
  id: string;
  date: string;
  time: string;
  customer_name: string;
  pax: number;
  status: string;
  direction: string;
  hotel_name: string;
}

function formatDate(iso: string) {
  return iso?.split("-").reverse().join("/") ?? iso;
}

export default function AgencyActionPage() {
  const [token, setToken] = useState<string | null>(null);
  const [service, setService] = useState<ServiceInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<"success" | "already_cancelled" | "error" | null>(null);
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const t = params.get("token");
    setToken(t);
    if (!t) { setLoading(false); return; }

    fetch(`/api/agency/action?token=${encodeURIComponent(t)}`)
      .then((r) => r.json())
      .then((body: { ok?: boolean; service?: ServiceInfo; error?: string }) => {
        if (body.ok && body.service) {
          setService(body.service);
        } else {
          setErrorMsg(body.error ?? "Token non valido o scaduto.");
          setResult("error");
        }
      })
      .catch(() => { setErrorMsg("Errore di rete."); setResult("error"); })
      .finally(() => setLoading(false));
  }, []);

  const confirm = async () => {
    if (!token) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/agency/action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, reason })
      });
      const body = await res.json() as { ok?: boolean; cancelled?: boolean; already_cancelled?: boolean; error?: string };
      if (body.already_cancelled) { setResult("already_cancelled"); return; }
      if (body.ok && body.cancelled) { setResult("success"); return; }
      setErrorMsg(body.error ?? "Operazione non riuscita.");
      setResult("error");
    } catch {
      setErrorMsg("Errore di rete.");
      setResult("error");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div style={{ fontFamily: "sans-serif", maxWidth: 480, margin: "80px auto", padding: 24, textAlign: "center" }}>
        <p style={{ color: "#64748b" }}>Caricamento...</p>
      </div>
    );
  }

  if (result === "success") {
    return (
      <div style={{ fontFamily: "sans-serif", maxWidth: 480, margin: "80px auto", padding: 24, textAlign: "center" }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>✅</div>
        <h2 style={{ color: "#166534", marginBottom: 8 }}>Annullamento confermato</h2>
        <p style={{ color: "#475569" }}>Il servizio è stato annullato. L&apos;operatore è stato notificato automaticamente.</p>
      </div>
    );
  }

  if (result === "already_cancelled") {
    return (
      <div style={{ fontFamily: "sans-serif", maxWidth: 480, margin: "80px auto", padding: 24, textAlign: "center" }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>ℹ️</div>
        <h2 style={{ color: "#0369a1", marginBottom: 8 }}>Già annullato</h2>
        <p style={{ color: "#475569" }}>Questo servizio risulta già annullato nel sistema.</p>
      </div>
    );
  }

  if (result === "error" || !service) {
    return (
      <div style={{ fontFamily: "sans-serif", maxWidth: 480, margin: "80px auto", padding: 24, textAlign: "center" }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>❌</div>
        <h2 style={{ color: "#991b1b", marginBottom: 8 }}>Link non valido</h2>
        <p style={{ color: "#475569" }}>{errorMsg || "Il link è scaduto o non valido. Contatta l'operatore."}</p>
      </div>
    );
  }

  const dirLabel = service.direction === "arrival" ? "Arrivo" : "Partenza";
  const alreadyCancelled = service.status === "cancelled";

  return (
    <div style={{ fontFamily: "sans-serif", maxWidth: 480, margin: "60px auto", padding: 24 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: "#0f2744", marginBottom: 4 }}>
        Conferma annullamento
      </h1>
      <p style={{ color: "#64748b", marginBottom: 28, fontSize: 14 }}>
        Ischia Transfer Service
      </p>

      {alreadyCancelled ? (
        <div style={{ background: "#fef9c3", border: "1px solid #d97706", borderRadius: 12, padding: 16, marginBottom: 24 }}>
          <p style={{ color: "#854d0e", margin: 0, fontWeight: 600 }}>Questo servizio è già annullato.</p>
        </div>
      ) : null}

      <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 12, padding: 20, marginBottom: 24 }}>
        <p style={{ fontWeight: 700, fontSize: 15, color: "#1e293b", marginBottom: 12 }}>Dettagli servizio</p>
        {[
          ["Cliente", service.customer_name],
          ["Data / Ora", `${formatDate(service.date)} alle ${service.time}`],
          ["Tipo", dirLabel],
          ["Hotel", service.hotel_name],
          ["Pax", String(service.pax)]
        ].map(([label, value]) => (
          <div key={label} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid #e2e8f0", fontSize: 14 }}>
            <span style={{ color: "#64748b", fontWeight: 600 }}>{label}</span>
            <span style={{ color: "#1e293b" }}>{value}</span>
          </div>
        ))}
      </div>

      {!alreadyCancelled ? (
        <>
          <label style={{ display: "block", fontSize: 14, color: "#475569", marginBottom: 8 }}>
            Motivo annullamento (facoltativo)
            <textarea
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Es. cambio data, cliente cancellato..."
              style={{ display: "block", width: "100%", marginTop: 6, padding: "10px 12px", border: "1px solid #d1d5db", borderRadius: 8, fontSize: 14, resize: "vertical", boxSizing: "border-box" }}
            />
          </label>
          <button
            onClick={() => void confirm()}
            disabled={submitting}
            style={{
              display: "block", width: "100%", marginTop: 16,
              background: submitting ? "#94a3b8" : "#991b1b",
              color: "#fff", border: "none", borderRadius: 10,
              padding: "14px 0", fontSize: 16, fontWeight: 700, cursor: submitting ? "not-allowed" : "pointer"
            }}
          >
            {submitting ? "Invio in corso..." : "Conferma annullamento"}
          </button>
          <p style={{ fontSize: 12, color: "#94a3b8", textAlign: "center", marginTop: 12 }}>
            L&apos;operatore verrà notificato automaticamente via email.
          </p>
        </>
      ) : null}
    </div>
  );
}
