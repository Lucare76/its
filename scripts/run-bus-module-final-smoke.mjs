import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

async function read(relativePath) {
  return readFile(resolve(process.cwd(), relativePath), "utf8");
}

function assertIncludes(haystack, needle, label) {
  if (!haystack.includes(needle)) {
    throw new Error(`Final smoke fail: missing ${label}`);
  }
}

async function main() {
  const migration37 = await read("supabase/migrations/0037_bus_network_transactions_and_quotes_access.sql");
  const migration38 = await read("supabase/migrations/0038_bus_booking_centric_reorder_and_audit.sql");
  const busRoute = await read("app/api/ops/bus-network/route.ts");
  const busPage = await read("app/(app)/bus-network/page.tsx");
  const exportServer = await read("lib/server/services-export.ts");
  const whatsappFlows = await read("app/api/ops/whatsapp-flows/route.ts");
  const quotesRoute = await read("app/api/ops/quotes/route.ts");

  assertIncludes(migration37, "create or replace function public.move_bus_allocation(", "transactional move RPC");
  assertIncludes(migration38, "create view public.ops_bus_allocation_details", "booking-centric allocation view");
  assertIncludes(migration38, "create or replace function public.reorder_bus_line_stops(", "reorder RPC");
  assertIncludes(migration38, "root_allocation_id", "allocation split lineage");

  assertIncludes(busRoute, 'rpc("move_bus_allocation"', "move RPC wiring");
  assertIncludes(busRoute, 'rpc("reorder_bus_line_stops"', "reorder RPC wiring");
  assertIncludes(busRoute, 'from("ops_bus_allocation_details")', "booking-centric allocation load");

  assertIncludes(busPage, "onDragStart", "drag and drop wiring");
  assertIncludes(busPage, "Sposta passeggero", "move confirmation modal");
  assertIncludes(busPage, "Gestisci fermate", "stop manager UI");
  assertIncludes(busPage, "Assegna a bus", "allocation modal UI");

  assertIncludes(exportServer, "buildBusOperationalSheet(", "bus export sheet builder");
  assertIncludes(exportServer, '"Bus Operativo"', "bus export sheet append");

  assertIncludes(whatsappFlows, '"bus_monday"', "bus monday whatsapp flow");
  assertIncludes(whatsappFlows, '"arrivals_48h"', "arrivals 48h whatsapp flow");
  assertIncludes(quotesRoute, "requireQuotesAccess", "quotes access enforcement");

  console.log("Bus module final smoke passed:");
  console.log("- booking-centric allocation lineage present");
  console.log("- drag/drop routes through confirmed move flow");
  console.log("- stop reorder RPC wired");
  console.log("- allocation and stop manager UI present");
  console.log("- bus export sheet present");
  console.log("- whatsapp preview flows present");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
