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
    EMAIL_INBOUND_TOKEN: boolean;
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
  "EMAIL_INBOUND_TOKEN",
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
  const [serverState, setServerState] = useState<CheckState>({ ok: false, detail: "Checking..." });
  const [clientState, setClientState] = useState<CheckState>({ ok: false, detail: "Checking..." });
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
        setServerState({ ok: data.server.ok, detail: data.server.ok ? "Supabase server check OK" : "Supabase server check failed" });
        setEnvState(data.env);
        setFeatureState(data.features);
        setCheckedAt(new Date(data.timestamp).toLocaleString());
      } catch {
        if (cancelled) return;
        setServerState({ ok: false, detail: "Health endpoint unreachable" });
      }
    };

    const runClientCheck = async () => {
      if (!hasSupabaseEnv || !supabase) {
        setClientState({ ok: false, detail: "Supabase client env missing" });
        return;
      }

      try {
        const { error } = await supabase.auth.getSession();
        if (cancelled) return;
        setClientState({ ok: !error, detail: error ? `Client check failed: ${error.message}` : "Supabase client check OK" });
      } catch {
        if (cancelled) return;
        setClientState({ ok: false, detail: "Supabase client check failed" });
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
      <h1 className="text-2xl font-semibold text-text">Health</h1>
      <p className="text-sm text-muted">Read-only checks for production config and Supabase connectivity. No secrets are displayed.</p>

      <div className="grid gap-3 md:grid-cols-2">
        <article className="card p-4">
          <p className="text-xs uppercase tracking-[0.16em] text-muted">Server Check</p>
          <p className={`mt-2 text-sm font-medium ${serverState.ok ? "text-emerald-700" : "text-rose-700"}`}>
            {serverState.ok ? "OK" : "FAIL"}
          </p>
          <p className="mt-1 text-sm text-muted">{serverState.detail}</p>
        </article>

        <article className="card p-4">
          <p className="text-xs uppercase tracking-[0.16em] text-muted">Client Check</p>
          <p className={`mt-2 text-sm font-medium ${clientState.ok ? "text-emerald-700" : "text-rose-700"}`}>
            {clientState.ok ? "OK" : "FAIL"}
          </p>
          <p className="mt-1 text-sm text-muted">{clientState.detail}</p>
        </article>
      </div>

      <article className="card p-4">
        <p className="text-xs uppercase tracking-[0.16em] text-muted">Environment Presence</p>
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          {envOrder.map((key) => (
            <div key={key} className="flex items-center justify-between rounded-xl border border-border bg-surface-2 px-3 py-2">
              <span className="text-sm text-text">{key}</span>
              <span className={`rounded-full px-2 py-1 text-xs font-semibold ${envState?.[key] ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}`}>
                {envState?.[key] ? "present" : "missing"}
              </span>
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-muted">Last check: {checkedAt}</p>
      </article>

      <article className="card p-4">
        <p className="text-xs uppercase tracking-[0.16em] text-muted">Features</p>
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          <div className="flex items-center justify-between rounded-xl border border-border bg-surface-2 px-3 py-2">
            <span className="text-sm text-text">excel_export_route_enabled</span>
            <span className={`rounded-full px-2 py-1 text-xs font-semibold ${featureState?.excel_export_route_enabled ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}`}>
              {featureState?.excel_export_route_enabled ? "enabled" : "disabled"}
            </span>
          </div>
        </div>
      </article>

      <article className="card p-4">
        <p className="text-xs uppercase tracking-[0.16em] text-muted">Client Env Presence</p>
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          {Object.entries(clientEnv).map(([key, present]) => (
            <div key={key} className="flex items-center justify-between rounded-xl border border-border bg-surface-2 px-3 py-2">
              <span className="text-sm text-text">{key}</span>
              <span className={`rounded-full px-2 py-1 text-xs font-semibold ${present ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}`}>
                {present ? "present" : "missing"}
              </span>
            </div>
          ))}
        </div>
      </article>
    </section>
  );
}
