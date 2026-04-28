import type { SupabaseClient } from "@supabase/supabase-js";

export type VehicleCommitmentRow = {
  id: string;
  vehicle_id: string;
  commitment_date: string;
  commitment_type: "collaudo" | "officina" | "fermo_amministrativo" | "altro";
  notes: string | null;
};

export async function loadVehicleCommitmentsForDate(
  admin: SupabaseClient,
  tenantId: string,
  date: string
): Promise<{
  rows: VehicleCommitmentRow[];
  byVehicleId: Map<string, VehicleCommitmentRow>;
}> {
  const { data, error } = await admin
    .from("vehicle_commitments")
    .select("id, vehicle_id, commitment_date, commitment_type, notes")
    .eq("tenant_id", tenantId)
    .eq("commitment_date", date);

  if (error) {
    console.error("[vehicle-commitments] query error:", error.message);
    return { rows: [], byVehicleId: new Map() };
  }

  const rows = (data ?? []) as VehicleCommitmentRow[];
  return {
    rows,
    byVehicleId: new Map(rows.map((row) => [row.vehicle_id, row])),
  };
}
