import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";

function supabaseUrl(): string {
  // Con `supabase start`, imposta INTEGRATION_SUPABASE_URL=http://127.0.0.1:54321
  return process.env.INTEGRATION_SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL!;
}

export function makeAdminClient(): SupabaseClient {
  const key =
    process.env.INTEGRATION_SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(supabaseUrl(), key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function makeAnonClient(): SupabaseClient {
  const key =
    process.env.INTEGRATION_SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  return createClient(supabaseUrl(), key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Costruisce un NextRequest pronto per essere passato direttamente a un route handler. */
export function makeNextRequest(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  body: unknown,
  token: string,
  url = "http://localhost:3010/api/test",
): NextRequest {
  return new NextRequest(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

/** Legge e tipa il corpo JSON di una NextResponse. */
export async function json<T = Record<string, unknown>>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}
