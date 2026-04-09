"use client";

import { useEffect } from "react";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[GlobalError]", error);
  }, [error]);

  return (
    <html lang="it">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif", background: "#f8fafc" }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "100vh", textAlign: "center", padding: "24px" }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>⚠️</div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: "#1e293b", margin: "0 0 8px" }}>Errore critico dell&apos;applicazione</h1>
          <p style={{ fontSize: 14, color: "#64748b", maxWidth: 400, margin: "0 0 24px" }}>
            Si è verificato un errore imprevisto. Il team è stato notificato.
          </p>
          {error.digest && (
            <p style={{ fontSize: 12, color: "#94a3b8", fontFamily: "monospace", marginBottom: 24 }}>
              Codice: {error.digest}
            </p>
          )}
          <button
            type="button"
            onClick={reset}
            style={{ background: "#0f2744", color: "#fff", border: "none", borderRadius: 10, padding: "10px 24px", fontSize: 14, fontWeight: 600, cursor: "pointer" }}
          >
            Riprova
          </button>
        </div>
      </body>
    </html>
  );
}
