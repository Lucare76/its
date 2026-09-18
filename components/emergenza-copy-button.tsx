"use client";

import { useState } from "react";

export const EMERGENCY_REPORT_TEMPLATE = `AURIS - Segnalazione problema

Ora:
Pagina:
Operazione che stavo facendo:
Pratica / cliente / servizio:
Succede anche ad altri operatori: sì / no

Descrizione:

Screenshot allegato.`;

export function EmergenzaCopyMessageButton() {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(EMERGENCY_REPORT_TEMPLATE);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard non disponibile/negata: il pulsante resta comunque utilizzabile al prossimo tentativo.
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
    >
      {copied ? "Copiato" : "Copia messaggio"}
    </button>
  );
}
