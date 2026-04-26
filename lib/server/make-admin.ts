/**
 * Utility condivisa per creare il client Supabase service-role e autorizzare
 * le route che richiedono ruolo admin/operator senza dipendere da pricing-auth.
 *
 * Uso:
 *   const ctx = await authorizeAdmin(request);
 *   if (!ctx) return NextResponse.json({ error: "Non autorizzato." }, { status: 403 });
 *   const { admin, tenantId } = ctx;
 */
import { NextRequest } from "next/server";
import { authorizeServiceRoleRequest } from "@/lib/server/pricing-auth";
import { type SupabaseClient } from "@supabase/supabase-js";

export type AdminContext = {
  admin: SupabaseClient;
  tenantId: string;
};

export async function authorizeAdmin(
  request: NextRequest,
  roles: string[] = ["admin"],
): Promise<AdminContext | null> {
  const ctx = await authorizeServiceRoleRequest(request, { roles });
  if (ctx instanceof Response) return null;
  return { admin: ctx.admin, tenantId: ctx.membership.tenant_id };
}
