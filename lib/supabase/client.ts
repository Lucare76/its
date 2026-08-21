import { createClient } from "@supabase/supabase-js";

export const AUTH_PERSISTENCE_KEY = "it-auth-persistence";

type AuthPersistence = "local" | "session";

function authTokenKeys(storage: Storage) {
  return Object.keys(storage).filter((key) => /^sb-.*-auth-token$/i.test(key));
}

function preferredAuthStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  if (window.sessionStorage.getItem(AUTH_PERSISTENCE_KEY) === "session") return window.sessionStorage;
  if (window.localStorage.getItem(AUTH_PERSISTENCE_KEY) === "local") return window.localStorage;
  if (authTokenKeys(window.sessionStorage).length > 0) return window.sessionStorage;
  return window.localStorage;
}

const adaptiveAuthStorage = {
  getItem(key: string) {
    if (typeof window === "undefined") return null;
    const preferred = preferredAuthStorage();
    const fallback = preferred === window.sessionStorage ? window.localStorage : window.sessionStorage;
    return preferred?.getItem(key) ?? fallback.getItem(key);
  },
  setItem(key: string, value: string) {
    if (typeof window === "undefined") return;
    const preferred = preferredAuthStorage() ?? window.localStorage;
    const fallback = preferred === window.sessionStorage ? window.localStorage : window.sessionStorage;
    preferred.setItem(key, value);
    fallback.removeItem(key);
  },
  removeItem(key: string) {
    if (typeof window === "undefined") return;
    window.localStorage.removeItem(key);
    window.sessionStorage.removeItem(key);
  },
};

export function setAuthPersistence(mode: AuthPersistence) {
  if (typeof window === "undefined") return;
  const persistent = mode === "local";
  window.localStorage.removeItem(AUTH_PERSISTENCE_KEY);
  window.sessionStorage.removeItem(AUTH_PERSISTENCE_KEY);
  (persistent ? window.localStorage : window.sessionStorage).setItem(AUTH_PERSISTENCE_KEY, mode);

  const destination = persistent ? window.localStorage : window.sessionStorage;
  const source = persistent ? window.sessionStorage : window.localStorage;
  for (const key of authTokenKeys(source)) {
    const value = source.getItem(key);
    if (value) destination.setItem(key, value);
    source.removeItem(key);
  }
}

export function hasStoredAuthSession() {
  if (typeof window === "undefined") return false;
  return authTokenKeys(window.localStorage).length > 0 || authTokenKeys(window.sessionStorage).length > 0;
}

// strip() rimuove \r, \n, spazi e virgolette che Windows/.env possono iniettare
function strip(s: string | undefined) {
  return s?.trim().replace(/^["']|["']$/g, "");
}

const forceE2ESmokeAuthFallback = process.env.NEXT_PUBLIC_E2E_FORCE_LOGIN_SMOKE === "true";
const supabaseUrl = strip(process.env.NEXT_PUBLIC_SUPABASE_URL);
const supabaseAnonKey = strip(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

export const hasSupabaseEnv = !forceE2ESmokeAuthFallback && Boolean(supabaseUrl && supabaseAnonKey);

export const supabase = hasSupabaseEnv
  ? createClient(supabaseUrl as string, supabaseAnonKey as string, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storage: adaptiveAuthStorage,
      },
    })
  : null;

export async function getToken(): Promise<string | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}
