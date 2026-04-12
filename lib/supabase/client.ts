import { createClient } from "@supabase/supabase-js";

// strip() rimuove \r, \n, spazi e virgolette che Windows/.env possono iniettare
function strip(s: string | undefined) {
  return s?.trim().replace(/^["']|["']$/g, "");
}

const supabaseUrl = strip(process.env.NEXT_PUBLIC_SUPABASE_URL);
const supabaseAnonKey = strip(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

export const hasSupabaseEnv = Boolean(supabaseUrl && supabaseAnonKey);

export const supabase = hasSupabaseEnv
  ? createClient(supabaseUrl as string, supabaseAnonKey as string)
  : null;
