"use client";

import { FormEvent, useEffect, useState } from "react";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";

type WhatsAppSettings = {
  default_template: string;
  template_language: string;
  enable_2h_reminder: boolean;
  allow_text_fallback: boolean;
};

const defaultSettings: WhatsAppSettings = {
  default_template: "transfer_reminder",
  template_language: "it",
  enable_2h_reminder: false,
  allow_text_fallback: false
};

export default function WhatsAppSettingsPage() {
  const [settings, setSettings] = useState<WhatsAppSettings>(defaultSettings);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("Caricamento configurazione...");

  useEffect(() => {
    let active = true;

    const load = async () => {
      if (!hasSupabaseEnv || !supabase) {
        if (!active) return;
        setLoading(false);
        setMessage("Supabase non configurato.");
        return;
      }

      const { data, error } = await supabase.auth.getSession();
      if (!active) return;
      if (error || !data.session?.access_token) {
        setLoading(false);
        setMessage("Sessione non valida.");
        return;
      }

      const response = await fetch("/api/whatsapp/settings", {
        headers: { Authorization: `Bearer ${data.session.access_token}` }
      });
      if (!active) return;
      if (response.status === 403) {
        setLoading(false);
        setMessage("Accesso negato: solo admin.");
        return;
      }
      if (!response.ok) {
        setLoading(false);
        setMessage("Errore caricamento settings.");
        return;
      }

      const body = (await response.json().catch(() => null)) as { settings?: Partial<WhatsAppSettings> } | null;
      setSettings({
        default_template: body?.settings?.default_template ?? defaultSettings.default_template,
        template_language: body?.settings?.template_language ?? defaultSettings.template_language,
        enable_2h_reminder: Boolean(body?.settings?.enable_2h_reminder),
        allow_text_fallback: Boolean(body?.settings?.allow_text_fallback)
      });
      setLoading(false);
      setMessage("Configura template e reminder per tenant.");
    };

    void load();
    return () => {
      active = false;
    };
  }, []);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!hasSupabaseEnv || !supabase) return;
    setSaving(true);
    setMessage("Salvataggio...");

    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) {
      setSaving(false);
      setMessage("Sessione non valida.");
      return;
    }

    const response = await fetch("/api/whatsapp/settings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(settings)
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      setSaving(false);
      setMessage(body?.error ?? "Salvataggio fallito.");
      return;
    }

    setSaving(false);
    setMessage("Configurazione salvata.");
  };

  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold">WhatsApp Settings (Admin)</h1>
      <p className="text-sm text-muted">{message}</p>

      {loading ? (
        <article className="card p-4 text-sm text-muted">Caricamento...</article>
      ) : (
        <form onSubmit={onSubmit} className="card grid gap-4 p-4 md:max-w-2xl">
          <label className="grid gap-1">
            <span className="text-sm font-medium text-text">Template di default</span>
            <input
              value={settings.default_template}
              onChange={(event) => setSettings((prev) => ({ ...prev, default_template: event.target.value }))}
              className="input-saas"
              placeholder="transfer_reminder"
            />
          </label>

          <label className="grid gap-1">
            <span className="text-sm font-medium text-text">Lingua template</span>
            <select
              value={settings.template_language}
              onChange={(event) => setSettings((prev) => ({ ...prev, template_language: event.target.value }))}
              className="input-saas"
            >
              <option value="it">it</option>
              <option value="en_US">en_US</option>
              <option value="es">es</option>
              <option value="fr">fr</option>
            </select>
          </label>

          <label className="flex items-center gap-2 text-sm text-text">
            <input
              type="checkbox"
              checked={settings.enable_2h_reminder}
              onChange={(event) => setSettings((prev) => ({ ...prev, enable_2h_reminder: event.target.checked }))}
            />
            Abilita messaggio reminder a 2h
          </label>

          <label className="flex items-center gap-2 text-sm text-text">
            <input
              type="checkbox"
              checked={settings.allow_text_fallback}
              onChange={(event) => setSettings((prev) => ({ ...prev, allow_text_fallback: event.target.checked }))}
            />
            Consenti fallback a messaggio testo se template fallisce
          </label>

          <div>
            <button type="submit" className="btn-primary" disabled={saving}>
              {saving ? "Salvataggio..." : "Salva configurazione"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
