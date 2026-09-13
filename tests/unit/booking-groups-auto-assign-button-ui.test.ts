import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * "Auto-assegna gruppo" — bottone UI che espone l'action server già
 * esistente `auto_assign_group` (autoAssignBookingGroup). Nessuna nuova API,
 * nessuna logica di allocazione duplicata: questo file verifica solo il
 * contratto lato UI, stesso pattern "source contract" già usato per
 * BusReservationSection/StopsSection in questa pagina (nessun
 * @testing-library/react, vitest.config.ts usa environment "node").
 */
const pageSource = readFileSync(
  join(process.cwd(), "app/(app)/booking-groups/page.tsx"),
  "utf8"
);
const routeSource = readFileSync(
  join(process.cwd(), "app/api/ops/booking-groups/route.ts"),
  "utf8"
);
const serviceSource = readFileSync(
  join(process.cwd(), "lib/server/booking-groups-service.ts"),
  "utf8"
);
const busNetworkRouteSource = readFileSync(
  join(process.cwd(), "app/api/ops/bus-network/route.ts"),
  "utf8"
);

function extractFunctionBody(source: string, fnName: string): string {
  const start = source.indexOf(`function ${fnName}(`);
  if (start === -1) throw new Error(`function ${fnName} non trovata nel sorgente`);
  const nextFn = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, nextFn === -1 ? undefined : nextFn);
}

describe("Booking Groups page.tsx — pulsante 'Auto-assegna gruppo' (GroupDetail)", () => {
  const detailBody = extractFunctionBody(pageSource, "GroupDetail");

  it("1. visibile solo per gruppi bus_exclusive o bus_group (stessa condizione di BusReservationSection)", () => {
    // Il bottone e BusReservationSection condividono lo stesso blocco JSX
    // condizionale: se il match esiste una sola volta e contiene entrambi,
    // la visibilità è garantita identica.
    const match = detailBody.match(/\(group\.kind === "bus_exclusive" \|\| group\.kind === "bus_group"\)[\s\S]*?Auto-assegna gruppo[\s\S]*?<BusReservationSection/);
    expect(match).not.toBeNull();
  });

  it("2. il click invia { action: \"auto_assign_group\", booking_group_id: group.id } tramite post()", () => {
    expect(detailBody).toMatch(/post\(\{\s*action:\s*"auto_assign_group",\s*booking_group_id:\s*group\.id\s*\}\)/);
  });

  it("3. il pulsante si disabilita durante la richiesta e mostra 'Auto-assegno…'", () => {
    expect(detailBody).toMatch(/disabled=\{autoAssignBusy\}/);
    expect(detailBody).toMatch(/setAutoAssignBusy\(true\)/);
    expect(detailBody).toMatch(/setAutoAssignBusy\(false\)/);
    expect(detailBody).toMatch(/Auto-assegno…/);
  });

  it("4. dopo il successo il dettaglio si aggiorna: usa post() (che chiama onChange internamente), nessuna chiamata api() diretta per questa action", () => {
    expect(detailBody).toMatch(/const runAutoAssignGroup = async \(\) => \{[\s\S]*?await post\(\{\s*action:\s*"auto_assign_group"/);
    // Non deve bypassare post() con una fetch/api() diretta per questa azione
    // (a differenza di OperationalizeSection, che ha bisogno di un messaggio
    // custom e per questo NON riusa post()).
    const runBody = detailBody.slice(detailBody.indexOf("const runAutoAssignGroup"));
    const runBodyOnly = runBody.slice(0, runBody.indexOf("\n  };") + 5);
    expect(runBodyOnly).not.toMatch(/api\(/);
  });

  it("mostra conferma esplicita prima della chiamata, senza assumere lo stesso bus per andata e ritorno", () => {
    expect(detailBody).toMatch(/window\.confirm\(/);
    expect(detailBody).toMatch(/auto-assegnazione del gruppo/i);
  });
});

describe("Nessuna nuova API introdotta — riuso dell'action auto_assign_group già esistente", () => {
  it("5a. page.tsx chiama sempre lo stesso endpoint /api/ops/booking-groups (nessun nuovo path)", () => {
    expect(pageSource).toMatch(/const post = async \(body: unknown\): Promise<PostResult> => \{\s*const \{ ok, json \} = await api\("\/api\/ops\/booking-groups"/);
  });

  it("5b. route.ts espone l'action auto_assign_group una sola volta (schema + branch), nessun duplicato", () => {
    const schemaOccurrences = (routeSource.match(/action:\s*z\.literal\("auto_assign_group"\)/g) ?? []).length;
    const branchOccurrences = (routeSource.match(/body\.action === "auto_assign_group"/g) ?? []).length;
    expect(schemaOccurrences).toBe(1);
    expect(branchOccurrences).toBe(1);
  });

  it("5c. il branch auto_assign_group richiama autoAssignBookingGroup senza logica di allocazione aggiuntiva inline", () => {
    const branchIdx = routeSource.indexOf('if (body.action === "auto_assign_group")');
    const branchSlice = routeSource.slice(branchIdx, branchIdx + 400);
    expect(branchSlice).toMatch(/const result = await autoAssignBookingGroup\(admin, actor, body\.booking_group_id\);/);
    expect(branchSlice).toMatch(/return NextResponse\.json\(\{ ok: true, \.\.\.result \}\);/);
  });
});

describe("Nessuna funzione di allocazione modificata da questo task", () => {
  it("6a. autoAssignBookingGroup e findAvailableBusesForGroup esistono ancora con la stessa firma esportata", () => {
    expect(serviceSource).toMatch(/export async function autoAssignBookingGroup\(\s*admin: SupabaseClient,\s*actor: BgActor,\s*bookingGroupId: string,\s*\): Promise<AutoAssignBookingGroupResult>/);
    expect(serviceSource).toMatch(/export async function findAvailableBusesForGroup\(/);
  });

  it("6b. la scelta del candidato resta candidates[0] senza override successivo (stesso punto verificato negli audit precedenti)", () => {
    expect(serviceSource).toMatch(/const chosen = candidates\[0\]!;/);
    expect(serviceSource).toMatch(/busUnitId: chosen\.id,/);
  });

  it("6c. pickBusCandidates e pickBusCandidatesOrdered non toccati (presenti, invariati nel punto chiave earlierWithRoom)", () => {
    expect(busNetworkRouteSource).toMatch(/function pickBusCandidatesOrdered</);
    expect(busNetworkRouteSource).toMatch(/const earlierWithRoom = sameStopIndex > 0 \? lineUnits\.slice\(0, sameStopIndex\)\.find\(hasRoom\) \?\? null : null;/);
  });
});
