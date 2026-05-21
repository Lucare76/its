import type { SupabaseClient } from "@supabase/supabase-js";

export type LearnedPattern = {
  pattern_key: string;
  driver_profile_id: string;
  total_count: number;
  correction_count: number;
};

const MIN_OBSERVATIONS_PER_PATTERN = 5;
const MIN_TOTAL_TENANT_OBSERVATIONS = 20;

export async function loadLearnedPatterns(
  admin: SupabaseClient,
  tenantId: string
): Promise<LearnedPattern[]> {
  const { data, error } = await admin
    .from("assignment_learned_patterns")
    .select("pattern_key, driver_profile_id, total_count, correction_count")
    .eq("tenant_id", tenantId)
    .gte("total_count", MIN_OBSERVATIONS_PER_PATTERN);

  if (error || !data || data.length === 0) return [];

  const totalObs = (data as LearnedPattern[]).reduce((sum, p) => sum + p.total_count, 0);
  if (totalObs < MIN_TOTAL_TENANT_OBSERVATIONS) return [];

  return data as LearnedPattern[];
}

export async function updateLearnedPatterns(
  admin: SupabaseClient,
  tenantId: string
): Promise<{ upserted: number }> {
  // Load all relevant history for this tenant
  const [acceptedRes, correctedRes] = await Promise.all([
    admin
      .from("driver_assignment_history")
      .select("features, to_driver_profile_id")
      .eq("tenant_id", tenantId)
      .eq("change_type", "auto_assign_accepted")
      .not("to_driver_profile_id", "is", null),
    admin
      .from("driver_assignment_history")
      .select("features, from_driver_profile_id")
      .eq("tenant_id", tenantId)
      .eq("change_type", "driver_swap")
      .not("from_driver_profile_id", "is", null),
  ]);

  if (acceptedRes.error || correctedRes.error) {
    throw new Error(
      `Errore caricamento history: ${acceptedRes.error?.message ?? correctedRes.error?.message}`
    );
  }

  // Aggregate: (pattern_key, driver) → total_count
  const totalMap = new Map<string, number>();
  for (const row of acceptedRes.data ?? []) {
    const features = row.features as Record<string, unknown> | null;
    const patternKey = features?.pattern_key as string | null;
    const driver = row.to_driver_profile_id as string | null;
    if (!patternKey || !driver) continue;
    const key = `${patternKey}|||${driver}`;
    totalMap.set(key, (totalMap.get(key) ?? 0) + 1);
  }

  // Aggregate: (pattern_key, from_driver) → correction_count
  const correctionMap = new Map<string, number>();
  for (const row of correctedRes.data ?? []) {
    const features = row.features as Record<string, unknown> | null;
    const patternKey = features?.pattern_key as string | null;
    const driver = row.from_driver_profile_id as string | null;
    if (!patternKey || !driver) continue;
    const key = `${patternKey}|||${driver}`;
    correctionMap.set(key, (correctionMap.get(key) ?? 0) + 1);
  }

  if (totalMap.size === 0) return { upserted: 0 };

  const now = new Date().toISOString();
  const rows = Array.from(totalMap.entries()).map(([key, totalCount]) => {
    const [patternKey, driverProfileId] = key.split("|||");
    return {
      tenant_id: tenantId,
      pattern_key: patternKey!,
      driver_profile_id: driverProfileId!,
      total_count: totalCount,
      correction_count: correctionMap.get(key) ?? 0,
      last_updated_at: now,
    };
  });

  const { error } = await admin
    .from("assignment_learned_patterns")
    .upsert(rows, { onConflict: "tenant_id,pattern_key,driver_profile_id" });

  if (error) throw new Error(`Errore upsert pattern: ${error.message}`);

  return { upserted: rows.length };
}
