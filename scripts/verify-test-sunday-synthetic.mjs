#!/usr/bin/env node

const TENANT_ID = "d200b89a-64c7-4f8d-a430-95a33b83047a";
const DATE = "2025-10-12";
const SERVICE_COUNT = 500;
const BUS_COUNT = 50;
const PAX_PER_SERVICE = 10;

const services = Array.from({ length: SERVICE_COUNT }, (_, index) => ({
  id: `synthetic-service-${String(index + 1).padStart(3, "0")}`,
  tenant_id: TENANT_ID,
  date: DATE,
  pax: PAX_PER_SERVICE,
  direction: index % 2 === 0 ? "arrival" : "departure",
  status: "confirmed",
  is_test_data: true,
}));

const assignments = services.map((service, index) => ({
  id: `synthetic-assignment-${String(index + 1).padStart(3, "0")}`,
  tenant_id: TENANT_ID,
  service_id: service.id,
  driver_user_id: `synthetic-driver-${String((index % 100) + 1).padStart(3, "0")}`,
  vehicle_label: `VEICOLO-${String((index % 100) + 1).padStart(3, "0")}`,
  locked_by_operator: index % 17 === 0,
}));

const busUnits = Array.from({ length: BUS_COUNT }, (_, index) => ({
  id: `synthetic-bus-${String(index + 1).padStart(2, "0")}`,
  tenant_id: TENANT_ID,
  label: `BUS ${String(index + 1).padStart(2, "0")}`,
  capacity: 54,
}));

// 10 servizi per bus: 5 arrivi + 5 partenze, 10 pax ciascuno.
// Totale per direzione su ogni bus = 50/54, quindi il caso sano deve passare.
const busAllocations = services.map((service, index) => ({
  id: `synthetic-bus-allocation-${String(index + 1).padStart(3, "0")}`,
  tenant_id: TENANT_ID,
  service_id: service.id,
  bus_unit_id: busUnits[Math.floor(index / 10)].id,
  pax_assigned: PAX_PER_SERVICE,
}));

const { evaluateItsSundayTorture } = await import("../lib/server/its-sunday-torture.ts");

const report = evaluateItsSundayTorture({
  tenantId: TENANT_ID,
  date: DATE,
  expectedMinServices: 400,
  services,
  assignments,
  busAllocations,
  busUnits,
});

console.log("\n🔥 ITS SUNDAY TORTURE V1 — SYNTHETIC 500");
console.log(`   Servizi:         ${report.stats.services}`);
console.log(`   PAX:             ${report.stats.pax}`);
console.log(`   Arrivi:          ${report.stats.arrivalServices}`);
console.log(`   Partenze:        ${report.stats.departureServices}`);
console.log(`   Assignments:     ${report.stats.assignments}`);
console.log(`   Allocazioni bus: ${report.stats.busAllocations}`);
console.log(`   Bus censiti:     ${report.stats.busUnits}`);

if (report.hardFailures.length) {
  console.log(`\n❌ HARD FAILURES (${report.hardFailures.length})`);
  for (const issue of report.hardFailures) console.log(`  [${issue.code}] ${issue.message}`);
}

if (report.warnings.length) {
  console.log(`\n⚠️ WARNING (${report.warnings.length})`);
  for (const issue of report.warnings) console.log(`  [${issue.code}] ${issue.message}`);
}

console.log(report.passed ? "\n🟢 DOMENICA ITS: PASS\n" : "\n🔴 DOMENICA ITS: FAIL\n");
process.exit(report.passed ? 0 : 1);
