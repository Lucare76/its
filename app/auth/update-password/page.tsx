"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { PasswordStrengthMeter } from "@/components/password-strength-meter";

export default function UpdatePasswordPage() {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(supabase ? "Verifica link di recupero in corso..." : "Supabase non configurato.");

  useEffect(() => {
    const client = supabase;
    if (!client) return;

    let active = true;

    const checkSession = async () => {
      const { data } = await client.auth.getSession();
      if (!active) return;
      if (data.session) {
        setReady(true);
        setMessage("Imposta una nuova password per il tuo accesso.");
        return;
      }
      setMessage("Link di reset non valido o scaduto. Richiedi una nuova email.");
    };

    void checkSession();

    const { data: subscription } = client.auth.onAuthStateChange((event, session) => {
      if (!active) return;
      if ((event === "PASSWORD_RECOVERY" || event === "SIGNED_IN" || event === "INITIAL_SESSION") && session) {
        setReady(true);
        setMessage("Imposta una nuova password per il tuo accesso.");
      }
    });

    return () => {
      active = false;
      subscription.subscription.unsubscribe();
    };
  }, []);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const client = supabase;
    if (!client || saving) return;

    if (password.trim().length < 8) {
      setMessage("La nuova password deve avere almeno 8 caratteri.");
      return;
    }
    if (password !== confirmPassword) {
      setMessage("Le password non coincidono.");
      return;
    }

    setSaving(true);
    setMessage("Salvataggio nuova password...");

    const userResponse = await client.auth.getUser();
    const currentMetadata = (userResponse.data.user?.user_metadata ?? {}) as Record<string, unknown>;
    const { error } = await client.auth.updateUser({
      password: password.trim(),
      data: {
        ...currentMetadata,
        password_change_required: false
      }
    });
    if (error) {
      setSaving(false);
      setMessage(error.message || "Aggiornamento password fallito.");
      return;
    }

    setSaving(false);
    setMessage("Password aggiornata correttamente. Ora puoi accedere con la nuova password.");
    setPassword("");
    setConfirmPassword("");
  };

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-10">
      <div className="mx-auto max-w-md rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_20px_60px_rgba(15,23,42,0.08)]">
        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Accesso</p>
          <h1 className="text-2xl font-semibold text-slate-950">Nuova password</h1>
          <p className="text-sm text-slate-600">{message}</p>
        </div>

        <form className="mt-6 space-y-4" onSubmit={onSubmit}>
          <label className="grid gap-1.5">
            <span className="text-sm font-medium text-slate-800">Nuova password</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="input-saas"
              placeholder="Minimo 8 caratteri"
              disabled={!ready || saving}
              required
            />
            <PasswordStrengthMeter password={password} />
          </label>

          <label className="grid gap-1.5">
            <span className="text-sm font-medium text-slate-800">Conferma password</span>
            <input
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              className="input-saas"
              placeholder="Ripeti la password"
              disabled={!ready || saving}
              required
            />
          </label>

          <button type="submit" className="btn-primary w-full justify-center" disabled={!ready || saving}>
            {saving ? "Salvataggio..." : "Salva nuova password"}
          </button>
        </form>

        <div className="mt-6 text-center text-sm text-slate-500">
          <Link href="/" className="font-medium text-slate-700 underline underline-offset-4">
            Torna al login
          </Link>
        </div>
      </div>
    </main>
  );
}
