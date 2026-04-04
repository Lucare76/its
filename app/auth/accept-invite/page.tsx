"use client";

import { useSearchParams, useRouter } from "next/navigation";
import { FormEvent, useEffect, useState, Suspense } from "react";
import { PasswordStrengthMeter } from "@/components/password-strength-meter";

function AcceptInviteForm() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const token = searchParams.get("token") || "";

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("Caricamento...");
  const [validToken, setValidToken] = useState(!token);

  useEffect(() => {
    if (!token) {
      setMessage("Token invito non fornito.");
      return;
    }
    setMessage("Pronto per accettare l'invito. Imposta una password.");
    setValidToken(true);
  }, [token]);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving || !validToken) return;

    if (password.trim().length < 8) {
      setMessage("La password deve avere almeno 8 caratteri.");
      return;
    }
    if (password !== confirmPassword) {
      setMessage("Le password non coincidono.");
      return;
    }

    setSaving(true);
    setMessage("Creazione account in corso...");

    try {
      const response = await fetch("/api/auth/accept-invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password: password.trim() })
      });

      const body = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
      if (!response.ok) {
        setMessage(body?.error ?? "Errore accettazione invito");
        setSaving(false);
        return;
      }

      setMessage("Account creato! Reindirizzamento al login...");
      setTimeout(() => {
        router.push("/login");
      }, 2000);
    } catch (error) {
      setMessage(error instanceof Error ? `Errore: ${error.message}` : "Errore inatteso");
      setSaving(false);
    }
  };

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-10">
      <div className="mx-auto max-w-md rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_20px_60px_rgba(15,23,42,0.08)]">
        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Invito</p>
          <h1 className="text-2xl font-semibold text-slate-950">Crea il tuo account</h1>
          <p className="text-sm text-slate-600">{message}</p>
        </div>

        {validToken && (
          <form className="mt-6 space-y-4" onSubmit={onSubmit}>
            <label className="grid gap-1.5">
              <span className="text-sm font-medium text-slate-800">Password</span>
              <div className="relative mt-1">
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="input-saas pr-20"
                  placeholder="Minimo 8 caratteri"
                  disabled={saving}
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((prev) => !prev)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100"
                  aria-label={showPassword ? "Nascondi" : "Mostra"}
                >
                  {showPassword ? "Nascondi" : "Mostra"}
                </button>
              </div>
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
                disabled={saving}
                required
              />
            </label>

            <button
              type="submit"
              className="btn-primary w-full justify-center"
              disabled={saving}
            >
              {saving ? "Creazione..." : "Crea account"}
            </button>
          </form>
        )}

        <div className="mt-6 text-center text-sm text-slate-500">
          <p>Hai la tua password? <a href="/login" className="font-medium text-slate-700 underline underline-offset-4">Accedi direttamente</a></p>
        </div>
      </div>
    </main>
  );
}

export default function AcceptInvitePage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-slate-50" />}>
      <AcceptInviteForm />
    </Suspense>
  );
}
