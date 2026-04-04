"use client";

import { useEffect, useState } from "react";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";

type HealthPayload = {
  ok: boolean;
  server: {
    ok: boolean;
  };
  env: {
    NEXT_PUBLIC_SUPABASE_URL: boolean;
    NEXT_PUBLIC_SUPABASE_ANON_KEY: boolean;
    SUPABASE_SERVICE_ROLE_KEY: boolean;
    NEXT_PUBLIC_APP_URL: boolean;
    EMAIL_INBOUND_TOKEN: boolean;
    RESEND_API_KEY: boolean;
    AGENCY_BOOKING_FROM_EMAIL: boolean;
    AGENCY_BOOKING_BETA_RECIPIENT_EMAIL: boolean;
    NEXT_PUBLIC_AGENCY_DEFAULT_CONFIRMATION_EMAIL: boolean;
    IMAP_HOST: boolean;
    IMAP_PORT: boolean;
    IMAP_USER: boolean;
    IMAP_PASS: boolean;
    IMAP_TLS: boolean;
    CRON_SECRET: boolean;
    WHATSAPP_TOKEN: boolean;
    WHATSAPP_PHONE_NUMBER_ID: boolean;
    WHATSAPP_VERIFY_TOKEN: boolean;
    WHATSAPP_REMINDER_WINDOW_MINUTES: boolean;
    WHATSAPP_REMINDER_2H_ENABLED: boolean;
    WHATSAPP_TEMPLATE_LANGUAGE: boolean;
    WHATSAPP_ALLOW_TEXT_FALLBACK: boolean;
  };
  features: {
    excel_export_route_enabled: boolean;
    share_route_present: boolean;
    share_og_image_present: boolean;
  };
  timestamp: string;
};

type CheckState = {
  ok: boolean;
  detail: string;
};

const envOrder: Array<keyof HealthPayload["env"]> = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "NEXT_PUBLIC_APP_URL",
  "EMAIL_INBOUND_TOKEN",
  "RESEND_API_KEY",
  "AGENCY_BOOKING_FROM_EMAIL",
  "AGENCY_BOOKING_BETA_RECIPIENT_EMAIL",
  "NEXT_PUBLIC_AGENCY_DEFAULT_CONFIRMATION_EMAIL",
  "IMAP_HOST",
  "IMAP_PORT",
  "IMAP_USER",
  "IMAP_PASS",
  "IMAP_TLS",
  "CRON_SECRET",
  "WHATSAPP_TOKEN",
  "WHATSAPP_PHONE_NUMBER_ID",
  "WHATSAPP_VERIFY_TOKEN",
  "WHATSAPP_REMINDER_WINDOW_MINUTES",
  "WHATSAPP_REMINDER_2H_ENABLED",
  "WHATSAPP_TEMPLATE_LANGUAGE",
  "WHATSAPP_ALLOW_TEXT_FALLBACK"
];

export default function HealthPage() {
  const [serverState, setServerState] = useState<CheckState>({ ok: false, detail: "Controllo in corso..." });
  const [clientState, setClientState] = useState<CheckState>({ ok: false, detail: "Controllo in corso..." });
  const [envState, setEnvState] = useState<HealthPayload["env"] | null>(null);
  const [featureState, setFeatureState] = useState<HealthPayload["features"] | null>(null);
  const [checkedAt, setCheckedAt] = useState<string>("-");
  const clientEnv = {
    NEXT_PUBLIC_SUPABASE_URL: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
  };

  useEffect(() => {
    let cancelled = false;

    const runServerCheck = async () => {
      try {
        const response = await fetch("/api/health", { cache: "no-store" });
        const data = (await response.json()) as HealthPayload;
        if (cancelled) return;
        setServerState({ ok: data.server.ok, detail: data.server.ok ? "Controllo server Supabase OK" : "Controllo server Supabase fallito" });
        setEnvState(data.env);
        setFeatureState(data.features);
        setCheckedAt(new Date(data.timestamp).toLocaleString());
      } catch {
        if (cancelled) return;
        setServerState({ ok: false, detail: "Endpoint health non raggiungibile" });
      }
    };

    const runClientCheck = async () => {
      if (!hasSupabaseEnv || !supabase) {
        setClientState({ ok: false, detail: "Variabili client Supabase mancanti" });
        return;
      }

      try {
        const { error } = await supabase.auth.getSession();
        if (cancelled) return;
        setClientState({ ok: !error, detail: error ? `Controllo client fallito: ${error.message}` : "Controllo client Supabase OK" });
      } catch {
        if (cancelled) return;
        setClientState({ ok: false, detail: "Controllo client Supabase fallito" });
      }
    };

    void runServerCheck();
    void runClientCheck();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold text-text">Stato Sistema</h1>
      <p className="text-sm text-muted">Controlli in sola lettura per configurazione produzione e connettivita Supabase. Nessun segreto viene mostrato.</p>

      <div className="grid gap-3 md:grid-cols-2">
        <article className="card p-4">
          <p className="text-xs uppercase tracking-[0.16em] text-muted">Controllo Server</p>
          <p className={`mt-2 text-sm font-medium ${serverState.ok ? "text-emerald-700" : "text-rose-700"}`}>
            {serverState.ok ? "OK" : "ERRORE"}
          </p>
          <p className="mt-1 text-sm text-muted">{serverState.detail}</p>
        </article>

        <article className="card p-4">
          <p className="text-xs uppercase tracking-[0.16em] text-muted">Controllo Client</p>
          <p className={`mt-2 text-sm font-medium ${clientState.ok ? "text-emerald-700" : "text-rose-700"}`}>
            {clientState.ok ? "OK" : "ERRORE"}
          </p>
          <p className="mt-1 text-sm text-muted">{clientState.detail}</p>
        </article>
      </div>

      <article className="card p-4">
        <p className="text-xs uppercase tracking-[0.16em] text-muted">Presenza Variabili Ambiente</p>
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          {envOrder.map((key) => (
            <div key={key} className="flex items-center justify-between rounded-xl border border-border bg-surface-2 px-3 py-2">
              <span className="text-sm text-text">{key}</span>
              <span className={`rounded-full px-2 py-1 text-xs font-semibold ${envState?.[key] ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}`}>
                {envState?.[key] ? "presente" : "mancante"}
              </span>
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-muted">Ultimo controllo: {checkedAt}</p>
      </article>

      <article className="card p-4">
        <p className="text-xs uppercase tracking-[0.16em] text-muted">Funzionalita</p>
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          {[
            { key: "excel_export_route_enabled", value: featureState?.excel_export_route_enabled },
            { key: "share_route_present", value: featureState?.share_route_present },
            { key: "share_og_image_present", value: featureState?.share_og_image_present }
          ].map((item) => (
            <div key={item.key} className="flex items-center justify-between rounded-xl border border-border bg-surface-2 px-3 py-2">
              <span className="text-sm text-text">{item.key}</span>
              <span className={`rounded-full px-2 py-1 text-xs font-semibold ${item.value ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}`}>
                {item.value ? "attiva" : "disattiva"}
              </span>
            </div>
          ))}
        </div>
      </article>

      <article className="card p-4">
        <p className="text-xs uppercase tracking-[0.16em] text-muted">Presenza Env Client</p>
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          {Object.entries(clientEnv).map(([key, present]) => (
            <div key={key} className="flex items-center justify-between rounded-xl border border-border bg-surface-2 px-3 py-2">
              <span className="text-sm text-text">{key}</span>
              <span className={`rounded-full px-2 py-1 text-xs font-semibold ${present ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}`}>
                {present ? "presente" : "mancante"}
              </span>
            </div>
          ))}
        </div>
      </article>
    </section>
  );
}
