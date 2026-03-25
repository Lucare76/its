import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();

async function read(relativePath) {
  return readFile(resolve(root, relativePath), "utf8");
}

function assertIncludes(haystack, needle, label) {
  if (!haystack.includes(needle)) {
    throw new Error(`Smoke fail: missing ${label}`);
  }
}

async function main() {
  const migration = await read("supabase/migrations/0037_bus_network_transactions_and_quotes_access.sql");
  const busRoute = await read("app/api/ops/bus-network/route.ts");
  const quotesRoute = await read("app/api/ops/quotes/route.ts");
  const quotesAccessRoute = await read("app/api/ops/quotes/access/route.ts");
  const layout = await read("app/(app)/layout.tsx");
  const busPage = await read("app/(app)/bus-network/page.tsx");

  assertIncludes(migration, "create or replace function public.allocate_bus_service(", "allocate_bus_service RPC");
  assertIncludes(migration, "create or replace function public.move_bus_allocation(", "move_bus_allocation RPC");
  assertIncludes(migration, "if p_pax_moved > v_allocation.pax_assigned then", "pax upper-bound guard");
  assertIncludes(migration, "insert into public.tenant_bus_allocation_moves", "movement audit insert");

  assertIncludes(busRoute, 'validateBusAllocationRequest(auth', "server-side allocate validation");
  assertIncludes(busRoute, 'validateBusMoveRequest(auth', "server-side move validation");
  assertIncludes(busRoute, 'rpc("allocate_bus_service"', "allocate RPC usage");
  assertIncludes(busRoute, 'rpc("move_bus_allocation"', "move RPC usage");
  assertIncludes(busRoute, 'direction: "departure"', "bidirectional manual stop insert");

  assertIncludes(busPage, "Gestisci fermate", "stop manager UI");
  assertIncludes(busPage, "Assegna a bus", "allocation UI");
  assertIncludes(busPage, "Sposta passeggero", "move UI");
  assertIncludes(busPage, "moveResidual", "move capacity preview");

  assertIncludes(quotesRoute, "requireQuotesAccess", "quotes access enforcement import");
  assertIncludes(quotesRoute, "const denied = await requireQuotesAccess(auth);", "quotes access enforcement usage");
  assertIncludes(quotesAccessRoute, "can_access", "quotes access status endpoint");
  assertIncludes(layout, '/api/ops/quotes/access', "quotes guard fetch in layout");

  console.log("Bus module smoke passed:");
  console.log("- transactional RPCs present");
  console.log("- server validation hooks wired");
  console.log("- stop manager and move preview wired");
  console.log("- quote access enforcement wired");
  console.log("- bus UI exposes allocation and movement controls");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
