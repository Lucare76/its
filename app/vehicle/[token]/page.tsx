"use client";

import { useEffect, useRef, useState } from "react";
import { use } from "react";
import { createClient } from "@supabase/supabase-js";

const _supabasePublic = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

/* ─── Tipi ───────────────────────────────────────────────────────────────── */

const MAX_PHOTO_COUNT = 4;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const ALLOWED_PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);

type VehicleInfo = {
  id: string;
  label: string;
  plate?: string | null;
  capacity?: number | null;
  vehicle_size?: string | null;
  notes?: string | null;
  insurance_expiry?: string | null;
  road_tax_expiry?: string | null;
  inspection_expiry?: string | null;
  km?: number | null;
  telaio?: string | null;
};

type KmLog = {
  id: string;
  driver_name: string;
  start_km: number;
  end_km: number | null;
  start_at: string;
  end_at: string | null;
  notes: string | null;
};

type OpenLog = {
  id: string;
  driver_name: string;
  start_km: number;
  start_at: string;
};

type Fuel = {
  id: string;
  fuel_date: string;
  liters?: number | null;
  cost?: number | null;
  km_at_fuel?: number | null;
  fuel_type?: string | null;
  station?: string | null;
};

type Anomaly = {
  id: string;
  severity: "low" | "medium" | "high" | "blocking";
  title: string;
  description?: string | null;
  reported_at: string;
};

/* ─── Helpers ────────────────────────────────────────────────────────────── */

const SIZE_LABEL: Record<string, string> = {
  small: "Piccolo", medium: "Medio", large: "Grande", bus: "Bus",
};

const SEVERITY_COLOR: Record<string, string> = {
  low: "#64748b", medium: "#d97706", high: "#ea580c", blocking: "#dc2626",
};
const SEVERITY_BG: Record<string, string> = {
  low: "#f1f5f9", medium: "#fffbeb", high: "#fff7ed", blocking: "#fef2f2",
};
const SEVERITY_LABEL: Record<string, string> = {
  low: "Bassa", medium: "Media", high: "Alta", blocking: "Bloccante",
};

function formatDate(d?: string | null) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("it-IT", { day: "2-digit", month: "short", year: "numeric" });
}

function formatDateTime(d?: string | null) {
  if (!d) return "—";
  return new Date(d).toLocaleString("it-IT", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

function expiryStatus(d?: string | null): "ok" | "warn" | "expired" | "none" {
  if (!d) return "none";
  const days = Math.floor((new Date(d).getTime() - Date.now()) / 86400000);
  if (days < 0) return "expired";
  if (days < 30) return "warn";
  return "ok";
}

const EXPIRY_STYLE: Record<string, { bg: string; color: string; icon: string }> = {
  ok:      { bg: "#dcfce7", color: "#166534", icon: "✅" },
  warn:    { bg: "#fef9c3", color: "#854d0e", icon: "⚠️" },
  expired: { bg: "#fee2e2", color: "#991b1b", icon: "❌" },
  none:    { bg: "#f1f5f9", color: "#64748b", icon: "—" },
};

/* ─── Componente principale ──────────────────────────────────────────────── */

export default function VehicleQRPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);

  const [vehicle,    setVehicle]    = useState<VehicleInfo | null>(null);
  const [anomalies,  setAnomalies]  = useState<Anomaly[]>([]);
  const [openLog,    setOpenLog]    = useState<OpenLog | null>(null);
  const [kmLogs,     setKmLogs]     = useState<KmLog[]>([]);
  const [fuel,       setFuel]       = useState<Fuel[]>([]);
  const [drivers,    setDrivers]    = useState<{ id: string; full_name: string }[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState<string | null>(null);

  // Sezione km
  const [kmSection,    setKmSection]    = useState<"idle" | "start" | "end">("idle");
  const [kmDriverName, setKmDriverName] = useState("");
  const [kmStart,      setKmStart]      = useState("");
  const [kmEnd,        setKmEnd]        = useState("");
  const [kmNotes,      setKmNotes]      = useState("");
  const [kmSubmitting, setKmSubmitting] = useState(false);
  const [kmMsg,        setKmMsg]        = useState<{ ok: boolean; text: string } | null>(null);

  // Sezione rifornimento
  const [showFuel,      setShowFuel]      = useState(false);
  const [fuelLiters,    setFuelLiters]    = useState("");
  const [fuelCost,      setFuelCost]      = useState("");
  const [fuelKm,        setFuelKm]        = useState("");
  const [fuelType,      setFuelType]      = useState("diesel");
  const [fuelStation,   setFuelStation]   = useState("");
  const [fuelSubmitting,setFuelSubmitting]= useState(false);
  const [fuelMsg,       setFuelMsg]       = useState<{ ok: boolean; text: string } | null>(null);

  // Sezione segnalazione danno
  const [showReport,     setShowReport]     = useState(false);
  const [reportName,     setReportName]     = useState("");
  const [reportDesc,     setReportDesc]     = useState("");
  const [reportSev,      setReportSev]      = useState<"low"|"medium"|"high"|"blocking">("low");
  const [photos,         setPhotos]         = useState<File[]>([]);
  const [photoPreviews,  setPhotoPreviews]  = useState<string[]>([]);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);
  const [submitting,     setSubmitting]     = useState(false);
  const [reportDone,     setReportDone]     = useState(false);
  const [reportError,    setReportError]    = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function loadData() {
    setLoading(true);
    fetch(`/api/vehicle/${token}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) { setError(d.error); setLoading(false); return; }
        setVehicle(d.vehicle);
        setAnomalies(d.anomalies ?? []);
        setOpenLog(d.openLog ?? null);
        setKmLogs(d.kmLogs ?? []);
        setFuel(d.fuel ?? []);
        setDrivers(d.drivers ?? []);
        setLoading(false);
      })
      .catch(() => { setError("Errore di connessione."); setLoading(false); });
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { loadData(); }, [token]);

  /* ── Km turno ── */
  async function handleKmStart(e: React.FormEvent) {
    e.preventDefault();
    setKmSubmitting(true); setKmMsg(null);
    const res = await fetch(`/api/vehicle/${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "km_start", driver_name: kmDriverName, start_km: Number(kmStart) }),
    });
    const json = await res.json();
    setKmSubmitting(false);
    if (json.ok) {
      setKmMsg({ ok: true, text: "Turno iniziato! Ricorda di registrare i km alla fine." });
      setKmSection("idle");
      setKmDriverName(""); setKmStart("");
      loadData();
    } else {
      setKmMsg({ ok: false, text: json.error ?? "Errore." });
    }
  }

  async function handleKmEnd(e: React.FormEvent) {
    e.preventDefault();
    if (!openLog) return;
    setKmSubmitting(true); setKmMsg(null);
    const res = await fetch(`/api/vehicle/${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "km_end", log_id: openLog.id, end_km: Number(kmEnd), notes: kmNotes }),
    });
    const json = await res.json();
    setKmSubmitting(false);
    if (json.ok) {
      setKmMsg({ ok: true, text: `Turno chiuso. Km percorsi: ${Number(kmEnd) - openLog.start_km}` });
      setKmSection("idle");
      setKmEnd(""); setKmNotes("");
      loadData();
    } else {
      setKmMsg({ ok: false, text: json.error ?? "Errore." });
    }
  }

  /* ── Rifornimento ── */
  async function handleFuel(e: React.FormEvent) {
    e.preventDefault();
    setFuelSubmitting(true); setFuelMsg(null);
    const res = await fetch(`/api/vehicle/${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "fuel",
        liters: fuelLiters || undefined,
        cost: fuelCost || undefined,
        km_at_fuel: fuelKm || undefined,
        fuel_type: fuelType,
        station: fuelStation || undefined,
      }),
    });
    const json = await res.json();
    setFuelSubmitting(false);
    if (json.ok) {
      setFuelMsg({ ok: true, text: "Rifornimento registrato." });
      setShowFuel(false);
      setFuelLiters(""); setFuelCost(""); setFuelKm(""); setFuelStation("");
      loadData();
    } else {
      setFuelMsg({ ok: false, text: json.error ?? "Errore." });
    }
  }

  /* ── Foto danno ── */
  function handlePhotoSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const selectedFiles = Array.from(e.target.files ?? []).slice(0, MAX_PHOTO_COUNT);
    const invalidFile = selectedFiles.find((file) => !ALLOWED_PHOTO_TYPES.has(file.type) || file.size > MAX_PHOTO_BYTES);
    if (invalidFile) {
      setReportError("Le foto devono essere JPG, PNG, WEBP o HEIC e non superare 5 MB.");
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    setReportError(null);
    setPhotos(selectedFiles);
    setPhotoPreviews(selectedFiles.map((file) => URL.createObjectURL(file)));
  }

  function removePhoto(idx: number) {
    setPhotos((p) => p.filter((_, i) => i !== idx));
    setPhotoPreviews((p) => p.filter((_, i) => i !== idx));
  }

  function fileToDataUrl(file: File) {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === "string") {
          resolve(reader.result);
          return;
        }
        reject(new Error("Impossibile leggere il file selezionato."));
      };
      reader.onerror = () => reject(new Error("Impossibile leggere il file selezionato."));
      reader.readAsDataURL(file);
    });
  }

  async function handleReport(e: React.FormEvent) {
    e.preventDefault();
    if (!reportDesc.trim()) {
      setReportError("Descrizione obbligatoria.");
      return;
    }
    setSubmitting(true); setReportError(null);

    // Upload foto tramite client Supabase JS (gestisce il nuovo formato chiave)
    const uploadedUrls: string[] = [];
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";

    for (let i = 0; i < photos.length; i++) {
      const file = photos[i];
      setUploadProgress(`Upload foto ${i + 1}/${photos.length}...`);
      const ext = file.name.split(".").pop() ?? "jpg";
      const path = `${vehicle?.id ?? "unknown"}/${Date.now()}-${i}-${Math.random().toString(36).slice(2)}.${ext}`;
      const { error: upErr } = await _supabasePublic.storage
        .from("vehicle-damage-photos")
        .upload(path, file, { contentType: file.type, upsert: false });
      if (upErr) {
        setSubmitting(false);
        setUploadProgress(null);
        setReportError(`Upload foto fallito: ${upErr.message}`);
        return;
      }
      uploadedUrls.push(`${supabaseUrl}/storage/v1/object/public/vehicle-damage-photos/${path}`);
    }

    setUploadProgress(uploadedUrls.length > 0 ? "Invio segnalazione..." : null);

    const res = await fetch(`/api/vehicle/${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "report",
        reporter_name: reportName.trim() || undefined,
        description: reportDesc.trim(),
        severity: reportSev,
        photo_urls: uploadedUrls.length > 0 ? uploadedUrls : undefined,
      }),
    });
    const json = await res.json();
    setUploadProgress(null);
    if (json.ok) setReportDone(true);
    else setReportError(json.error ?? "Errore nell'invio.");
    setSubmitting(false);
  }

  /* ── Loading / Error ── */
  if (loading) return (
    <div style={{ minHeight: "100vh", background: "#0f172a", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ color: "#94a3b8", fontSize: 15 }}>Caricamento...</div>
    </div>
  );

  if (error || !vehicle) return (
    <div style={{ minHeight: "100vh", background: "#0f172a", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: "#1e293b", borderRadius: 16, padding: "32px 40px", textAlign: "center", maxWidth: 360 }}>
        <div style={{ fontSize: 40, marginBottom: 12 }}>🚫</div>
        <div style={{ color: "#f87171", fontSize: 15, fontWeight: 600 }}>{error ?? "Veicolo non trovato."}</div>
      </div>
    </div>
  );

  const docExpiries = [
    { label: "Assicurazione", date: vehicle.insurance_expiry },
    { label: "Bollo",         date: vehicle.road_tax_expiry },
    { label: "Collaudo",      date: vehicle.inspection_expiry },
  ];

  return (
    <div style={{ minHeight: "100vh", background: "#0f172a", fontFamily: "-apple-system, Arial, sans-serif", paddingBottom: 48 }}>

      {/* ── Hero ── */}
      <div style={{ background: "linear-gradient(135deg, #1e40af, #0f2744)", padding: "32px 20px 28px", textAlign: "center" }}>
        <div style={{ display: "inline-block", background: "rgba(255,255,255,0.1)", borderRadius: 12, padding: "6px 14px", fontSize: 12, color: "rgba(255,255,255,0.7)", fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 14 }}>
          Ischia Transfer Service
        </div>
        <div style={{ fontSize: 36, fontWeight: 900, color: "#fff", letterSpacing: "-0.02em", lineHeight: 1.1 }}>
          {vehicle.label}
        </div>
        {vehicle.plate && (
          <div style={{ marginTop: 10, display: "inline-block", background: "#fbbf24", color: "#0f172a", fontWeight: 900, fontSize: 22, letterSpacing: "0.15em", padding: "4px 16px", borderRadius: 8, fontFamily: "monospace" }}>
            {vehicle.plate}
          </div>
        )}
        <div style={{ marginTop: 14, display: "flex", justifyContent: "center", gap: 12, flexWrap: "wrap" }}>
          {vehicle.vehicle_size && (
            <span style={{ background: "rgba(255,255,255,0.15)", color: "#fff", borderRadius: 20, padding: "4px 14px", fontSize: 13, fontWeight: 600 }}>
              {SIZE_LABEL[vehicle.vehicle_size] ?? vehicle.vehicle_size}
            </span>
          )}
          {vehicle.capacity && (
            <span style={{ background: "rgba(255,255,255,0.15)", color: "#fff", borderRadius: 20, padding: "4px 14px", fontSize: 13, fontWeight: 600 }}>
              👥 {vehicle.capacity} pax
            </span>
          )}
          {vehicle.km != null && (
            <span style={{ background: "rgba(255,255,255,0.15)", color: "#fff", borderRadius: 20, padding: "4px 14px", fontSize: 13, fontWeight: 600 }}>
              🛣 {vehicle.km.toLocaleString("it-IT")} km
            </span>
          )}
        </div>
      </div>

      <div style={{ maxWidth: 600, margin: "0 auto", padding: "0 16px" }}>

        {/* ── Anomalie attive ── */}
        {anomalies.length > 0 && (
          <Section title="⚠️ Anomalie attive" mt={24}>
            {anomalies.map((a) => (
              <div key={a.id} style={{ background: SEVERITY_BG[a.severity], border: `1px solid ${SEVERITY_COLOR[a.severity]}33`, borderRadius: 10, padding: "12px 16px", marginBottom: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <span style={{ background: SEVERITY_COLOR[a.severity], color: "#fff", borderRadius: 20, padding: "2px 10px", fontSize: 11, fontWeight: 700 }}>
                    {SEVERITY_LABEL[a.severity]}
                  </span>
                  <span style={{ color: "#1e293b", fontWeight: 700, fontSize: 14 }}>{a.title}</span>
                </div>
                {a.description && <div style={{ color: "#475569", fontSize: 13 }}>{a.description}</div>}
                <div style={{ color: "#94a3b8", fontSize: 11, marginTop: 4 }}>{formatDate(a.reported_at)}</div>
              </div>
            ))}
          </Section>
        )}

        {/* ── Scadenze documenti ── */}
        <Section title="📋 Scadenze documenti" mt={24}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
            {docExpiries.map(({ label, date }) => {
              const st = expiryStatus(date);
              const s = EXPIRY_STYLE[st];
              return (
                <div key={label} style={{ background: s.bg, borderRadius: 12, padding: "14px 10px", textAlign: "center" }}>
                  <div style={{ fontSize: 20, marginBottom: 4 }}>{s.icon}</div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: s.color, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>{label}</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: s.color }}>{formatDate(date)}</div>
                </div>
              );
            })}
          </div>
          {(vehicle.telaio || vehicle.notes) && (
            <div style={{ marginTop: 10, background: "#1e293b", borderRadius: 10, padding: "10px 14px" }}>
              {vehicle.telaio && <div style={{ color: "#94a3b8", fontSize: 12 }}>Telaio: <span style={{ color: "#e2e8f0", fontFamily: "monospace" }}>{vehicle.telaio}</span></div>}
              {vehicle.notes && <div style={{ color: "#94a3b8", fontSize: 12, marginTop: 4 }}>📝 {vehicle.notes}</div>}
            </div>
          )}
        </Section>

        {/* ══════════════════════════════════════════════════
            SEZIONE KM TURNO
        ══════════════════════════════════════════════════ */}
        <Section title="🛣 Registra chilometri turno" mt={24}>

          {/* Turno aperto */}
          {openLog && (
            <div style={{ background: "#1c3544", border: "1px solid #0ea5e9", borderRadius: 12, padding: "14px 16px", marginBottom: 12 }}>
              <div style={{ fontSize: 13, color: "#7dd3fc", fontWeight: 700, marginBottom: 4 }}>⏱ Turno in corso</div>
              <div style={{ color: "#e2e8f0", fontSize: 14 }}>
                <strong>{openLog.driver_name}</strong> — Partenza: <strong>{openLog.start_km.toLocaleString("it-IT")} km</strong>
              </div>
              <div style={{ color: "#94a3b8", fontSize: 12, marginTop: 2 }}>Iniziato: {formatDateTime(openLog.start_at)}</div>
            </div>
          )}

          {kmMsg && (
            <div style={{ borderRadius: 10, padding: "10px 14px", marginBottom: 12, background: kmMsg.ok ? "#14532d" : "#450a0a", border: `1px solid ${kmMsg.ok ? "#16a34a" : "#dc2626"}`, color: kmMsg.ok ? "#86efac" : "#fca5a5", fontSize: 13, fontWeight: 600 }}>
              {kmMsg.ok ? "✅ " : "❌ "}{kmMsg.text}
            </div>
          )}

          {kmSection === "idle" && (
            <div style={{ display: "flex", gap: 10 }}>
              {!openLog && (
                <button onClick={() => setKmSection("start")} style={{ flex: 1, background: "#1e40af", color: "#fff", border: "none", borderRadius: 12, padding: "14px", fontSize: 15, fontWeight: 800, cursor: "pointer" }}>
                  🚌 Inizio servizio
                </button>
              )}
              {openLog && (
                <button onClick={() => setKmSection("end")} style={{ flex: 1, background: "#166534", color: "#fff", border: "none", borderRadius: 12, padding: "14px", fontSize: 15, fontWeight: 800, cursor: "pointer" }}>
                  🏁 Fine servizio
                </button>
              )}
            </div>
          )}

          {kmSection === "start" && (
            <form onSubmit={handleKmStart} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div>
                <label style={labelStyle}>Nome autista *</label>
                <input value={kmDriverName} onChange={(e) => setKmDriverName(e.target.value)} required placeholder="Es. Mario Rossi" style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Km attuali sul contachilometri *</label>
                <input type="number" value={kmStart} onChange={(e) => setKmStart(e.target.value)} required min="0" placeholder="Es. 123400" style={inputStyle} />
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <button type="button" onClick={() => setKmSection("idle")} style={cancelBtnStyle}>Annulla</button>
                <button type="submit" disabled={kmSubmitting} style={{ ...primaryBtnStyle, flex: 2, background: "#1e40af" }}>
                  {kmSubmitting ? "Salvataggio..." : "🚌 Registra inizio"}
                </button>
              </div>
            </form>
          )}

          {kmSection === "end" && openLog && (
            <form onSubmit={handleKmEnd} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ background: "#1e293b", borderRadius: 10, padding: "10px 14px", fontSize: 13, color: "#94a3b8" }}>
                Partenza: <strong style={{ color: "#e2e8f0" }}>{openLog.start_km.toLocaleString("it-IT")} km</strong> · {openLog.driver_name}
              </div>
              <div>
                <label style={labelStyle}>Km finali sul contachilometri *</label>
                <input type="number" value={kmEnd} onChange={(e) => setKmEnd(e.target.value)} required min={openLog.start_km} placeholder={`Min. ${openLog.start_km}`} style={inputStyle} />
                {kmEnd && Number(kmEnd) > openLog.start_km && (
                  <div style={{ color: "#34d399", fontSize: 12, marginTop: 4 }}>
                    Km percorsi: {(Number(kmEnd) - openLog.start_km).toLocaleString("it-IT")} km
                  </div>
                )}
              </div>
              <div>
                <label style={labelStyle}>Note (opzionale)</label>
                <input value={kmNotes} onChange={(e) => setKmNotes(e.target.value)} placeholder="Es. traffico, deviazioni..." style={inputStyle} />
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <button type="button" onClick={() => setKmSection("idle")} style={cancelBtnStyle}>Annulla</button>
                <button type="submit" disabled={kmSubmitting} style={{ ...primaryBtnStyle, flex: 2, background: "#166534" }}>
                  {kmSubmitting ? "Salvataggio..." : "🏁 Chiudi turno"}
                </button>
              </div>
            </form>
          )}

          {/* Storico turni */}
          {kmLogs.length > 0 && (
            <details style={{ marginTop: 14 }}>
              <summary style={{ color: "#64748b", fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", cursor: "pointer" }}>
                Ultimi turni ({kmLogs.length})
              </summary>
              <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
                {kmLogs.map((l) => (
                  <div key={l.id} style={cardStyle}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div>
                        <div style={{ color: "#e2e8f0", fontSize: 13, fontWeight: 700 }}>{l.driver_name}</div>
                        <div style={{ color: "#64748b", fontSize: 11, marginTop: 2 }}>{formatDateTime(l.start_at)}</div>
                        {l.notes && <div style={{ color: "#94a3b8", fontSize: 11, marginTop: 2 }}>{l.notes}</div>}
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div style={{ color: "#34d399", fontSize: 14, fontWeight: 700 }}>
                          {l.end_km != null ? `+${(l.end_km - l.start_km).toLocaleString("it-IT")} km` : "—"}
                        </div>
                        <div style={{ color: "#64748b", fontSize: 11 }}>
                          {l.start_km.toLocaleString("it-IT")} → {l.end_km?.toLocaleString("it-IT") ?? "?"}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </details>
          )}
        </Section>

        {/* ══════════════════════════════════════════════════
            RIFORNIMENTI
        ══════════════════════════════════════════════════ */}
        <Section title="⛽ Rifornimenti carburante" mt={20} count={fuel.length}>

          {fuelMsg && (
            <div style={{ borderRadius: 10, padding: "10px 14px", marginBottom: 12, background: fuelMsg.ok ? "#14532d" : "#450a0a", border: `1px solid ${fuelMsg.ok ? "#16a34a" : "#dc2626"}`, color: fuelMsg.ok ? "#86efac" : "#fca5a5", fontSize: 13, fontWeight: 600 }}>
              {fuelMsg.ok ? "✅ " : "❌ "}{fuelMsg.text}
            </div>
          )}

          {!showFuel ? (
            <button onClick={() => setShowFuel(true)} style={{ width: "100%", background: "transparent", border: "2px dashed #334155", borderRadius: 12, padding: "12px", color: "#64748b", fontSize: 14, cursor: "pointer", marginBottom: fuel.length > 0 ? 12 : 0 }}>
              + Registra rifornimento
            </button>
          ) : (
            <form onSubmit={handleFuel} style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 14 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <div>
                  <label style={labelStyle}>Tipo carburante</label>
                  <select value={fuelType} onChange={(e) => setFuelType(e.target.value)} style={inputStyle}>
                    <option value="diesel">Diesel</option>
                    <option value="benzina">Benzina</option>
                    <option value="gas">Gas</option>
                    <option value="elettrico">Elettrico</option>
                  </select>
                </div>
                <div>
                  <label style={labelStyle}>Litri</label>
                  <input type="number" value={fuelLiters} onChange={(e) => setFuelLiters(e.target.value)} placeholder="Es. 60" style={inputStyle} />
                </div>
                <div>
                  <label style={labelStyle}>Costo (€)</label>
                  <input type="number" value={fuelCost} onChange={(e) => setFuelCost(e.target.value)} placeholder="Es. 95.00" style={inputStyle} />
                </div>
                <div>
                  <label style={labelStyle}>Km al rifornimento</label>
                  <input type="number" value={fuelKm} onChange={(e) => setFuelKm(e.target.value)} placeholder="Es. 123400" style={inputStyle} />
                </div>
              </div>
              <div>
                <label style={labelStyle}>Distributore (opzionale)</label>
                <input value={fuelStation} onChange={(e) => setFuelStation(e.target.value)} placeholder="Es. Q8 Forio" style={inputStyle} />
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <button type="button" onClick={() => setShowFuel(false)} style={cancelBtnStyle}>Annulla</button>
                <button type="submit" disabled={fuelSubmitting} style={{ ...primaryBtnStyle, flex: 2, background: "#92400e" }}>
                  {fuelSubmitting ? "Salvataggio..." : "⛽ Registra"}
                </button>
              </div>
            </form>
          )}

          {fuel.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {fuel.map((f) => (
                <div key={f.id} style={cardStyle}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      {f.fuel_type && <div style={{ fontSize: 12, color: "#fbbf24", fontWeight: 700, textTransform: "uppercase" }}>{f.fuel_type}</div>}
                      {f.station && <div style={{ fontSize: 13, color: "#94a3b8", marginTop: 2 }}>🏪 {f.station}</div>}
                      <div style={{ fontSize: 11, color: "#64748b", marginTop: 2 }}>{formatDate(f.fuel_date)}</div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      {f.liters != null && <div style={{ fontSize: 14, fontWeight: 700, color: "#e2e8f0" }}>{f.liters.toFixed(1)} L</div>}
                      {f.cost != null && <div style={{ fontSize: 12, color: "#34d399" }}>€{f.cost.toFixed(2)}</div>}
                      {f.km_at_fuel != null && <div style={{ fontSize: 11, color: "#64748b" }}>{f.km_at_fuel.toLocaleString("it-IT")} km</div>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* ══════════════════════════════════════════════════
            SEGNALA DANNO
        ══════════════════════════════════════════════════ */}
        <div style={{ marginTop: 28 }}>
          {!showReport && !reportDone && (
            <button onClick={() => setShowReport(true)} style={{ width: "100%", background: "linear-gradient(135deg, #dc2626, #991b1b)", color: "#fff", border: "none", borderRadius: 14, padding: "16px", fontSize: 16, fontWeight: 800, cursor: "pointer" }}>
              🚨 Segnala danno / problema
            </button>
          )}

          {reportDone && (
            <div style={{ background: "#14532d", border: "1px solid #16a34a", borderRadius: 14, padding: "20px 24px", textAlign: "center" }}>
              <div style={{ fontSize: 32, marginBottom: 8 }}>✅</div>
              <div style={{ color: "#86efac", fontSize: 16, fontWeight: 700 }}>Segnalazione inviata</div>
              <div style={{ color: "#4ade80", fontSize: 13, marginTop: 6 }}>Il team di Ischia Transfer Service è stato notificato.</div>
            </div>
          )}

          {showReport && !reportDone && (
            <div style={{ background: "#1e293b", border: "1px solid #dc262633", borderRadius: 16, padding: "24px 20px" }}>
              <div style={{ fontSize: 17, fontWeight: 800, color: "#f87171", marginBottom: 16 }}>🚨 Segnala danno / problema</div>

              <form onSubmit={handleReport} style={{ display: "flex", flexDirection: "column", gap: 14 }}>

                {/* Upload foto */}
                <div>
                  <label style={labelStyle}>Foto del danno (max 4, 5 MB ciascuna)</label>
                  <input ref={fileInputRef} type="file" accept="image/*" multiple onChange={handlePhotoSelect} style={{ display: "none" }} />
                  <button type="button" onClick={() => fileInputRef.current?.click()} style={{ width: "100%", padding: "16px", borderRadius: 12, border: "2px dashed #475569", background: "transparent", color: "#64748b", fontSize: 14, cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 28 }}>📷</span>
                    <span>Scatta o carica foto</span>
                  </button>
                  {photoPreviews.length > 0 && (
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8, marginTop: 10 }}>
                      {photoPreviews.map((src, i) => (
                        <div key={i} style={{ position: "relative" }}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={src} alt={`Foto ${i + 1}`} style={{ width: "100%", height: 110, objectFit: "cover", borderRadius: 10, border: "1px solid #334155" }} />
                          <button type="button" onClick={() => removePhoto(i)} style={{ position: "absolute", top: 4, right: 4, background: "#dc2626", color: "#fff", border: "none", borderRadius: "50%", width: 22, height: 22, fontSize: 12, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div>
                  <label style={labelStyle}>Nome autista *</label>
                  <input value={reportName} onChange={(e) => setReportName(e.target.value)} required placeholder="Es. Mario Rossi" style={inputStyle} />
                </div>

                <div>
                  <label style={labelStyle}>Descrizione del problema *</label>
                  <textarea value={reportDesc} onChange={(e) => setReportDesc(e.target.value)} placeholder="Descrivi il danno o il problema riscontrato..." required rows={4} style={{ ...inputStyle, resize: "vertical", minHeight: 96 }} />
                </div>

                <div>
                  <label style={labelStyle}>Gravità</label>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    {(["low", "medium", "high", "blocking"] as const).map((sev) => (
                      <button key={sev} type="button" onClick={() => setReportSev(sev)} style={{ padding: "10px 8px", borderRadius: 10, border: `2px solid ${reportSev === sev ? SEVERITY_COLOR[sev] : "#334155"}`, background: reportSev === sev ? SEVERITY_COLOR[sev] + "22" : "transparent", color: reportSev === sev ? SEVERITY_COLOR[sev] : "#64748b", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
                        {SEVERITY_LABEL[sev]}
                      </button>
                    ))}
                  </div>
                </div>

                {reportError && <div style={{ color: "#f87171", fontSize: 13, background: "#450a0a", borderRadius: 8, padding: "8px 12px" }}>{reportError}</div>}

                <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
                  <button type="button" onClick={() => setShowReport(false)} style={cancelBtnStyle}>Annulla</button>
                  <button type="submit" disabled={submitting || !reportDesc.trim()} style={{ flex: 2, padding: "12px", borderRadius: 10, border: "none", background: submitting ? "#7f1d1d" : "#dc2626", color: "#fff", fontWeight: 800, fontSize: 14, cursor: submitting ? "not-allowed" : "pointer" }}>
                    {uploadProgress ?? (submitting ? "Invio..." : "Invia segnalazione")}
                  </button>
                </div>
              </form>
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ marginTop: 36, textAlign: "center", color: "#334155", fontSize: 12 }}>
          Ischia Transfer Service · Scheda veicolo digitale
        </div>
      </div>
    </div>
  );
}

/* ─── Sub-componenti ─────────────────────────────────────────────────────── */

function Section({ title, children, mt = 20, count }: { title: string; children: React.ReactNode; mt?: number; count?: number }) {
  return (
    <div style={{ marginTop: mt }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <div style={{ fontSize: 15, fontWeight: 800, color: "#e2e8f0" }}>{title}</div>
        {count != null && count > 0 && (
          <span style={{ background: "#1e40af", color: "#93c5fd", borderRadius: 20, padding: "2px 8px", fontSize: 11, fontWeight: 700 }}>{count}</span>
        )}
      </div>
      {children}
    </div>
  );
}

/* ─── Stili ──────────────────────────────────────────────────────────────── */

const cardStyle: React.CSSProperties = {
  background: "#1e293b", borderRadius: 10, padding: "12px 14px", border: "1px solid #334155",
};

const inputStyle: React.CSSProperties = {
  width: "100%", background: "#0f172a", border: "1px solid #334155", borderRadius: 10,
  padding: "10px 14px", fontSize: 14, color: "#e2e8f0", outline: "none", boxSizing: "border-box",
};

const labelStyle: React.CSSProperties = {
  display: "block", fontSize: 12, fontWeight: 700, color: "#64748b",
  textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6,
};

const primaryBtnStyle: React.CSSProperties = {
  flex: 1, padding: "12px", borderRadius: 10, border: "none",
  color: "#fff", fontWeight: 800, fontSize: 14, cursor: "pointer",
};

const cancelBtnStyle: React.CSSProperties = {
  flex: 1, padding: "12px", borderRadius: 10, border: "1px solid #334155",
  background: "transparent", color: "#64748b", fontWeight: 600, fontSize: 14, cursor: "pointer",
};
