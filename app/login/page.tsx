"use client";

import { useEffect, useRef, useState } from "react";
import Script from "next/script";
import { AUTH_PERSISTENCE_KEY, hasSupabaseEnv, setAuthPersistence, supabase } from "@/lib/supabase/client";
import { PasswordStrengthMeter } from "@/components/password-strength-meter";

// Turnstile protects ONLY the "Richiedi accesso" (new agency registration)
// form below — never the normal password login or magic link, which must
// keep working exactly as before for day-to-day operator/agency use.
const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

declare global {
  interface Window {
    turnstile?: {
      render: (container: HTMLElement, options: Record<string, unknown>) => string;
      reset: (widgetId?: string) => void;
      remove: (widgetId?: string) => void;
    };
  }
}

function normalizeIdentifier(value: string) {
  return value.trim().toLowerCase();
}

function clearStoredSupabaseAuth() {
  if (typeof window === "undefined") return;
  for (const storage of [window.localStorage, window.sessionStorage]) {
    for (const key of Object.keys(storage)) {
      if (/^sb-.*-auth-token$/i.test(key)) storage.removeItem(key);
    }
    storage.removeItem(AUTH_PERSISTENCE_KEY);
    storage.removeItem("__it_e2e_session");
  }
}

export default function LoginPage() {
  const defaultLoginMessage = hasSupabaseEnv
    ? "Accesso riservato. Se hai credenziali attive, puoi entrare subito."
    : "Supabase non configurato: login non disponibile.";
  const [mode, setMode] = useState<"login" | "register" | "reset">("login");
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [agencyName, setAgencyName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string>(defaultLoginMessage);
  const [turnstileScriptLoaded, setTurnstileScriptLoaded] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileWidgetId, setTurnstileWidgetId] = useState<string | null>(null);
  const turnstileContainerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!hasSupabaseEnv || !supabase) {
      setMessage("Supabase non configurato: login non disponibile.");
      return;
    }
    const authClient = supabase;

    void authClient.auth.getSession().then(async ({ error }) => {
      if (!error) return;
      if (!/refresh token/i.test(error.message)) return;
      await authClient.auth.signOut().catch(() => undefined);
      clearStoredSupabaseAuth();
    });

    const searchParams = new URLSearchParams(window.location.search);
    const suspended = searchParams.get("suspended");
    if (suspended === "1") {
      setMessage("Accesso sospeso per questo tenant. Contatta un admin del tenant per riattivarti.");
      return;
    }
    // Persists the post-registration feedback across a refresh: no session,
    // no sensitive data in the URL, just a plain status flag. The real
    // authenticated pending/rejected state lives in /onboarding — this is
    // only the public-page acknowledgement for someone who isn't logged in.
    if (searchParams.get("request") === "received") {
      setMessage(
        "Richiesta inviata correttamente. ITS deve approvare il tuo accesso. Riceverai una comunicazione appena la richiesta sarà esaminata."
      );
      return;
    }
    setMessage(defaultLoginMessage);
  }, [defaultLoginMessage]);

  // Loads the widget only when the register tab is active — removed again
  // (which also clears its token) when leaving that tab or unmounting, so
  // the token is never held longer than the time needed to submit.
  useEffect(() => {
    if (mode !== "register" || !turnstileScriptLoaded || !TURNSTILE_SITE_KEY) return;
    if (!turnstileContainerRef.current || !window.turnstile) return;

    const widgetId = window.turnstile.render(turnstileContainerRef.current, {
      sitekey: TURNSTILE_SITE_KEY,
      callback: (token: string) => setTurnstileToken(token),
      "expired-callback": () => setTurnstileToken(null),
      "error-callback": () => setTurnstileToken(null)
    });
    setTurnstileWidgetId(widgetId);

    return () => {
      window.turnstile?.remove(widgetId);
      setTurnstileWidgetId(null);
      setTurnstileToken(null);
    };
  }, [mode, turnstileScriptLoaded]);

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
      const resolveResponse = await fetch("/api/auth/resolve-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: normalizeIdentifier(identifier) })
      });
      const resolveBody = (await resolveResponse.json().catch(() => null)) as { email?: string; error?: string } | null;
      if (!resolveResponse.ok || !resolveBody?.email) {
        setMessage(resolveBody?.error ?? "Login non riuscito: username o email non validi.");
        return;
      }

      setAuthPersistence(rememberMe ? "local" : "session");
      const { error } = await supabase.auth.signInWithPassword({ email: resolveBody.email, password });
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
        email: normalizeIdentifier(identifier),
        options: { emailRedirectTo, shouldCreateUser: false }
      });
      if (error) {
        setMessage(`Invio link non riuscito: ${error.message}`);
        return;
      }
      setMessage(`Link inviato a ${identifier}. Apri la mail e completa l'accesso.`);
    } catch (error) {
      setMessage(error instanceof Error ? `Errore invio link: ${error.message}` : "Errore invio link inatteso.");
    } finally {
      setLoading(false);
    }
  };

  const handleResetPassword = async () => {
    if (loading) return;
    setLoading(true);
    setMessage("Invio link di reset...");
    try {
      const response = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: normalizeIdentifier(identifier) })
      });
      const body = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
      if (!response.ok) {
        setMessage(body?.error ?? "Richiesta reset non riuscita.");
        return;
      }
      setMessage(body?.message ?? "Se l'account esiste, abbiamo inviato un link di reset. Controlla la casella.");
      setMode("login");
    } catch (error) {
      setMessage(error instanceof Error ? `Errore reset: ${error.message}` : "Errore reset inatteso.");
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async () => {
    if (loading) return;
    if (!TURNSTILE_SITE_KEY) {
      // Fail closed on the client too — mirrors the server, which treats a
      // missing secret as verification failure rather than bypassing it.
      setMessage("Verifica di sicurezza non disponibile. Contatta l'amministratore.");
      return;
    }
    if (!turnstileToken) {
      setMessage("Completa la verifica di sicurezza prima di inviare la richiesta.");
      return;
    }

    setLoading(true);
    setMessage("Invio richiesta accesso...");
    try {
      const response = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agency_name: agencyName,
          full_name: fullName,
          email: normalizeIdentifier(identifier),
          password,
          requested_role: "agency",
          turnstile_token: turnstileToken
        })
      });
      const body = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
      if (!response.ok) {
        setMessage(body?.error ?? "Richiesta accesso non inviata.");
        return;
      }
      setFullName("");
      setAgencyName("");
      setIdentifier("");
      setPassword("");
      setMode("login");
      // Query param (no email/password/token/user id) so the acknowledgement
      // survives a refresh without a new page — see the mount effect above.
      window.history.replaceState(null, "", "/login?request=received");
      setMessage(
        "Richiesta inviata correttamente. ITS deve approvare il tuo accesso. Riceverai una comunicazione appena la richiesta sarà esaminata."
      );
    } catch (error) {
      setMessage(error instanceof Error ? `Errore registrazione: ${error.message}` : "Errore registrazione inatteso.");
    } finally {
      // Turnstile tokens are single-use — always reset after a submit
      // attempt (success or failure) rather than trying to reuse it.
      if (turnstileWidgetId) window.turnstile?.reset(turnstileWidgetId);
      setTurnstileToken(null);
      setLoading(false);
    }
  };

  return (
    <>
      {TURNSTILE_SITE_KEY ? (
        <Script
          src="https://challenges.cloudflare.com/turnstile/v0/api.js"
          strategy="lazyOnload"
          onLoad={() => setTurnstileScriptLoaded(true)}
        />
      ) : null}
      <section className="min-h-screen bg-[radial-gradient(circle_at_top_left,#dff8f4_0,#f6f8fb_34%,#eef3f8_100%)] px-4 py-6 sm:px-6 lg:px-10">
        <div className="mx-auto grid min-h-[calc(100vh-48px)] max-w-6xl overflow-hidden rounded-[28px] border border-white/70 bg-white shadow-2xl shadow-slate-200/70 lg:grid-cols-[1.05fr_0.95fr]">
          <div className="relative flex min-h-[360px] flex-col justify-between overflow-hidden bg-slate-950 p-8 text-white sm:p-10">
            <div className="absolute inset-0 bg-[linear-gradient(145deg,rgba(20,184,166,0.34),rgba(79,70,229,0.18)_44%,rgba(2,6,23,0.94))]" />
            <div className="absolute -right-20 top-14 h-64 w-64 rounded-full border border-white/10" />
            <div className="absolute -bottom-24 left-16 h-72 w-72 rounded-full border border-cyan-200/10" />
            <div className="relative">
              <div className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-3 py-1 text-xs font-bold uppercase tracking-[0.22em] text-cyan-100">
                Ischia Transfer Service
              </div>
              <div className="mt-10">
                <p className="text-sm font-semibold uppercase tracking-[0.42em] text-cyan-200">Area operativa</p>
                <h1 className="mt-3 text-5xl font-black tracking-[0.16em] text-white sm:text-6xl">AURIS</h1>
                <p className="mt-3 text-xl font-semibold text-cyan-50">Qualcosa in piu</p>
                <p className="mt-5 max-w-md text-sm leading-6 text-slate-200">
                  Coordinamento rapido per transfer, bus, gruppi esclusivi, hotel, porto e aeroporto in un&apos;unica cabina operativa.
                </p>
              </div>
            </div>
            <div className="relative grid gap-3 text-sm sm:grid-cols-3">
              <div className="rounded-2xl border border-white/10 bg-white/10 p-4">
                <p className="text-2xl font-black text-white">Live</p>
                <p className="mt-1 text-xs text-slate-300">planning e linee bus</p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/10 p-4">
                <p className="text-2xl font-black text-white">Multi</p>
                <p className="mt-1 text-xs text-slate-300">tenant e ruoli</p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/10 p-4">
                <p className="text-2xl font-black text-white">Ops</p>
                <p className="mt-1 text-xs text-slate-300">arrivi e partenze</p>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-center p-5 sm:p-8 lg:p-10">
            <div className="w-full max-w-md">
              <div className="mb-7">
                <p className="text-xs font-black uppercase tracking-[0.28em] text-teal-600">Accesso riservato</p>
                <h2 className="mt-2 text-3xl font-black text-slate-950">
                  {mode === "login" ? "Bentornato" : mode === "register" ? "Richiedi accesso" : "Recupera password"}
                </h2>
                <p className="mt-2 text-sm leading-6 text-slate-500">
                  {mode === "login"
                    ? "Entra nel pannello AURIS per gestire l'operativita giornaliera."
                    : mode === "register"
                    ? "Invia i dati della tua agenzia: il team verifichera la richiesta."
                    : "Ricevi un link sicuro per impostare una nuova password."}
                </p>
              </div>

              <div className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-xl shadow-slate-200/60 sm:p-5">
                <div className="grid grid-cols-3 gap-2 rounded-2xl bg-slate-100 p-1">
                  <button type="button" onClick={() => setMode("login")} className={mode === "login" ? "rounded-xl bg-slate-950 px-3 py-2 text-xs font-bold text-white shadow-sm" : "rounded-xl px-3 py-2 text-xs font-bold text-slate-500 hover:bg-white"}>
                    Login
                  </button>
                  <button type="button" onClick={() => setMode("register")} className={mode === "register" ? "rounded-xl bg-slate-950 px-3 py-2 text-xs font-bold text-white shadow-sm" : "rounded-xl px-3 py-2 text-xs font-bold text-slate-500 hover:bg-white"}>
                    Accesso
                  </button>
                  <button type="button" onClick={() => setMode("reset")} className={mode === "reset" ? "rounded-xl bg-slate-950 px-3 py-2 text-xs font-bold text-white shadow-sm" : "rounded-xl px-3 py-2 text-xs font-bold text-slate-500 hover:bg-white"}>
                    Reset
                  </button>
                </div>
        {mode === "register" ? (
          <>
            <label className="block text-sm">
              Nome completo
              <input className="input-saas mt-1" value={fullName} onChange={(event) => setFullName(event.target.value)} placeholder="Mario Rossi" autoCapitalize="words" />
            </label>
            <label className="block text-sm">
              Nome agenzia
              <input className="input-saas mt-1" value={agencyName} onChange={(event) => setAgencyName(event.target.value)} placeholder="Nome della tua agenzia" autoCapitalize="words" />
            </label>
            <label className="block text-sm">
              Ruolo richiesto
              <input className="input-saas mt-1" value="Agenzia" disabled />
            </label>
          </>
        ) : null}
        {mode === "register" ? (
          <div className="pt-1">
            {TURNSTILE_SITE_KEY ? (
              <div ref={turnstileContainerRef} />
            ) : (
              <p className="text-xs text-amber-600">
                Turnstile non configurato in locale (manca NEXT_PUBLIC_TURNSTILE_SITE_KEY): la registrazione resta bloccata finché non lo imposti nel tuo .env.
              </p>
            )}
          </div>
        ) : null}
        <label className="block text-sm">
          {mode === "login" ? "Email o username" : "Email"}
          <input
            data-testid="login-email"
            className="input-saas mt-1"
            type={mode === "login" ? "text" : "email"}
            value={identifier}
            onChange={(event) => setIdentifier(normalizeIdentifier(event.target.value))}
            placeholder={mode === "login" ? "Inserisci email o username" : "Inserisci la tua email"}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            name="username"
            autoComplete={mode === "login" ? "username" : "email"}
            data-no-uppercase
          />
        </label>
        {mode !== "reset" ? (
          <label className="block text-sm">
            Password
            <div className="mt-1 flex rounded-xl border border-slate-200 bg-white focus-within:border-slate-400">
              <input
                data-testid="login-password"
                className="min-w-0 flex-1 rounded-l-xl border-0 bg-transparent px-3 py-2 text-sm outline-none"
                data-no-uppercase
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Inserisci la password"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                name="password"
                autoComplete={mode === "register" ? "new-password" : "current-password"}
              />
              <button
                type="button"
                onClick={() => setShowPassword((prev) => !prev)}
                className="shrink-0 rounded-r-xl border-l border-slate-200 px-3 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                aria-label={showPassword ? "Nascondi password" : "Mostra password"}
              >
                {showPassword ? "Nascondi" : "Mostra"}
              </button>
            </div>
            {mode === "register" && <PasswordStrengthMeter password={password} />}
          </label>
        ) : null}
        {mode === "login" ? (
          <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={rememberMe}
              onChange={(event) => setRememberMe(event.target.checked)}
              className="h-4 w-4 accent-violet-600"
            />
            <span>
              <span className="block font-semibold">Resta collegato</span>
              <span className="block text-xs text-slate-500">Mantieni l&apos;accesso anche dopo aver chiuso il browser.</span>
            </span>
          </label>
        ) : null}
        <button
          data-testid="login-submit"
          type="button"
          onClick={mode === "login" ? handleSignIn : mode === "register" ? handleRegister : handleResetPassword}
          disabled={loading || (mode === "register" && (!TURNSTILE_SITE_KEY || !turnstileToken))}
          className="w-full rounded-2xl bg-gradient-to-r from-teal-500 to-indigo-600 px-4 py-3 text-sm font-black text-white shadow-lg shadow-indigo-200 transition hover:from-teal-400 hover:to-indigo-500 disabled:opacity-60"
        >
          {loading
            ? "Elaborazione..."
            : mode === "login"
            ? "Accedi all'area riservata"
            : mode === "register"
            ? "Invia richiesta accesso"
            : "Invia link di reset"}
        </button>
        {mode === "login" ? (
          <button type="button" onClick={handleMagicLink} disabled={loading} className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-700 transition hover:bg-slate-50 disabled:opacity-60">
            Invia link magico via email
          </button>
        ) : null}
        {mode === "reset" ? (
          <p className="text-xs text-blue-700">Se l&apos;account esiste, riceverai un link per scegliere una nuova password. Controlla anche la cartella spam.</p>
        ) : null}
        <p data-testid="login-message" className="text-sm text-slate-600">{message}</p>
        <p className="text-xs text-slate-500">Riceverai una risposta o un link di accesso in breve tempo, quando previsto.</p>
              </div>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
