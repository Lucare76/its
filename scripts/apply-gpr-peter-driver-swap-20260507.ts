import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import {
  buildGprPeterDriverSwapPreview,
  GPR_PETER_DRIVER_SWAP_ACTION,
  GPR_PETER_DRIVER_SWAP_DECISION_TYPE,
  GPR_PETER_EXPECTED_DATE,
  GPR_PETER_GROUP_ID,
  validateGprPeterDriverSwapPreviewForApply,
} from "@/lib/server/piano-driver-swap-preview";
import { buildVehicleBindingPreview } from "@/lib/server/piano-vehicle-binding-preview";
import { insertOperatorDecision, loadConfirmedOperatorDecisions, type PianoOperatorDecisionRow } from "@/lib/server/piano-operator-decisions";
import type { PricingAuthContext } from "@/lib/server/pricing-auth";

type TenantOption = {
  id: string | null;
  name: string | null;
};

type OperatorOption = {
  user_id: string | null;
  role: string | null;
  full_name: string | null;
  suspended: boolean | null;
};

function loadEnv() {
  for (const file of [".env.local", ".env"]) {
    try {
      const content = readFileSync(file, "utf8");
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
        const index = trimmed.indexOf("=");
        const key = trimmed.slice(0, index).trim();
        const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
        process.env[key] ??= value;
      }
    } catch {
      // optional env file
    }
  }
}

function norm(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim().toUpperCase();
}

async function resolveTenant(admin: ReturnType<typeof createClient>) {
  const { data, error } = await admin.from("tenants").select("id,name").limit(50);
  if (error) throw error;
  const tenants = (data ?? []) as TenantOption[];
  const tenant = tenants.find((row) => norm(row.name).includes("ISCHIA TRANSFER")) ?? tenants[0];
  if (!tenant?.id) throw new Error("Tenant non trovato.");
  return { id: tenant.id, name: tenant.name };
}

async function resolveOperator(admin: ReturnType<typeof createClient>, tenantId: string) {
  const { data, error } = await admin
    .from("memberships")
    .select("user_id,role,full_name,suspended")
    .eq("tenant_id", tenantId)
    .in("role", ["admin", "operator", "supervisor"])
    .order("role");
  if (error) throw error;
  const operators = (data ?? []) as OperatorOption[];
  const operator = operators.find((row) => row.suspended !== true && row.user_id);
  if (!operator?.user_id) throw new Error("Nessun admin/operator/supervisor disponibile per audit.");
  return { id: operator.user_id, role: operator.role ?? "operator", full_name: operator.full_name };
}

async function snapshotProtected(admin: ReturnType<typeof createClient>, tenantId: string) {
  const groups = await admin
    .from("trip_groups")
    .select("id,driver_user_id,driver_profile_id,vehicle_label,vehicle_capacity,status,updated_at")
    .eq("tenant_id", tenantId)
    .eq("date", GPR_PETER_EXPECTED_DATE)
    .eq("status", "active");
  if (groups.error) throw groups.error;
  const groupIds = (groups.data ?? []).map((group) => group.id as string);
  const assignments = groupIds.length
    ? await admin.from("assignments").select("service_id,group_id,driver_user_id,driver_profile_id,vehicle_label").eq("tenant_id", tenantId).in("group_id", groupIds)
    : { data: [], error: null };
  if (assignments.error) throw assignments.error;
  const serviceIds = [...new Set((assignments.data ?? []).map((assignment) => assignment.service_id as string).filter(Boolean))];
  const services = serviceIds.length
    ? await admin.from("services").select("id,customer_name,status").eq("tenant_id", tenantId).in("id", serviceIds)
    : { data: [], error: null };
  if (services.error) throw services.error;
  const byServiceId = new Map((services.data ?? []).map((service) => [service.id as string, service]));
  const protectedTokens = ["MORTELLA", "ILARIA", "LEO"];
  return (assignments.data ?? [])
    .map((assignment) => ({
      assignment,
      service: byServiceId.get(assignment.service_id as string) ?? null,
      group: (groups.data ?? []).find((group) => group.id === assignment.group_id) ?? null,
    }))
    .filter((row) => protectedTokens.some((token) => norm(row.service?.customer_name).includes(token)))
    .map((row) => ({
      service_id: row.assignment.service_id,
      customer_name: row.service?.customer_name ?? null,
      service_status: row.service?.status ?? null,
      group_id: row.assignment.group_id,
      assignment_driver_profile_id: row.assignment.driver_profile_id,
      assignment_vehicle_label: row.assignment.vehicle_label,
      group_driver_profile_id: row.group?.driver_profile_id ?? null,
      group_vehicle_label: row.group?.vehicle_label ?? null,
      group_updated_at: row.group?.updated_at ?? null,
    }))
    .sort((a, b) => String(a.service_id).localeCompare(String(b.service_id)));
}

function sameSnapshot(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function loadGroupState(admin: ReturnType<typeof createClient>, tenantId: string) {
  const group = await admin
    .from("trip_groups")
    .select("id,driver_user_id,driver_profile_id,vehicle_label,vehicle_capacity,status,updated_at")
    .eq("tenant_id", tenantId)
    .eq("id", GPR_PETER_GROUP_ID)
    .maybeSingle();
  if (group.error) throw group.error;
  const assignments = await admin
    .from("assignments")
    .select("id,service_id,driver_user_id,driver_profile_id,vehicle_label,assignment_source,locked_by_operator")
    .eq("tenant_id", tenantId)
    .eq("group_id", GPR_PETER_GROUP_ID);
  if (assignments.error) throw assignments.error;
  return { group: group.data, assignments: assignments.data ?? [] };
}

async function applyOnce(auth: PricingAuthContext, previewReference: string) {
  const preview = await buildGprPeterDriverSwapPreview({
    admin: auth.admin,
    tenantId: auth.membership.tenant_id,
    date: GPR_PETER_EXPECTED_DATE,
  });

  if (preview.already_applied) {
    const decisions = await loadConfirmedOperatorDecisions(auth, GPR_PETER_EXPECTED_DATE);
    const decision = decisions.find((row) => row.action === GPR_PETER_DRIVER_SWAP_ACTION && row.trip_group_id === GPR_PETER_GROUP_ID) ?? null;
    return { status: "already_applied", applied: 0, preview, decision };
  }
  if (preview.preview_reference !== previewReference) {
    throw new Error(`Preview stale: attesa ${previewReference}, corrente ${preview.preview_reference}`);
  }

  const validation = validateGprPeterDriverSwapPreviewForApply(preview);
  if (!validation.ok) throw new Error(`Blocker: ${validation.blockers.join(" ")}`);

  const now = new Date().toISOString();
  const groupUpdate = await auth.admin
    .from("trip_groups")
    .update({
      driver_user_id: preview.proposed.driver_user_id,
      driver_profile_id: preview.proposed.driver_profile_id,
      vehicle_label: preview.proposed.vehicle_label,
      vehicle_capacity: preview.proposed.vehicle_capacity,
      updated_at: now,
    })
    .eq("tenant_id", auth.membership.tenant_id)
    .eq("id", preview.trip_group_id)
    .eq("driver_profile_id", preview.current.driver_profile_id)
    .eq("updated_at", preview.current.updated_at)
    .select("id,driver_user_id,driver_profile_id,vehicle_label,vehicle_capacity,updated_at")
    .maybeSingle();
  if (groupUpdate.error || !groupUpdate.data?.id) {
    throw new Error(groupUpdate.error?.message ?? "Preview stale durante update trip_groups.");
  }

  const assignmentsUpdate = await auth.admin
    .from("assignments")
    .update({
      driver_user_id: preview.proposed.driver_user_id,
      driver_profile_id: preview.proposed.driver_profile_id,
      vehicle_label: preview.proposed.vehicle_label,
      assignment_source: "manual_piano_giorno",
      locked_by_operator: true,
      assigned_by: auth.user.id,
      assigned_at: now,
      lock_reason: "manual_assignment_from_daily_plan",
    })
    .eq("tenant_id", auth.membership.tenant_id)
    .eq("group_id", preview.trip_group_id)
    .select("id,service_id,driver_user_id,driver_profile_id,vehicle_label");
  if (assignmentsUpdate.error) throw assignmentsUpdate.error;

  const decision = await insertOperatorDecision(auth, {
    service_date: GPR_PETER_EXPECTED_DATE,
    trip_group_id: preview.trip_group_id,
    decision_type: GPR_PETER_DRIVER_SWAP_DECISION_TYPE,
    action: GPR_PETER_DRIVER_SWAP_ACTION,
    service_ids: preview.trip.service_ids,
    before_json: preview.before_json,
    after_json: preview.after_json,
    payload_json: preview.payload_json,
  });

  return {
    status: "applied",
    applied: 1,
    preview,
    updated_group: groupUpdate.data,
    updated_assignments: assignmentsUpdate.data ?? [],
    decision: decision.decision,
    duplicate: decision.duplicate,
  };
}

function countDecisions(decisions: PianoOperatorDecisionRow[]) {
  return decisions.filter((row) => row.action === GPR_PETER_DRIVER_SWAP_ACTION && row.trip_group_id === GPR_PETER_GROUP_ID).length;
}

async function main() {
  loadEnv();
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!supabaseUrl || !serviceKey) throw new Error("Missing Supabase env.");

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const tenant = await resolveTenant(admin);
  const operator = await resolveOperator(admin, tenant.id);
  const auth = {
    admin,
    user: { id: operator.id, email: null },
    membership: { tenant_id: tenant.id, role: operator.role, suspended: false },
  } satisfies PricingAuthContext;

  const beforeProtected = await snapshotProtected(admin, tenant.id);
  const preview = await buildGprPeterDriverSwapPreview({ admin, tenantId: tenant.id, date: GPR_PETER_EXPECTED_DATE });
  const apply = await applyOnce(auth, preview.preview_reference);
  const secondApply = await applyOnce(auth, preview.preview_reference);
  const afterState = await loadGroupState(admin, tenant.id);
  const afterProtected = await snapshotProtected(admin, tenant.id);
  const decisions = await loadConfirmedOperatorDecisions(auth, GPR_PETER_EXPECTED_DATE);
  const bindingPreview = await buildVehicleBindingPreview({ admin, tenantId: tenant.id, date: GPR_PETER_EXPECTED_DATE });

  console.log(JSON.stringify({
    tenant,
    operator: { id: operator.id, role: operator.role, full_name: operator.full_name },
    preview: {
      preview_reference: preview.preview_reference,
      current: preview.current,
      proposed: preview.proposed,
      trip: preview.trip,
      checks: preview.checks,
      warnings: preview.warnings,
      blockers: preview.blockers,
    },
    apply,
    after_state: afterState,
    diagnostics_after_apply: {
      vehicle_binding_summary: bindingPreview.summary,
      vehicle_binding_gpr_change_still_required: bindingPreview.changes.some((change) => change.group_id === GPR_PETER_GROUP_ID),
      operator_decisions_for_swap: countDecisions(decisions),
      protected_snapshot_unchanged: sameSnapshot(beforeProtected, afterProtected),
      protected_before_count: beforeProtected.length,
      protected_after_count: afterProtected.length,
      protected_diff: sameSnapshot(beforeProtected, afterProtected) ? [] : { before: beforeProtected, after: afterProtected },
      mario_zabattta_mentions: JSON.stringify(bindingPreview).toUpperCase().includes("ZABATT"),
    },
    idempotency: {
      second_status: secondApply.status,
      second_applied: secondApply.applied,
      operator_decisions_for_swap_after_second_post: countDecisions(await loadConfirmedOperatorDecisions(auth, GPR_PETER_EXPECTED_DATE)),
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : JSON.stringify(error, null, 2));
  process.exit(1);
});
