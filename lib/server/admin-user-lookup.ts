/**
 * Lookup a Supabase auth user by email using the admin REST API.
 * The JS client v2 has no getUserByEmail() — this is the correct workaround.
 */
export type AdminAuthUser = {
  id: string;
  email: string;
  user_metadata?: Record<string, unknown>;
};

export async function adminGetUserByEmail(email: string): Promise<{
  user: AdminAuthUser | null;
  error: string | null;
}> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/^["']|["']$/g, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim().replace(/^["']|["']$/g, "");
  if (!url || !key) return { user: null, error: "Configurazione server mancante" };

  const resp = await fetch(
    `${url}/auth/v1/admin/users?filter=${encodeURIComponent(email)}`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } }
  );
  if (!resp.ok) return { user: null, error: `HTTP ${resp.status}` };

  const { users } = (await resp.json()) as { users: AdminAuthUser[] };
  const user = users?.find((u) => u.email?.toLowerCase() === email.toLowerCase()) ?? null;
  return { user, error: null };
}
