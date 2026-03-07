"use client";

import { useEffect, useState } from "react";
import { ROLE_COOKIE } from "@/lib/rbac";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";
import { roleSchema } from "@/lib/validation";
import type { UserRole } from "@/lib/types";

const demoAccounts = [
  { role: "admin", email: "admin@demo.com" },
  { role: "operator", email: "operator@demo.com" },
  { role: "agency", email: "agency@demo.com" },
  { role: "driver", email: "driver@demo.com" }
] as const;

export default function LoginPage() {
  const [email, setEmail] = useState("operator@demo.com");
  const [role, setRole] = useState<UserRole>("operator");
  const [password, setPassword] = useState("");
  const [forceDemoMode, setForceDemoMode] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("it-force-demo-login") === "true";
  });
  const [message, setMessage] = useState<string>("");

  useEffect(() => {
    window.localStorage.setItem("it-force-demo-login", String(forceDemoMode));
  }, [forceDemoMode]);

  const setRoleCookie = (nextRole: UserRole) => {
    const secure = typeof window !== "undefined" && window.location.protocol === "https:";
    document.cookie = `${ROLE_COOKIE}=${nextRole}; path=/; max-age=86400; samesite=lax${secure ? "; secure" : ""}`;
  };

  const hardRedirect = (target: string) => {
    window.location.assign(target);
  };

  const handleSignIn = async () => {
    setMessage("Caricamento...");
    const redirectTarget = new URLSearchParams(window.location.search).get("redirect") ?? "/dashboard";
    if (forceDemoMode || !hasSupabaseEnv || !supabase) {
      setRoleCookie(role);
      setMessage("Accesso demo locale attivo.");
      hardRedirect(redirectTarget);
      return;
    }
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setMessage(error.message);
      return;
    }
    setRoleCookie(role);
    hardRedirect(redirectTarget);
  };

  return (
    <section className="mx-auto max-w-lg space-y-4">
      <h1 className="text-2xl font-semibold">Login Supabase</h1>
      <div className="card space-y-3 p-4">
        <label className="block text-sm">
          Email
          <input
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <label className="block text-sm">
          Ruolo demo
          <select
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
            value={role}
            onChange={(event) => setRole(roleSchema.parse(event.target.value))}
          >
            <option value="admin">admin</option>
            <option value="operator">operator</option>
            <option value="agency">agency</option>
            <option value="driver">driver</option>
          </select>
        </label>
        <label className="block text-sm">
          Password
          <input
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={forceDemoMode}
            onChange={(event) => setForceDemoMode(event.target.checked)}
          />
          Forza demo locale (bypass Supabase)
        </label>
        <button
          type="button"
          onClick={handleSignIn}
          className="w-full rounded-lg bg-brand-600 px-4 py-2 font-medium text-white"
        >
          Accedi
        </button>
        <p className="text-sm text-slate-600">{message || "Usa gli account demo dal seed SQL."}</p>
      </div>
      <div className="card p-4 text-sm">
        <p className="font-medium text-slate-700">Account demo</p>
        <ul className="mt-2 space-y-1 text-slate-600">
          {demoAccounts.map((item) => (
            <li key={item.email}>
              {roleSchema.parse(item.role)}: {item.email}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
