"use client";

import { ChangeEvent, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { EmptyState, PageHeader, SectionCard } from "@/components/ui";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";

type AgencyBookingRowStatus = "ready" | "warning" | "error" | "duplicate" | "update";

type GeneratedServiceDraft = {
  legRowIndex: number;
  bookingServiceKind: "transfer_airport_hotel" | "transfer_hotel_hotel";
  direction: "arrival" | "departure";
  date: string;
  time: string;
  pax: number;
  hotelId: string | null;
  hotelNameRaw: string | null;
  hotelToId: string | null;
  hotelToNameRaw: string | null;
  vessel: string;
  meetingPoint: string | null;
  notes: string;
  warnings: string[];
  pickupHotel: string | null;
  barcaCompagnia: string | null;
  orarioBarca: string | null;
  portoBruno: string | null;
  pickupAlert: string | null;
};

type MtsGlobePreviewBooking = {
  voucherNo: string;
  sourceBookingKey: string;
  customerName: string;
  date: string;
  pax: number;
  hotelNameRaw: string | null;
  serviceScope: "round_trip" | "outbound_only" | "return_only";
  status: AgencyBookingRowStatus;
  reasons: string[];
  generatedServices: GeneratedServiceDraft[];
  existingAgencyBookingId: string | null;
};

type MtsGlobePreviewResult = {
  bookings: MtsGlobePreviewBooking[];
  rowErrors: Array<{ rowIndex: number; voucherNo: string | null; message: string }>;
  summary: {
    totalRows: number;
    bookingCount: number;
    serviceCount: number;
    readyCount: number;
    warningCount: number;
    errorCount: number;
    duplicateCount: number;
    updateCount: number;
  };
};

type ConfirmResult = {
  importedBookingCount: number;
  importedServiceCount: number;
  skippedDuplicateCount: number;
  failedBookings: Array<{ voucherNo: string; message: string }>;
};

type HotelOption = { id: string; name: string };

const STATUS_LABEL: Record<AgencyBookingRowStatus, string> = {
  ready: "Pronto",
  warning: "Warning",
  duplicate: "Duplicato",
  update: "Da rivedere (dati diversi)",
  error: "Errore"
};

const STATUS_CLASS: Record<AgencyBookingRowStatus, string> = {
  ready: "bg-emerald-50 text-emerald-700",
  warning: "bg-amber-50 text-amber-700",
  duplicate: "bg-slate-100 text-slate-600",
  update: "bg-sky-50 text-sky-700",
  error: "bg-rose-50 text-rose-700"
};

const DIRECTION_LABEL: Record<GeneratedServiceDraft["direction"], string> = {
  arrival: "Arrivo",
  departure: "Partenza"
};

function legLabel(service: GeneratedServiceDraft): string {
  if (service.bookingServiceKind === "transfer_hotel_hotel") return "Intermedio";
  return DIRECTION_LABEL[service.direction];
}

function correctionKey(voucherNo: string, legRowIndex: number, part?: "from" | "to"): string {
  return part ? `${voucherNo}#${legRowIndex}#${part}` : `${voucherNo}#${legRowIndex}`;
}

async function readRowsFromFile(file: File): Promise<Array<Record<string, unknown>>> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array" });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
}

export default function MtsGlobeImportPage() {
  const [fileName, setFileName] = useState<string | null>(null);
  const [rawRows, setRawRows] = useState<Array<Record<string, unknown>>>([]);
  const [preview, setPreview] = useState<MtsGlobePreviewResult | null>(null);
  const [hotelCorrections, setHotelCorrections] = useState<Record<string, string>>({});
  const [timeCorrections, setTimeCorrections] = useState<Record<string, string>>({});
  const [hotels, setHotels] = useState<HotelOption[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [confirmLoading, setConfirmLoading] = useState(false);
  const [confirmResult, setConfirmResult] = useState<ConfirmResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const hotelsLoaded = hotels.length > 0;

  async function ensureHotelsLoaded() {
    if (hotelsLoaded || !hasSupabaseEnv || !supabase) return;
    const { data } = await supabase.from("hotels").select("id, name").order("name", { ascending: true });
    setHotels(((data ?? []) as HotelOption[]) ?? []);
  }

  async function authHeader(): Promise<Record<string, string>> {
    if (!hasSupabaseEnv || !supabase) return {};
    const session = await supabase.auth.getSession();
    const token = session.data.session?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setPreview(null);
    setConfirmResult(null);
    setHotelCorrections({});
    setTimeCorrections({});
    setMessage(null);
    try {
      const rows = await readRowsFromFile(file);
      if (rows.length === 0) {
        setMessage("Nessuna riga trovata nel file.");
        return;
      }
      setRawRows(rows);
      await ensureHotelsLoaded();
      await runPreview(rows, {}, {});
    } catch (error) {
      setMessage(`Errore lettura file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function runPreview(rows: Array<Record<string, unknown>>, corrections: Record<string, string>, timeCorr: Record<string, string>) {
    setPreviewLoading(true);
    setMessage(null);
    try {
      const headers = await authHeader();
      const response = await fetch("/api/ops/agency-imports/mts-globe", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ mode: "preview", rows, hotel_corrections: corrections, time_corrections: timeCorr })
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        setMessage(data.error ?? "Errore durante la preview.");
        return;
      }
      setPreview(data as MtsGlobePreviewResult);
    } catch (error) {
      setMessage(`Errore di rete durante la preview: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setPreviewLoading(false);
    }
  }

  function setCorrection(key: string, hotelId: string) {
    setHotelCorrections((prev) => {
      const next = { ...prev };
      if (hotelId) next[key] = hotelId;
      else delete next[key];
      return next;
    });
  }

  function setTimeCorrection(key: string, time: string) {
    setTimeCorrections((prev) => {
      const next = { ...prev };
      if (time) next[key] = time;
      else delete next[key];
      return next;
    });
  }

  async function reapplyCorrections() {
    if (rawRows.length === 0) return;
    await runPreview(rawRows, hotelCorrections, timeCorrections);
  }

  async function handleConfirm() {
    if (rawRows.length === 0) return;
    setConfirmLoading(true);
    setMessage(null);
    try {
      const headers = await authHeader();
      const response = await fetch("/api/ops/agency-imports/mts-globe", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ mode: "confirm", rows: rawRows, hotel_corrections: hotelCorrections, time_corrections: timeCorrections })
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        setMessage(data.error ?? "Errore durante il confirm.");
        return;
      }
      setConfirmResult(data as ConfirmResult);
      // Rileggi la preview dopo il confirm: le pratiche appena create risultano DUPLICATE.
      await runPreview(rawRows, hotelCorrections, timeCorrections);
    } catch (error) {
      setMessage(`Errore di rete durante il confirm: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setConfirmLoading(false);
    }
  }

  const summary = preview?.summary ?? null;
  const confirmableCount = useMemo(
    () => preview?.bookings.filter((b) => b.status === "ready").length ?? 0,
    [preview]
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="Import agenzia — MTS Globe / Sun&Sea"
        subtitle="Carica il file booking-item-list, correggi gli hotel non riconosciuti, poi conferma solo le pratiche pronte."
        breadcrumbs={[{ label: "Import agenzia", href: "/agency-imports/mts-globe" }, { label: "MTS Globe" }]}
      />

      <SectionCard title="1. Carica file" subtitle="Excel esportato da MTS Globe (booking-item-list).">
        <div className="flex flex-wrap items-center gap-3">
          <input type="file" accept=".xlsx,.xls,.csv" className="input-saas" onChange={(event) => void handleFile(event)} />
          {fileName ? <span className="text-sm text-muted">{fileName} — {rawRows.length} righe lette</span> : null}
          {previewLoading ? <span className="text-sm text-muted">Analisi in corso…</span> : null}
        </div>
        {message ? <p className="mt-3 text-sm text-rose-600">{message}</p> : null}
      </SectionCard>

      {summary ? (
        <SectionCard title="2. Riepilogo">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
            <SummaryTile label="Righe file" value={summary.totalRows} />
            <SummaryTile label="Prenotazioni" value={summary.bookingCount} />
            <SummaryTile label="Pronte" value={summary.readyCount} tone="emerald" />
            <SummaryTile label="Warning" value={summary.warningCount} tone="amber" />
            <SummaryTile label="Duplicate" value={summary.duplicateCount} tone="slate" />
            <SummaryTile label="Da rivedere" value={summary.updateCount} tone="sky" />
            <SummaryTile label="Errori riga" value={summary.errorCount} tone="rose" />
          </div>
          <p className="mt-3 text-sm text-muted">
            Servizi che verranno generati al confirm (solo pratiche pronte): <strong>{preview?.bookings
              .filter((b) => b.status === "ready")
              .reduce((sum, b) => sum + b.generatedServices.length, 0) ?? 0}</strong>
          </p>
        </SectionCard>
      ) : null}

      {preview && preview.rowErrors.length > 0 ? (
        <SectionCard title="Righe non importabili" subtitle="Errori di parsing: la riga non genera alcuna prenotazione.">
          <ul className="space-y-1 text-sm text-rose-700">
            {preview.rowErrors.map((err, index) => (
              <li key={`${err.rowIndex}-${index}`}>
                Riga {err.rowIndex}{err.voucherNo ? ` (voucher ${err.voucherNo})` : ""}: {err.message}
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}

      {preview ? (
        <SectionCard
          title="3. Prenotazioni"
          subtitle="Ogni riga è una pratica (Voucher No), con i leg arrivo/partenza/intermedio sotto. Correggi l'hotel dove serve, poi conferma."
          actions={
            <button
              type="button"
              className="btn-saas-primary"
              disabled={confirmableCount === 0 || confirmLoading}
              onClick={() => void handleConfirm()}
            >
              {confirmLoading ? "Conferma in corso…" : `Conferma ${confirmableCount} pratica/e pronta/e`}
            </button>
          }
        >
          {preview.bookings.length === 0 ? (
            <EmptyState title="Nessuna prenotazione" description="Il file non contiene righe valide." compact />
          ) : (
            <div className="space-y-3">
              {preview.bookings.map((booking) => (
                <BookingCard
                  key={booking.sourceBookingKey}
                  booking={booking}
                  hotels={hotels}
                  corrections={hotelCorrections}
                  onCorrect={setCorrection}
                  timeCorrections={timeCorrections}
                  onTimeCorrect={setTimeCorrection}
                />
              ))}
              <div className="flex justify-end">
                <button type="button" className="btn-saas-secondary" onClick={() => void reapplyCorrections()} disabled={previewLoading}>
                  {previewLoading ? "Ricalcolo…" : "Applica correzioni hotel"}
                </button>
              </div>
            </div>
          )}
        </SectionCard>
      ) : null}

      {confirmResult ? (
        <SectionCard title="4. Risultato import">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <SummaryTile label="Pratiche importate" value={confirmResult.importedBookingCount} tone="emerald" />
            <SummaryTile label="Servizi creati" value={confirmResult.importedServiceCount} tone="emerald" />
            <SummaryTile label="Duplicate saltate" value={confirmResult.skippedDuplicateCount} tone="slate" />
            <SummaryTile label="Fallite" value={confirmResult.failedBookings.length} tone="rose" />
          </div>
          {confirmResult.failedBookings.length > 0 ? (
            <ul className="mt-3 space-y-1 text-sm text-rose-700">
              {confirmResult.failedBookings.map((f) => (
                <li key={f.voucherNo}>Voucher {f.voucherNo}: {f.message}</li>
              ))}
            </ul>
          ) : null}
        </SectionCard>
      ) : null}
    </div>
  );
}

function SummaryTile({ label, value, tone }: { label: string; value: number; tone?: "emerald" | "amber" | "slate" | "sky" | "rose" }) {
  const toneClass =
    tone === "emerald" ? "text-emerald-700" :
    tone === "amber" ? "text-amber-700" :
    tone === "slate" ? "text-slate-600" :
    tone === "sky" ? "text-sky-700" :
    tone === "rose" ? "text-rose-700" : "text-text";
  return (
    <div className="rounded-lg border border-border bg-surface/80 p-3">
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p className={`mt-1 text-xl font-semibold ${toneClass}`}>{value}</p>
    </div>
  );
}

function BookingCard({
  booking,
  hotels,
  corrections,
  onCorrect,
  timeCorrections,
  onTimeCorrect
}: {
  booking: MtsGlobePreviewBooking;
  hotels: HotelOption[];
  corrections: Record<string, string>;
  onCorrect: (key: string, hotelId: string) => void;
  timeCorrections: Record<string, string>;
  onTimeCorrect: (key: string, time: string) => void;
}) {
  const isBlocked = booking.status === "duplicate" || booking.status === "update" || booking.status === "error";
  return (
    <article className={`rounded-lg border p-3 ${isBlocked ? "border-border bg-surface-2/60" : "border-border bg-surface/80"}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-text">
            Voucher {booking.voucherNo} — {booking.customerName}
          </p>
          <p className="text-xs text-muted">
            {booking.date} · {booking.pax} pax · {booking.serviceScope === "round_trip" ? "A/R" : booking.serviceScope === "outbound_only" ? "Solo arrivo" : "Solo partenza"}
          </p>
        </div>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CLASS[booking.status]}`}>
          {STATUS_LABEL[booking.status]}
        </span>
      </div>

      {booking.reasons.length > 0 ? (
        <ul className="mt-2 space-y-0.5 text-xs text-muted">
          {booking.reasons.map((reason, index) => (
            <li key={index}>• {reason}</li>
          ))}
        </ul>
      ) : null}

      {booking.status === "duplicate" ? (
        <p className="mt-2 text-xs font-medium text-slate-600">Già importato — non selezionabile.</p>
      ) : null}
      {booking.status === "update" ? (
        <p className="mt-2 text-xs font-medium text-sky-700">
          Pratica esistente con dati diversi nel file: nessuna modifica automatica. Verificare manualmente.
        </p>
      ) : null}

      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[720px] text-xs">
          <thead>
            <tr className="text-left text-muted">
              <th className="py-1 pr-2">Leg</th>
              <th className="py-1 pr-2">Data</th>
              <th className="py-1 pr-2">Orario volo</th>
              <th className="py-1 pr-2">Pickup hotel</th>
              <th className="py-1 pr-2">Nave/Porto</th>
              <th className="py-1 pr-2">Hotel</th>
              <th className="py-1 pr-2">Servizio ITS</th>
              <th className="py-1 pr-2">Warning</th>
            </tr>
          </thead>
          <tbody>
            {booking.generatedServices.map((service) => (
              <ServiceRow
                key={`${service.legRowIndex}-${service.direction}-${service.bookingServiceKind}`}
                voucherNo={booking.voucherNo}
                service={service}
                hotels={hotels}
                corrections={corrections}
                onCorrect={onCorrect}
                timeCorrections={timeCorrections}
                onTimeCorrect={onTimeCorrect}
              />
            ))}
          </tbody>
        </table>
      </div>
    </article>
  );
}

function ServiceRow({
  voucherNo,
  service,
  hotels,
  corrections,
  onCorrect,
  timeCorrections,
  onTimeCorrect
}: {
  voucherNo: string;
  service: GeneratedServiceDraft;
  hotels: HotelOption[];
  corrections: Record<string, string>;
  onCorrect: (key: string, hotelId: string) => void;
  timeCorrections: Record<string, string>;
  onTimeCorrect: (key: string, time: string) => void;
}) {
  const isHotelChange = service.bookingServiceKind === "transfer_hotel_hotel";
  const primaryKey = correctionKey(voucherNo, service.legRowIndex, isHotelChange ? "from" : undefined);
  const secondaryKey = isHotelChange ? correctionKey(voucherNo, service.legRowIndex, "to") : null;
  const timeKey = `${voucherNo}#${service.legRowIndex}#time`;

  return (
    <tr className="border-t border-border/60 align-top">
      <td className="py-1.5 pr-2 font-medium">{legLabel(service)}</td>
      <td className="py-1.5 pr-2">{service.date}</td>
      <td className="py-1.5 pr-2">
        {isHotelChange ? (
          service.time ? (
            <span>{service.time}</span>
          ) : (
            <TimeCell timeKey={timeKey} currentCorrection={timeCorrections[timeKey]} onCorrect={onTimeCorrect} />
          )
        ) : service.direction === "departure" ? (
          `${service.time} (volo)`
        ) : (
          service.time
        )}
      </td>
      <td className="py-1.5 pr-2">{service.pickupHotel ?? "—"}</td>
      <td className="py-1.5 pr-2">
        {service.barcaCompagnia ? `${service.barcaCompagnia}${service.portoBruno ? ` · ${service.portoBruno}` : ""}` : "—"}
      </td>
      <td className="py-1.5 pr-2">
        <HotelCell
          label={service.hotelNameRaw}
          hotelId={service.hotelId}
          correctionKey={primaryKey}
          hotels={hotels}
          currentCorrection={corrections[primaryKey]}
          onCorrect={onCorrect}
        />
        {isHotelChange && secondaryKey ? (
          <div className="mt-1">
            <span className="text-muted">→ </span>
            <HotelCell
              label={service.hotelToNameRaw}
              hotelId={service.hotelToId}
              correctionKey={secondaryKey}
              hotels={hotels}
              currentCorrection={corrections[secondaryKey]}
              onCorrect={onCorrect}
            />
          </div>
        ) : null}
      </td>
      <td className="py-1.5 pr-2">{service.notes}</td>
      <td className="py-1.5 pr-2 text-amber-700">
        {service.warnings.length > 0 ? service.warnings.join(" ") : "—"}
      </td>
    </tr>
  );
}

function HotelCell({
  label,
  hotelId,
  correctionKey: key,
  hotels,
  currentCorrection,
  onCorrect
}: {
  label: string | null;
  hotelId: string | null;
  correctionKey: string;
  hotels: HotelOption[];
  currentCorrection: string | undefined;
  onCorrect: (key: string, hotelId: string) => void;
}) {
  if (hotelId) {
    return <span className="text-text">{label ?? hotelId}</span>;
  }
  return (
    <div className="space-y-1">
      <span className="block text-rose-700">{label ?? "hotel mancante"} — non riconosciuto</span>
      <select
        className="input-saas w-full text-xs"
        value={currentCorrection ?? ""}
        onChange={(event) => onCorrect(key, event.target.value)}
      >
        <option value="">Scegli hotel canonico…</option>
        {hotels.map((hotel) => (
          <option key={hotel.id} value={hotel.id}>{hotel.name}</option>
        ))}
      </select>
    </div>
  );
}

function TimeCell({
  timeKey,
  currentCorrection,
  onCorrect
}: {
  timeKey: string;
  currentCorrection: string | undefined;
  onCorrect: (key: string, time: string) => void;
}) {
  return (
    <div className="space-y-1">
      <span className="block text-rose-700">Orario transfer Intermedio mancante</span>
      <input
        type="time"
        className="input-saas w-full text-xs"
        value={currentCorrection ?? ""}
        onChange={(event) => onCorrect(timeKey, event.target.value)}
      />
    </div>
  );
}
