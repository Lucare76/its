"use client";

import { useEffect, useState } from "react";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";
import { PasswordStrengthMeter } from "@/components/password-strength-meter";

export default function LoginPage() {
  const defaultLoginMessage = hasSupabaseEnv
    ? "Accesso riservato. Se hai credenziali attive, puoi entrare subito."
    : "Supabase non configurato: login non disponibile.";
  const [mode, setMode] = useState<"login" | "register" | "reset">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [agencyName, setAgencyName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string>(defaultLoginMessage);

  useEffect(() => {
    if (!hasSupabaseEnv || !supabase) {
      setMessage("Supabase non configurato: login non disponibile.");
      return;
    }
    const suspended = new URLSearchParams(window.location.search).get("suspended");
    if (suspended === "1") {
      setMessage("Accesso sospeso per questo tenant. Contatta un admin del tenant per riattivarti.");
      return;
    }
    setMessage(defaultLoginMessage);
  }, [defaultLoginMessage]);

  const hardRedirect = (target: string) => {
    window.location.assign(target);
  };

  const ensureSessionReady = async () => {
    if (!supabase) return false;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const [{ data: sessionData }, { data: userData }] = await Promise.all([supabase.auth.getSession(), supabase.auth.getUser()]);
      if (sessionData.session && userData.user) {
        return true;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 120));
    }
    return false;
  };

  const handleSignIn = async () => {
    if (loading) return;
    setLoading(true);
    setMessage("Caricamento...");
    const redirectTarget = new URLSearchParams(window.location.search).get("redirect") ?? "/dashboard";
    try {
      if (!hasSupabaseEnv || !supabase) {
        setMessage("Supabase non configurato: login non disponibile.");
        return;
      }
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        setMessage(`Login non riuscito: ${error.message}`);
        return;
      }
      const sessionReady = await ensureSessionReady();
      if (!sessionReady) {
        setMessage("Login completato ma sessione client non ancora pronta. Riprova tra pochi secondi.");
        return;
      }
      hardRedirect(redirectTarget);
    } catch (error) {
      setMessage(error instanceof Error ? `Errore login: ${error.message}` : "Errore login inatteso.");
    } finally {
      setLoading(false);
    }
  };

  const handleMagicLink = async () => {
    if (loading) return;
    setLoading(true);
    setMessage("Invio link magico...");
    try {
      if (!hasSupabaseEnv || !supabase) {
        setMessage("Supabase non configurato: impossibile inviare il link.");
        return;
      }
      const emailRedirectTo = `${window.location.origin}/dashboard`;
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo }
      });
      if (error) {
        setMessage(`Invio link non riuscito: ${error.message}`);
        return;
      }
      setMessage(`Link inviato a ${email}. Apri la mail e completa l'accesso.`);
    } catch (error) {
      setMessage(error instanceof Error ? `Errore invio link: ${error.message}` : "Errore invio link inatteso.");
    } finally {
      setLoading(false);
    }
  };

  const handleResetPassword = async () => {
    if (loading) return;
    setLoading(true);
    setMessage("Invio password temporanea...");
    try {
      const response = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email })
      });
      const body = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
      if (!response.ok) {
        setMessage(body?.error ?? "Richiesta reset non riuscita.");
        return;
      }
      setMessage(body?.message ?? "Email inviata con password temporanea. Controlla la casella.");
      setMode("login");
    } catch (error) {
      setMessage(error instanceof Error ? `Errore reset: ${error.message}` : "Errore reset inatteso.");
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async () => {
    if (loading) return;
    setLoading(true);
    setMessage("Invio richiesta accesso...");
    try {
      const response = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agency_name: agencyName,
          full_name: fullName,
          email,
          password,
          requested_role: "agency"
        })
      });
      const body = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
      if (!response.ok) {
        setMessage(body?.error ?? "Richiesta accesso non inviata.");
        return;
      }
      setMessage(body?.message ?? "Richiesta accesso inviata. Un admin la vedra nella coda di approvazione.");
      setFullName("");
      setAgencyName("");
      setEmail("");
      setPassword("");
      setMode("login");
    } catch (error) {
      setMessage(error instanceof Error ? `Errore registrazione: ${error.message}` : "Errore registrazione inatteso.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="mx-auto max-w-lg page-section">
      <h1 className="section-title">Login Supabase</h1>
      <div className="card space-y-3 p-4">
        <p className="text-sm leading-6 text-slate-600">
          Ischia Transfer Service e attivo dal 2006. L&apos;area riservata consente al team di coordinare con rapidita i
          transfer tra aeroporto, porto e hotel.
        </p>
        <div className="flex gap-2">
          <button type="button" onClick={() => setMode("login")} className={mode === "login" ? "btn-primary flex-1" : "btn-secondary flex-1"}>
            Login
          </button>
          <button type="button" onClick={() => setMode("register")} className={mode === "register" ? "btn-primary flex-1" : "btn-secondary flex-1"}>
            Richiedi accesso
          </button>
          <button type="button" onClick={() => setMode("reset")} className={mode === "reset" ? "btn-primary flex-1" : "btn-secondary flex-1"}>
            Reset password
          </button>
        </div>
        {mode === "register" ? (
          <>
            <label className="block text-sm">
              Nome completo
              <input className="input-saas mt-1" value={fullName} onChange={(event) => setFullName(event.target.value)} placeholder="Mario Rossi" />
            </label>
            <label className="block text-sm">
              Nome agenzia
              <input className="input-saas mt-1" value={agencyName} onChange={(event) => setAgencyName(event.target.value)} placeholder="Nome della tua agenzia" />
            </label>
            <label className="block text-sm">
              Ruolo richiesto
              <input className="input-saas mt-1" value="Agenzia" disabled />
            </label>
          </>
        ) : null}
        <label className="block text-sm">
          Email
          <input
            data-testid="login-email"
            className="input-saas mt-1"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="Inserisci la tua email"
          />
        </label>
        {mode !== "reset" ? (
          <label className="block text-sm">
            Password
            <div className="relative mt-1">
              <input
                data-testid="login-password"
                className="input-saas pr-20"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Inserisci la password"
              />
              <button
                type="button"
                onClick={() => setShowPassword((prev) => !prev)}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100"
                aria-label={showPassword ? "Nascondi password" : "Mostra password"}
              >
                {showPassword ? "Nascondi" : "Mostra"}
              </button>
            </div>
            {mode === "register" && <PasswordStrengthMeter password={password} />}
          </label>
        ) : null}
        <button
          data-testid="login-submit"
          type="button"
          onClick={mode === "login" ? handleSignIn : mode === "register" ? handleRegister : handleResetPassword}
          disabled={loading}
          className="btn-primary w-full disabled:opacity-60"
        >
          {loading
            ? "Elaborazione..."
            : mode === "login"
            ? "Accedi all'area riservata"
            : mode === "register"
            ? "Invia richiesta accesso"
            : "Invia password temporanea"}
        </button>
        {mode === "login" ? (
          <button type="button" onClick={handleMagicLink} disabled={loading} className="btn-secondary w-full disabled:opacity-60">
            Invia link magico via email
          </button>
        ) : null}
        {mode === "reset" ? (
          <p className="text-xs text-blue-700">Abbiamo generato una password temporanea se l'account esiste. Controlla la tua casella email (anche spam). Il codice scade in 30 minuti.</p>
        ) : null}
        <p data-testid="login-message" className="text-sm text-slate-600">{message}</p>
        <p className="text-xs text-slate-500">Riceverai una risposta o un link di accesso in breve tempo, quando previsto.</p>
      </div>
    </section>
  );
}
