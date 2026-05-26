"use client";

import { useMemo, useState } from "react";
import { supabase } from "@/lib/supabase/client";

interface WhatsAppButtonProps {
  phone: string | null | undefined;
  name?: string | null;
  tenantId: string | null | undefined;
  size?: "sm" | "md";
}

function normalizePhonePreview(input: string | null | undefined) {
  let cleaned = (input ?? "").trim().replace(/[\s\-().]/g, "");
  if (!cleaned || !/^\+?\d+$/.test(cleaned)) return null;
  if (cleaned.startsWith("00")) cleaned = `+${cleaned.slice(2)}`;
  if (!cleaned.startsWith("+")) {
    if (/^3\d{9}$/.test(cleaned)) cleaned = `+39${cleaned}`;
    else if (cleaned.startsWith("39") && cleaned.length >= 9) cleaned = `+${cleaned}`;
    else cleaned = `+${cleaned}`;
  }
  return /^\+\d{7,15}$/.test(cleaned) ? cleaned : null;
}

export function WhatsAppButton({ phone, name, tenantId, size = "sm" }: WhatsAppButtonProps) {
  const [busy, setBusy] = useState(false);
  const phoneE164 = useMemo(() => normalizePhonePreview(phone), [phone]);
  const disabled = !phoneE164 || !tenantId || busy;
  const dimension = size === "md" ? "h-9 w-9" : "h-7 w-7";
  const iconSize = size === "md" ? "h-5 w-5" : "h-4 w-4";

  const openWhatsApp = async () => {
    if (disabled) return;
    const popup = window.open("about:blank", "_blank", "noopener,noreferrer");
    try {
      const { data } = supabase ? await supabase.auth.getSession() : { data: { session: null } };
      const token = data.session?.access_token;
      if (!token) throw new Error("Sessione non disponibile.");
      const response = await fetch("/api/ops/whatsapp-contact", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ phone: phoneE164, name: name ?? undefined, tenantId }),
      });
      const body = (await response.json().catch(() => null)) as { url?: string; error?: string } | null;
      if (!response.ok || !body?.url) throw new Error(body?.error ?? "WhatsApp non disponibile.");
      if (popup) {
        popup.location.href = body.url;
      } else {
        window.open(body.url, "_blank", "noopener,noreferrer");
      }
    } catch {
      popup?.close();
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => {
        setBusy(true);
        void openWhatsApp();
      }}
      disabled={disabled}
      title={phoneE164 ? "Apri conversazione WhatsApp" : "Numero telefono non disponibile"}
      aria-label={phoneE164 ? "Apri conversazione WhatsApp" : "Numero telefono non disponibile"}
      className={`inline-flex ${dimension} shrink-0 items-center justify-center rounded-full border transition ${
        disabled
          ? "cursor-not-allowed border-slate-200 bg-slate-100 text-slate-300"
          : "border-emerald-200 bg-emerald-50 text-emerald-700 hover:border-emerald-300 hover:bg-emerald-100"
      }`}
    >
      <svg viewBox="0 0 24 24" className={iconSize} fill="currentColor" aria-hidden="true">
        <path d="M12.04 2a9.86 9.86 0 0 0-8.47 14.9L2.38 22l5.23-1.15A9.92 9.92 0 1 0 12.04 2Zm0 1.8a8.1 8.1 0 0 1 0 16.2 8 8 0 0 1-4.08-1.12l-.31-.18-3.02.66.68-2.93-.2-.32A8.07 8.07 0 0 1 12.04 3.8Zm-3.34 4.3c-.18 0-.47.07-.72.34-.25.27-.95.93-.95 2.27 0 1.34.98 2.64 1.12 2.82.14.18 1.9 3.04 4.74 4.14 2.35.91 2.84.73 3.35.69.51-.05 1.65-.67 1.88-1.32.23-.65.23-1.21.16-1.32-.07-.11-.25-.18-.53-.32-.28-.14-1.65-.82-1.9-.91-.25-.09-.44-.14-.62.14-.18.28-.72.91-.88 1.1-.16.18-.32.21-.6.07-.28-.14-1.18-.44-2.25-1.39-.83-.74-1.39-1.65-1.55-1.93-.16-.28-.02-.43.12-.57.13-.13.28-.32.42-.48.14-.16.18-.28.28-.46.09-.18.05-.34-.02-.48-.07-.14-.62-1.49-.85-2.04-.22-.53-.45-.46-.62-.47h-.54Z" />
      </svg>
    </button>
  );
}

