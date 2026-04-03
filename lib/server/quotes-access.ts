import { NextResponse } from "next/server";
import type { PricingAuthContext } from "@/lib/server/pricing-auth";

export async function canAccessQuotes(auth: PricingAuthContext) {
  if (auth.membership.role === "admin") return true;
  if (auth.membership.role !== "operator") return false;

  const { data, error } = await auth.admin
    .from("tenant_user_feature_flags")
    .select("enabled")
    .eq("tenant_id", auth.membership.tenant_id)
    .eq("user_id", auth.user.id)
    .eq("feature_code", "quotes_access")
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data?.enabled === true;
}

export async function requireQuotesAccess(auth: PricingAuthContext) {
  const allowed = await canAccessQuotes(auth);
  if (allowed) return null;
  return NextResponse.json(
    { ok: false, error: "Accesso preventivi non abilitato per questo utente." },
    { status: 403 }
  );
}
