type Fill = { id: string; fuel_date: string; km_at_fuel: number | null; liters: number | null };
export function estimateConsumption(rows: Fill[], min: number | null, max: number | null) {
  const sorted = [...rows].filter(row => row.km_at_fuel != null && row.liters != null)
    .sort((a, b) => a.fuel_date.localeCompare(b.fuel_date) || a.km_at_fuel! - b.km_at_fuel!);
  return sorted.slice(1).map((row, index) => {
    const previous = sorted[index]!;
    const distance = row.km_at_fuel! - previous.km_at_fuel!;
    if (distance <= 0 || !row.liters || distance < 20) return null;
    const value = Math.round(row.liters / distance * 10000) / 100;
    return { ...row, previous_id: previous.id, distance_km: distance,
      liters_per_100km: value, anomaly: (min != null && value < min) || (max != null && value > max) };
  }).filter((row): row is NonNullable<typeof row> => row !== null);
}
