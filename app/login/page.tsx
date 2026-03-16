"use client";

import { useEffect, useState } from "react";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string>("Accesso riservato. Se hai credenziali attive, puoi entrare subito.");

  useEffect(() => {
    if (!hasSupabaseEnv || !supabase) {
      setMessage("Supabase non configurato: imposta le variabili ambiente prima del login.");
      return;
    }
  }, []);

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

  return (
    <section className="mx-auto max-w-lg page-section">
      <h1 className="section-title">Login Supabase</h1>
      <div className="card space-y-3 p-4">
        <p className="text-sm leading-6 text-slate-600">
          Ischia Transfer Service e attivo dal 2006. L&apos;area riservata consente al team di coordinare con rapidita i
          transfer tra aeroporto, porto e hotel.
        </p>
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
        </label>
        <button
          data-testid="login-submit"
          type="button"
          onClick={handleSignIn}
          disabled={loading}
          className="btn-primary w-full disabled:opacity-60"
        >
          {loading ? "Verifica accesso..." : "Accedi all'area riservata"}
        </button>
        <button type="button" onClick={handleMagicLink} disabled={loading} className="btn-secondary w-full disabled:opacity-60">
          Invia link magico via email
        </button>
        <p className="text-sm text-slate-600">{message}</p>
        <p className="text-xs text-slate-500">Riceverai una risposta o un link di accesso in breve tempo, quando previsto.</p>
      </div>
    </section>
  );
}
