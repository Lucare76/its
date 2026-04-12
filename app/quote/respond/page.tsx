"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

function RespondContent() {
  const params = useSearchParams();
  const success = params.get("success");
  const error = params.get("error");
  const route = params.get("route") ?? "";
  const status = params.get("status") ?? "";

  if (success === "accepted") {
    return (
      <div style={{ textAlign: "center", padding: "48px 24px" }}>
        <div style={{ fontSize: 64, marginBottom: 16 }}>✅</div>
        <h1 style={{ fontSize: 24, fontWeight: 800, color: "#166534", marginBottom: 8 }}>Preventivo accettato!</h1>
        <p style={{ fontSize: 15, color: "#475569", maxWidth: 400, margin: "0 auto" }}>
          Hai accettato il preventivo per <strong>{decodeURIComponent(route)}</strong>.
          Il team di Ischia Transfer Service ti contatterà a breve per confermare i dettagli.
        </p>
      </div>
    );
  }

  if (success === "rejected") {
    return (
      <div style={{ textAlign: "center", padding: "48px 24px" }}>
        <div style={{ fontSize: 64, marginBottom: 16 }}>❌</div>
        <h1 style={{ fontSize: 24, fontWeight: 800, color: "#991b1b", marginBottom: 8 }}>Preventivo rifiutato</h1>
        <p style={{ fontSize: 15, color: "#475569", maxWidth: 400, margin: "0 auto" }}>
          Hai rifiutato il preventivo per <strong>{decodeURIComponent(route)}</strong>.
          Se hai bisogno di ulteriori informazioni, contattaci via email.
        </p>
      </div>
    );
  }

  if (error === "alreadyresponded") {
    return (
      <div style={{ textAlign: "center", padding: "48px 24px" }}>
        <div style={{ fontSize: 64, marginBottom: 16 }}>ℹ️</div>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: "#1e293b", marginBottom: 8 }}>Già risposto</h1>
        <p style={{ fontSize: 15, color: "#475569" }}>Questo preventivo è già stato {status === "accepted" ? "accettato" : status === "rejected" ? "rifiutato" : "gestito"}.</p>
      </div>
    );
  }

  return (
    <div style={{ textAlign: "center", padding: "48px 24px" }}>
      <div style={{ fontSize: 64, marginBottom: 16 }}>⚠️</div>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: "#1e293b", marginBottom: 8 }}>Link non valido</h1>
      <p style={{ fontSize: 15, color: "#475569" }}>Il link è scaduto o non è valido. Contatta Ischia Transfer Service per assistenza.</p>
    </div>
  );
}

export default function QuoteRespondPage() {
  return (
    <div style={{ minHeight: "100vh", background: "#f8fafc", fontFamily: "Arial, sans-serif", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: "#fff", borderRadius: 20, boxShadow: "0 4px 32px rgba(0,0,0,0.08)", padding: "48px 40px", maxWidth: 480, width: "100%" }}>
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <p style={{ fontSize: 13, color: "#94a3b8", margin: 0 }}>Ischia Transfer Service</p>
        </div>
        <Suspense>
          <RespondContent />
        </Suspense>
      </div>
    </div>
  );
}
