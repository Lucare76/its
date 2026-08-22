import { NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { auditLog } from "@/lib/server/ops-audit";

type AuthorizedPricingRequest = Exclude<Awaited<ReturnType<typeof authorizePricingRequest>>, NextResponse>;

export type ServiceSnapshot = Record<string, unknown> & { id: string; linked_service_id?: string | null };

export function compactServiceData(input: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function changedFields(before: ServiceSnapshot | null, after: ServiceSnapshot | null, fields: string[]) {
  if (!before || !after) return fields;
  return fields.filter((field) => JSON.stringify(before[field] ?? null) !== JSON.stringify(after[field] ?? null));
}

export async function getOperatorName(auth: AuthorizedPricingRequest) {
  const { data } = await auth.admin
    .from("memberships")
    .select("full_name")
    .eq("tenant_id", auth.membership.tenant_id)
    .eq("user_id", auth.user.id)
    .maybeSingle();
  return String(data?.full_name ?? auth.user.email ?? "Operatore").trim() || "Operatore";
}

export async function readServiceSnapshot(
  auth: AuthorizedPricingRequest,
  tenantId: string,
  serviceId: string
) {
  const { data } = await auth.admin
    .from("services")
    .select("*")
    .eq("id", serviceId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  return (data ?? null) as ServiceSnapshot | null;
}

export async function logServiceChange(input: {
  auth: AuthorizedPricingRequest;
  tenantId: string;
  serviceId: string;
  rootServiceId: string;
  before: ServiceSnapshot | null;
  after: ServiceSnapshot | null;
  fields: string[];
  action?: "CREATED" | "CANCELLED" | "updated";
  operatorName?: string;
}) {
  const fields = changedFields(input.before, input.after, input.fields);
  if (fields.length === 0) return;
  const operatorName = input.operatorName ?? await getOperatorName(input.auth);
  const { error } = await input.auth.admin.from("service_change_logs").insert({
    tenant_id: input.tenantId,
    service_id: input.serviceId,
    root_service_id: input.rootServiceId,
    action: input.action ?? "updated",
    changed_fields: fields,
    before_data: input.before ?? {},
    after_data: input.after ?? {},
    operator_user_id: input.auth.user.id,
    operator_name: operatorName,
    operator_email: input.auth.user.email
  });
  if (error) {
    auditLog({
      event: "service_change_log_failed",
      level: "warn",
      tenantId: input.tenantId,
      userId: input.auth.user.id,
      role: input.auth.membership.role,
      serviceId: input.serviceId,
      details: { message: error.message, action: input.action ?? "updated" }
    });
  }
}
