"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

type ServiceSnapshot = {
  service_id?: string;
  date: string;
  time: string;
  customer_name: string;
  phone?: string | null;
  pax: number;
  hotel_or_destination: string | null;
  direction: "arrival" | "departure";
  transport_type?: string | null;
  transport_time?: string | null;
};

type SessionData = {
  id: string;
  agency_name: string;
  report_type: string;
  target_date: string;
  services: ServiceSnapshot[];
  status: "pending" | "approved" | "modified";
};

type Modification = {
  service_id: string;
  field: string;
  original: string;
  modified: string;
};

type EditRow = {
  date: string;
  time: string;
  pax: string;
  customer_name: string;
  phone: string;
  hotel_or_destination: string;
  direction: "arrival" | "departure";
  transport_type: string;
  transport_time: string;
};

const REPORT_LABELS: Record<string, string> = {
  arrivals_48h:   "Riepilogo arrivi +48h",
  departures_48h: "Riepilogo partenze +48h",
  bus_monday:     "Riepilogo linea bus domenica",
  reminder_48h:   "Promemoria 48h",
  reminder_24h:   "Promemoria 24h",
};

const TRANSPORT_OPTIONS = [
  { value: "", label: "— nessuno —" },
  { value: "traghetto", label: "Traghetto" },
  { value: "aliscafo",  label: "Aliscafo" },
  { value: "volo",      label: "Volo" },
  { value: "treno",     label: "Treno" },
];

export default function AgencyReviewPage() {
  const params = useParams<{ token: string }>();
  const token = params.token;

  const [session, setSession]   = useState<SessionData | null>(null);
  const [error, setError]       = useState<string | null>(null);
  const [mode, setMode]         = useState<"view" | "edit" | "done">("view");
  const [edits, setEdits]       = useState<Record<string, EditRow>>({});
  const [agencyNotes, setAgencyNotes] = useState("");
  const [submitting, setSubmitting]   = useState(false);

  useEffect(() => {
    fetch(`/api/agency-review/${token}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) { setError(data.error); return; }
        setSession(data);
        const map: Record<string, EditRow> = {};
        (data.services as ServiceSnapshot[]).forEach((s, i) => {
          const key = s.service_id ?? `row-${i}`;
          map[key] = {
            date:                s.date,
            time:                s.time,
            pax:                 String(s.pax),
            customer_name:       s.customer_name,
            phone:               s.phone ?? "",
            hotel_or_destination: s.hotel_or_destination ?? "",
            direction:           s.direction,
            transport_type:      s.transport_type ?? "",
            transport_time:      s.transport_time ?? "",
          };
        });
        setEdits(map);
      })
      .catch(() => setError("Errore di connessione."));
  }, [token]);

  async function submitApprove() {
    setSubmitting(true);
    const res = await fetch(`/api/agency-review/${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "approved" }),
    });
    if (res.ok) { setMode("done"); setSession((s) => s ? { ...s, status: "approved" } : s); }
    else { const d = await res.json(); setError(d.error ?? "Errore."); }
    setSubmitting(false);
  }

  async function submitModifications() {
    if (!session) return;
    setSubmitting(true);
    const modifications: Modification[] = [];

    session.services.forEach((s, i) => {
      const key = s.service_id ?? `row-${i}`;
      const edit = edits[key];
      if (!edit) return;

      const compare: Array<{ field: string; original: string; modified: string }> = [
        { field: "date",                original: s.date,                          modified: edit.date },
        { field: "time",                original: s.time,                          modified: edit.time },
        { field: "pax",                 original: String(s.pax),                   modified: edit.pax },
        { field: "customer_name",       original: s.customer_name,                 modified: edit.customer_name },
        { field: "phone",               original: s.phone ?? "",                   modified: edit.phone },
        { field: "hotel_or_destination",original: s.hotel_or_destination ?? "",    modified: edit.hotel_or_destination },
        { field: "direction",           original: s.direction,                     modified: edit.direction },
        { field: "transport_type",      original: s.transport_type ?? "",          modified: edit.transport_type },
        { field: "transport_time",      original: s.transport_time ?? "",          modified: edit.transport_time },
      ];

      for (const { field, original, modified } of compare) {
        if (original !== modified) {
          modifications.push({ service_id: key, field, original, modified });
        }
      }
    });

    if (modifications.length === 0) {
      setError("Nessuna modifica rilevata. Se tutto è corretto, clicca 'Approva tutto'.");
      setSubmitting(false);
      return;
    }

    const res = await fetch(`/api/agency-review/${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "modified", modifications, agency_notes: agencyNotes || undefined }),
    });
    if (res.ok) { setMode("done"); setSession((s) => s ? { ...s, status: "modified" } : s); }
    else { const d = await res.json(); setError(d.error ?? "Errore."); }
    setSubmitting(false);
  }

  function updateEdit(key: string, field: keyof EditRow, value: string) {
    setEdits((prev) => ({ ...prev, [key]: { ...prev[key], [field]: value } }));
  }

  // ─── Errore / loading ───────────────────────────────────────────────────────

  if (error && !session) {
    return (
      <div style={{ minHeight: "100vh", background: "#eef2f7", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "-apple-system,Arial,sans-serif" }}>
        <div style={{ background: "#fff", borderRadius: 16, padding: "40px 48px", maxWidth: 420, textAlign: "center", boxShadow: "0 4px 32px rgba(0,0,0,0.10)" }}>
          <div style={{ fontSize: 40, marginBottom: 16 }}>⚠️</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: "#0f172a", marginBottom: 8 }}>Attenzione</div>
          <div style={{ color: "#64748b", fontSize: 15 }}>{error}</div>
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <div style={{ minHeight: "100vh", background: "#eef2f7", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "-apple-system,Arial,sans-serif" }}>
        <div style={{ fontSize: 14, color: "#64748b" }}>Caricamento...</div>
      </div>
    );
  }

  if (mode === "done") {
    const approved = session.status === "approved";
    return (
      <div style={{ minHeight: "100vh", background: "#eef2f7", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "-apple-system,Arial,sans-serif" }}>
        <div style={{ background: "#fff", borderRadius: 20, padding: "48px 56px", maxWidth: 480, textAlign: "center", boxShadow: "0 4px 32px rgba(0,0,0,0.10)" }}>
          <div style={{ fontSize: 48, marginBottom: 20 }}>{approved ? "✅" : "✏️"}</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: "#0f2744", marginBottom: 10 }}>
            {approved ? "Riepilogo approvato!" : "Modifiche inviate!"}
          </div>
          <div style={{ color: "#64748b", fontSize: 15, lineHeight: 1.6 }}>
            {approved
              ? "Ischia Transfer Service ha ricevuto la tua approvazione. Grazie."
              : "Le modifiche sono state inviate all'operatore, che le verificherà e aggiornerà i servizi. Grazie."}
          </div>
        </div>
      </div>
    );
  }

  // ─── Stili condivisi ────────────────────────────────────────────────────────

  const inputStyle: React.CSSProperties = {
    width: "100%", border: "1px solid #cbd5e1", borderRadius: 6,
    padding: "5px 8px", fontSize: 13, background: "#fffbeb",
    color: "#1e293b", outline: "none", fontFamily: "inherit", boxSizing: "border-box",
  };

  // ─── Pagina principale ──────────────────────────────────────────────────────

  return (
    <div style={{ minHeight: "100vh", background: "#eef2f7", fontFamily: "-apple-system,Arial,sans-serif", padding: "32px 16px" }}>
      <div style={{ maxWidth: 860, margin: "0 auto" }}>

        {/* Header */}
        <div style={{ background: "linear-gradient(135deg,#0f2744,#1e3a5f)", borderRadius: 16, padding: "28px 32px", marginBottom: 24 }}>
          <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.15em", textTransform: "uppercase", color: "rgba(255,255,255,0.55)", marginBottom: 6 }}>
            Ischia Transfer Service
          </div>
          <div style={{ fontSize: 22, fontWeight: 800, color: "#fff", marginBottom: 4 }}>
            {REPORT_LABELS[session.report_type] ?? session.report_type}
          </div>
          <div style={{ fontSize: 14, color: "rgba(255,255,255,0.7)" }}>
            {session.agency_name} · {session.target_date}
          </div>
        </div>

        {/* Istruzioni */}
        <div style={{ background: "#fff", borderRadius: 12, padding: "14px 20px", marginBottom: 20, border: "1px solid #e2e8f0", fontSize: 14, color: "#475569", lineHeight: 1.6 }}>
          {mode === "view"
            ? <>Verifica i servizi. Se tutto è corretto clicca <strong>Approva tutto</strong>. Per correzioni clicca <strong>Segnala modifiche</strong>.</>
            : <>Modifica i campi che non corrispondono, poi clicca <strong>Invia modifiche</strong>.</>}
        </div>

        {/* Servizi */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 20 }}>
          {session.services.map((s, i) => {
            const key = s.service_id ?? `row-${i}`;
            const edit = edits[key];
            const isArr = mode === "edit" ? edit?.direction === "arrival" : s.direction === "arrival";

            return (
              <div key={key} style={{ background: "#fff", borderRadius: 12, border: "1px solid #e2e8f0", overflow: "hidden" }}>
                {/* Header riga */}
                <div style={{ background: isArr ? "#f0fdf4" : "#fefce8", borderBottom: "1px solid #e2e8f0", padding: "10px 16px", display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ display: "inline-block", padding: "3px 10px", borderRadius: 20, fontSize: 11, fontWeight: 700, background: isArr ? "#dcfce7" : "#fef9c3", color: isArr ? "#166534" : "#854d0e" }}>
                    {isArr ? "▼ Arrivo" : "▲ Partenza"}
                  </span>
                  <span style={{ fontSize: 14, fontWeight: 700, color: "#0f2744" }}>
                    {mode === "edit" ? edit?.customer_name || s.customer_name : s.customer_name}
                  </span>
                  <span style={{ fontSize: 13, color: "#64748b", marginLeft: "auto" }}>
                    {mode === "edit" ? `${edit?.date} ${edit?.time}` : `${s.date} ${s.time}`}
                  </span>
                </div>

                {/* Contenuto */}
                <div style={{ padding: "14px 16px" }}>
                  {mode === "view" ? (
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: "10px 20px" }}>
                      {[
                        ["Data",            s.date],
                        ["Orario",          s.time],
                        ["Pax",             String(s.pax)],
                        ["Telefono",        s.phone || "—"],
                        ["Hotel / Dest.",   s.hotel_or_destination || "—"],
                        ["Mezzo",           s.transport_type || "—"],
                        ["Orario mezzo",    s.transport_time || "—"],
                      ].map(([label, val]) => (
                        <div key={label}>
                          <div style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 2 }}>{label}</div>
                          <div style={{ fontSize: 13, color: "#1e293b", fontWeight: 500 }}>{val}</div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: "10px 16px" }}>

                      <div>
                        <div style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 4 }}>Nome cliente</div>
                        <input type="text" value={edit?.customer_name ?? s.customer_name} onChange={(e) => updateEdit(key, "customer_name", e.target.value)} style={inputStyle} />
                      </div>

                      <div>
                        <div style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 4 }}>Telefono</div>
                        <input type="tel" value={edit?.phone ?? (s.phone ?? "")} onChange={(e) => updateEdit(key, "phone", e.target.value)} style={inputStyle} placeholder="+39..." />
                      </div>

                      <div>
                        <div style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 4 }}>Data</div>
                        <input type="date" value={edit?.date ?? s.date} onChange={(e) => updateEdit(key, "date", e.target.value)} style={inputStyle} />
                      </div>

                      <div>
                        <div style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 4 }}>Orario</div>
                        <input type="time" value={edit?.time ?? s.time} onChange={(e) => updateEdit(key, "time", e.target.value)} style={inputStyle} />
                      </div>

                      <div>
                        <div style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 4 }}>Pax</div>
                        <input type="number" min={1} max={50} value={edit?.pax ?? String(s.pax)} onChange={(e) => updateEdit(key, "pax", e.target.value)} style={{ ...inputStyle, width: 70 }} />
                      </div>

                      <div>
                        <div style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 4 }}>Direzione</div>
                        <select value={edit?.direction ?? s.direction} onChange={(e) => updateEdit(key, "direction", e.target.value as "arrival" | "departure")} style={inputStyle}>
                          <option value="arrival">▼ Arrivo</option>
                          <option value="departure">▲ Partenza</option>
                        </select>
                      </div>

                      <div style={{ gridColumn: "span 2" }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 4 }}>Hotel / Destinazione</div>
                        <input type="text" value={edit?.hotel_or_destination ?? (s.hotel_or_destination ?? "")} onChange={(e) => updateEdit(key, "hotel_or_destination", e.target.value)} style={inputStyle} placeholder="Hotel, porto, aeroporto..." />
                      </div>

                      <div>
                        <div style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 4 }}>Mezzo</div>
                        <select value={edit?.transport_type ?? (s.transport_type ?? "")} onChange={(e) => updateEdit(key, "transport_type", e.target.value)} style={inputStyle}>
                          {TRANSPORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      </div>

                      <div>
                        <div style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 4 }}>Orario mezzo</div>
                        <input type="time" value={edit?.transport_time ?? (s.transport_time ?? "")} onChange={(e) => updateEdit(key, "transport_time", e.target.value)} style={inputStyle} />
                      </div>

                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Note agente */}
        {mode === "edit" && (
          <div style={{ background: "#fff", borderRadius: 12, padding: 20, marginBottom: 20, border: "1px solid #e2e8f0" }}>
            <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "#64748b", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 8 }}>
              Nota per l&apos;operatore (opzionale)
            </label>
            <textarea
              value={agencyNotes}
              onChange={(e) => setAgencyNotes(e.target.value)}
              rows={3}
              maxLength={1000}
              placeholder="Es. Il cliente ha comunicato un cambio d'orario per il volo..."
              style={{ width: "100%", border: "1px solid #cbd5e1", borderRadius: 8, padding: "10px 12px", fontSize: 14, color: "#1e293b", resize: "vertical", fontFamily: "inherit", outline: "none", boxSizing: "border-box" }}
            />
          </div>
        )}

        {/* Errori inline */}
        {error && (
          <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 10, padding: "12px 16px", marginBottom: 16, fontSize: 14, color: "#b91c1c" }}>
            {error}
          </div>
        )}

        {/* Bottoni */}
        <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
          {mode === "view" ? (
            <>
              <button onClick={submitApprove} disabled={submitting}
                style={{ background: "#166534", color: "#fff", border: "none", borderRadius: 12, padding: "14px 32px", fontSize: 15, fontWeight: 700, cursor: submitting ? "not-allowed" : "pointer", opacity: submitting ? 0.7 : 1 }}>
                ✅ Approva tutto
              </button>
              <button onClick={() => { setMode("edit"); setError(null); }}
                style={{ background: "#fff", color: "#854d0e", border: "2px solid #d97706", borderRadius: 12, padding: "14px 32px", fontSize: 15, fontWeight: 700, cursor: "pointer" }}>
                ✏️ Segnala modifiche
              </button>
            </>
          ) : (
            <>
              <button onClick={submitModifications} disabled={submitting}
                style={{ background: "#854d0e", color: "#fff", border: "none", borderRadius: 12, padding: "14px 32px", fontSize: 15, fontWeight: 700, cursor: submitting ? "not-allowed" : "pointer", opacity: submitting ? 0.7 : 1 }}>
                {submitting ? "Invio..." : "✏️ Invia modifiche"}
              </button>
              <button onClick={() => { setMode("view"); setError(null); }}
                style={{ background: "#fff", color: "#64748b", border: "1px solid #e2e8f0", borderRadius: 12, padding: "14px 24px", fontSize: 15, fontWeight: 600, cursor: "pointer" }}>
                ← Annulla
              </button>
            </>
          )}
        </div>

        <div style={{ textAlign: "center", marginTop: 32, fontSize: 12, color: "#94a3b8" }}>
          Ischia Transfer Service · Revisione riepilogo
        </div>
      </div>
    </div>
  );
}
