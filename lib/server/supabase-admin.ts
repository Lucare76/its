/**
 * Crea il client Supabase con service role per l'uso server-side.
 * Stripping di virgolette e whitespace per compatibilità con .env Windows.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

function stripEnv(key: string): string | undefined {
  return process.env[key]?.trim().replace(/^["']|["']$/g, "");
}

export function getSupabaseUrl(): string {
  const url = stripEnv("NEXT_PUBLIC_SUPABASE_URL");
  if (!url) throw new Error("NEXT_PUBLIC_SUPABASE_URL non configurata");
  return url;
}

export function createAdminClient(): SupabaseClient {
  const url = stripEnv("NEXT_PUBLIC_SUPABASE_URL");
  const key = stripEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Variabili Supabase mancanti (URL o SERVICE_ROLE_KEY)");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
