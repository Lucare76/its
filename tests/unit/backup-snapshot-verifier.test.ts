import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const REQUIRED_TABLES = [
  "services", "hotels", "memberships", "agencies", "assignments", "vehicles",
  "pricing_rules", "price_lists", "agency_invoices", "tenants", "trip_groups", "driver_profiles",
  "tenant_bus_lines", "tenant_bus_line_stops", "tenant_bus_units", "tenant_bus_allocations",
  "booking_groups", "booking_group_stops", "agency_bookings", "bus_lot_configs",
  "bus_import_pending", "ferry_pickup_rules", "hotel_vehicle_limits", "driver_availability",
];

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

function healthySnapshot() {
  const tenantId = "tenant-1";
  const data: Record<string, unknown[]> = Object.fromEntries(REQUIRED_TABLES.map((t) => [t, []]));
  data.tenants = [{ id: tenantId }];
  data.services = [{ id: "service-1", tenant_id: tenantId, booking_group_id: "group-1" }];
  data.assignments = [{ id: "assignment-1", tenant_id: tenantId, service_id: "service-1" }];
  data.tenant_bus_units = [{ id: "bus-1", tenant_id: tenantId }];
  data.tenant_bus_allocations = [{ id: "allocation-1", tenant_id: tenantId, service_id: "service-1", bus_unit_id: "bus-1" }];
  data.booking_groups = [{ id: "group-1", tenant_id: tenantId }];
  data.booking_group_stops = [{ id: "stop-1", tenant_id: tenantId, booking_group_id: "group-1" }];
  const row_counts = Object.fromEntries(Object.entries(data).map(([table, rows]) => [table, rows.length]));
  return { generated_at: new Date().toISOString(), tables: REQUIRED_TABLES, row_counts, data };
}

async function run(snapshot: unknown) {
  const dir = await mkdtemp(join(tmpdir(), "its-backup-test-")); dirs.push(dir);
  const file = join(dir, "backup_2026-09-05.json");
  await writeFile(file, JSON.stringify(snapshot), "utf8");
  return spawnSync(process.execPath, ["scripts/verify-backup-snapshot.mjs", file], { encoding: "utf8" });
}

describe("backup snapshot verifier", () => {
  it("passes a coherent snapshot with critical operational domains", async () => {
    const result = await run(healthySnapshot());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("BACKUP SNAPSHOT: PASS");
  });

  it("fails when a critical table is missing", async () => {
    const snapshot = healthySnapshot();
    snapshot.tables = snapshot.tables.filter((t) => t !== "tenant_bus_allocations");
    delete snapshot.data.tenant_bus_allocations;
    delete snapshot.row_counts.tenant_bus_allocations;
    const result = await run(snapshot);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("tabella richiesta non dichiarata: tenant_bus_allocations");
  });

  it("fails on an orphan assignment", async () => {
    const snapshot = healthySnapshot();
    snapshot.data.assignments = [{ id: "a", tenant_id: "tenant-1", service_id: "missing" }];
    snapshot.row_counts.assignments = 1;
    const result = await run(snapshot);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("assignments orfani");
  });

  it("fails on an orphan bus allocation", async () => {
    const snapshot = healthySnapshot();
    snapshot.data.tenant_bus_allocations = [{ id: "a", tenant_id: "tenant-1", service_id: "missing", bus_unit_id: "bus-1" }];
    snapshot.row_counts.tenant_bus_allocations = 1;
    const result = await run(snapshot);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("allocazioni bus orfane");
  });

  it("fails when an allocation references an unknown bus", async () => {
    const snapshot = healthySnapshot();
    snapshot.data.tenant_bus_allocations = [{ id: "a", tenant_id: "tenant-1", service_id: "service-1", bus_unit_id: "missing" }];
    snapshot.row_counts.tenant_bus_allocations = 1;
    const result = await run(snapshot);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("bus_unit_id sconosciuto");
  });

  it("fails on an unknown tenant", async () => {
    const snapshot = healthySnapshot();
    snapshot.data.agencies = [{ id: "agency-1", tenant_id: "tenant-2" }];
    snapshot.row_counts.agencies = 1;
    const result = await run(snapshot);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("tenant_id sconosciuto");
  });

  it("fails when a service references a missing booking group", async () => {
    const snapshot = healthySnapshot();
    snapshot.data.services = [{ id: "service-1", tenant_id: "tenant-1", booking_group_id: "missing" }];
    snapshot.row_counts.services = 1;
    const result = await run(snapshot);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("booking_group_id sconosciuto");
  });
});
