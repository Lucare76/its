"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";

export default function ChangePasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (password.length < 8) {
      setError("La password deve essere di almeno 8 caratteri.");
      return;
    }
    if (password !== confirm) {
      setError("Le password non coincidono.");
      return;
    }

    setSaving(true);
    try {
      if (!supabase) {
        setError("Errore di configurazione.");
        return;
      }

      const userResponse = await supabase.auth.getUser();
      const currentMetadata = (userResponse.data.user?.user_metadata ?? {}) as Record<string, unknown>;
      const { error: updateErr } = await supabase.auth.updateUser({
        password,
        data: {
          ...currentMetadata,
          force_password_change: false,
          password_change_required: false
        }
      });

      if (updateErr) {
        setError(updateErr.message);
        return;
      }

      router.replace("/driver");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-900 p-4">
      <div className="w-full max-w-sm space-y-6 rounded-2xl bg-white p-8 shadow-2xl">
        <div className="text-center">
          <div className="mb-2 text-3xl">Reset</div>
          <h1 className="text-xl font-bold text-slate-900">Imposta la tua password</h1>
          <p className="mt-1 text-sm text-slate-500">
            Al primo accesso e richiesto impostare una password personale.
          </p>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">
              Nuova password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Almeno 8 caratteri"
              required
              className="w-full rounded-xl border border-slate-200 px-4 py-3 text-base focus:border-indigo-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">
              Conferma password
            </label>
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Ripeti la password"
              required
              className="w-full rounded-xl border border-slate-200 px-4 py-3 text-base focus:border-indigo-500 focus:outline-none"
            />
          </div>

          {error ? (
            <p className="rounded-lg bg-rose-50 px-4 py-2 text-sm text-rose-700">{error}</p>
          ) : null}

          <button
            type="submit"
            disabled={saving || !password || !confirm}
            className="w-full rounded-xl bg-indigo-600 py-3 text-base font-semibold text-white hover:bg-indigo-700 disabled:opacity-40"
          >
            {saving ? "Salvataggio..." : "Salva e accedi"}
          </button>
        </form>
      </div>
    </div>
  );
}
