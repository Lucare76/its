import { createClient } from "@supabase/supabase-js";

// strip() rimuove \r, \n, spazi e virgolette che Windows/.env possono iniettare
function strip(s: string | undefined) {
  return s?.trim().replace(/^["']|["']$/g, "");
}

const forceE2ESmokeAuthFallback = process.env.NEXT_PUBLIC_E2E_FORCE_LOGIN_SMOKE === "true";
const supabaseUrl = strip(process.env.NEXT_PUBLIC_SUPABASE_URL);
const supabaseAnonKey = strip(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

export const hasSupabaseEnv = !forceE2ESmokeAuthFallback && Boolean(supabaseUrl && supabaseAnonKey);

export const supabase = hasSupabaseEnv
  ? createClient(supabaseUrl as string, supabaseAnonKey as string)
  : null;

export async function getToken(): Promise<string | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}
