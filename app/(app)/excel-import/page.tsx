"use client";

import { ChangeEvent, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { EmptyState, PageHeader, SectionCard } from "@/components/ui";

type SheetPreview = {
  name: string;
  rows: number;
  cols: number;
  sample: string[][];
};

type MappingSuggestion = {
  target: string;
  source: string | null;
  confidence: "high" | "medium" | "low";
};

function normalize(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function detectTemplate(sheet: SheetPreview) {
  const header = sheet.sample[0]?.map(normalize) ?? [];
  const headerText = header.join(" | ");
  if (headerText.includes("autista") && headerText.includes("cliente") && headerText.includes("mezzo")) {
    return "lista_operativa";
  }
  if (headerText.includes("cliente") && headerText.includes("da") && headerText.includes("a")) {
    return "dispatch_cliente";
  }
  if (headerText.includes("beneficiario") || headerText.includes("pax")) {
    return "prenotazioni";
  }
  return "non_riconosciuto";
}

function suggestMappings(sheet: SheetPreview): MappingSuggestion[] {
  const header = sheet.sample[0]?.map((item) => item.trim()) ?? [];
  const findHeader = (patterns: string[]) => {
    const found = header.find((item) => patterns.some((pattern) => normalize(item).includes(pattern)));
    return found ?? null;
  };

  const mappingTargets: Array<{ target: string; patterns: string[] }> = [
    { target: "customer_name", patterns: ["cliente", "beneficiario", "nominativo"] },
    { target: "date", patterns: ["data", "dal"] },
    { target: "time", patterns: ["ora", "hh:mm", "inizio"] },
    { target: "pickup", patterns: ["da", "meeting", "imbarco"] },
    { target: "destination", patterns: ["a", "hotel", "destinazione"] },
    { target: "pax", patterns: ["pax", "posti"] },
    { target: "transport_code", patterns: ["flight", "treno", "compagnia", "num."] },
    { target: "driver", patterns: ["autista"] },
    { target: "vehicle", patterns: ["mezzo", "bus"] }
  ];

  return mappingTargets.map((item) => {
    const source = findHeader(item.patterns);
    return {
      target: item.target,
      source,
      confidence: source ? (normalize(source) === item.patterns[0] ? "high" : "medium") : "low"
    };
  });
}

export default function ExcelImportPage() {
  const [message, setMessage] = useState("Carica un Excel cliente o operativo per leggerne subito struttura e fogli.");
  const [sheets, setSheets] = useState<SheetPreview[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);

  const totals = useMemo(
    () => ({
      sheets: sheets.length,
      rows: sheets.reduce((sum, sheet) => sum + sheet.rows, 0)
    }),
    [sheets]
  );
  const primarySheet = sheets[0] ?? null;
  const templateType = primarySheet ? detectTemplate(primarySheet) : null;
  const mappingSuggestions = primarySheet ? suggestMappings(primarySheet) : [];

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: "array" });
      const nextSheets = workbook.SheetNames.map((sheetName) => {
        const sheet = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false }) as string[][];
        const maxCols = rows.reduce((max, row) => Math.max(max, row.length), 0);
        return {
          name: sheetName,
          rows: Math.max(0, rows.length - 1),
          cols: maxCols,
          sample: rows.slice(0, 6).map((row) => row.map((item) => String(item ?? "")))
        } satisfies SheetPreview;
      });
      setSheets(nextSheets);
      setMessage(`File letto correttamente: ${file.name}`);
    } catch (error) {
      setSheets([]);
      setMessage(error instanceof Error ? error.message : "Impossibile leggere il file Excel.");
    }
  };

  return (
    <section className="page-section">
      <PageHeader
        title="Import Excel Guidato"
        subtitle="Workspace per leggere file Excel del cliente, verificare struttura fogli e preparare un eventuale import controllato."
        breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "Import Excel" }]}
      />

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <SectionCard title="File caricato">
          <p className="text-sm font-semibold text-text">{fileName ?? "Nessun file"}</p>
          <p className="mt-1 text-xs text-muted">{message}</p>
        </SectionCard>
        <SectionCard title="Fogli trovati">
          <p className="text-3xl font-semibold text-text">{totals.sheets}</p>
        </SectionCard>
        <SectionCard title="Righe lette">
          <p className="text-3xl font-semibold text-text">{totals.rows}</p>
        </SectionCard>
      </div>

      <SectionCard title="Upload file Excel" subtitle="Solo analisi struttura in questa fase">
        <input type="file" accept=".xlsx,.xls,.csv" className="input-saas" onChange={(event) => void handleFile(event)} />
      </SectionCard>

      <SectionCard title="Checklist import" subtitle="Controlli prima di costruire un import reale">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {[
            "Verifica se il file ha fogli vuoti o di servizio.",
            "Controlla se le intestazioni sono stabili e ripetibili.",
            "Distingui file cliente da foglio operativo interno.",
            "Decidi se serve import completo o solo export compatibile."
          ].map((item) => (
            <article key={item} className="rounded-2xl border border-border bg-surface/80 p-3 text-sm text-text">
              {item}
            </article>
          ))}
        </div>
      </SectionCard>

      <div className="grid gap-4 xl:grid-cols-[1.05fr_0.95fr]">
        <SectionCard title="Riconoscimento template" subtitle="Lettura veloce del tipo file caricato">
          {primarySheet ? (
            <div className="space-y-3">
              <article className="rounded-2xl border border-border bg-surface/80 p-4">
                <p className="text-xs uppercase tracking-[0.14em] text-muted">Foglio principale</p>
                <p className="mt-2 text-lg font-semibold text-text">{primarySheet.name}</p>
                <p className="mt-1 text-sm text-muted">Template rilevato: {templateType}</p>
              </article>
              <div className="grid gap-2 md:grid-cols-2">
                <article className="rounded-2xl border border-border bg-surface/80 p-3">
                  <p className="text-xs uppercase tracking-[0.14em] text-muted">Righe</p>
                  <p className="mt-2 text-2xl font-semibold text-text">{primarySheet.rows}</p>
                </article>
                <article className="rounded-2xl border border-border bg-surface/80 p-3">
                  <p className="text-xs uppercase tracking-[0.14em] text-muted">Colonne</p>
                  <p className="mt-2 text-2xl font-semibold text-text">{primarySheet.cols}</p>
                </article>
              </div>
            </div>
          ) : (
            <EmptyState title="Nessun template rilevato" description="Carica un file per classificare il foglio principale." compact />
          )}
        </SectionCard>

        <SectionCard title="Mapping suggerito" subtitle="Prime corrispondenze utili per un import guidato">
          {mappingSuggestions.length === 0 ? (
            <EmptyState title="Nessun mapping disponibile" description="Serve un file caricato per suggerire le colonne." compact />
          ) : (
            <div className="space-y-2">
              {mappingSuggestions.map((item) => (
                <article key={item.target} className="rounded-2xl border border-border bg-surface/80 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold text-text">{item.target}</p>
                      <p className="text-xs text-muted">{item.source ?? "non trovato"}</p>
                    </div>
                    <span className="rounded-full bg-white px-2.5 py-1 text-[11px] uppercase tracking-[0.12em] text-slate-700 shadow-sm">
                      {item.confidence}
                    </span>
                  </div>
                </article>
              ))}
            </div>
          )}
        </SectionCard>
      </div>

      <SectionCard title="Anteprima fogli" subtitle="Prime righe per capire struttura colonne">
        {sheets.length === 0 ? (
          <EmptyState title="Nessun foglio disponibile" description="Carica un file Excel per vedere anteprima e struttura." compact />
        ) : (
          <div className="space-y-4">
            {sheets.map((sheet) => (
              <article key={sheet.name} className="rounded-2xl border border-border bg-surface/80 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-text">{sheet.name}</p>
                    <p className="text-xs text-muted">{sheet.rows} righe · {sheet.cols} colonne</p>
                  </div>
                </div>
                <div className="mt-3 overflow-x-auto rounded-xl border border-slate-200">
                  <table className="min-w-full text-sm">
                    <tbody>
                      {sheet.sample.map((row, index) => (
                        <tr key={`${sheet.name}-${index}`} className="border-t border-slate-100 first:border-t-0">
                          {row.map((cell, cellIndex) => (
                            <td key={`${sheet.name}-${index}-${cellIndex}`} className="px-3 py-2">
                              {cell || <span className="text-slate-300">vuoto</span>}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </article>
            ))}
          </div>
        )}
      </SectionCard>
    </section>
  );
}
