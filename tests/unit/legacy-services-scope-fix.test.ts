import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

/**
 * Sprint Performance — eliminazione fetchAllServices() dalle ultime 3 pagine
 * rimaste sul ramo LEGACY di /api/ops/tenant-data (map, bus-tours,
 * crm-agencies). Audit pg_stat_statements: ~97.795 call su una query
 * services paginata ordinata (mean 63ms, max 3.346ms, totale 6.166.082ms) +
 * ~12.105 call su una variante piu' semplice — entrambe generate da
 * fetchAllServices() (lib/server/fetch-all-services.ts), raggiunto solo
 * quando il client NON invia service_scope (route.ts riga 107: `if
 * (!rawScopeMode || rawScopeMode === "legacy")`).
 *
 * map e bus-tours: FIX applicato (serviceScope aggiunto -> ramo scoped).
 * crm-agencies: ECCEZIONE DELIBERATA, non toccata — agencyStats calcola
 * totali LIFETIME per agenzia (revenueTotal, services.length, pax,
 * latestDate, serviceMix) che un serviceScope limitato corromperebbe
 * silenziosamente (regressione funzionale vietata dal task). La pagina
 * porta gia' un commento che documenta questa scelta (probabilmente da un
 * fix precedente, "Sprint Performance 14D") — qui verifichiamo solo che
 * resti cosi', non lo modifichiamo.
 */

function read(relPath: string) {
  return readFileSync(join(process.cwd(), relPath), "utf8");
}

describe("map/page.tsx — non e' piu' sul ramo LEGACY", () => {
  const source = read("app/(app)/map/page.tsx");

  it("passa un serviceScope mode:'date' (data odierna) a useTenantOperationalData", () => {
    expect(source).toMatch(/serviceScope:\s*\{\s*mode:\s*"date",\s*date:\s*todayIso\s*\}/);
  });

  it("todayIso e' calcolato lato client (non hardcoded, non da API esterna)", () => {
    expect(source).toMatch(/const todayIso = new Date\(\)\.toISOString\(\)\.slice\(0, 10\);/);
  });

  it("nessun filtro data preesistente e' stato toccato (la pagina non ne aveva: solo status/tipo/autista/nave/zona)", () => {
    expect(source).toMatch(/statusFilter/);
    expect(source).toMatch(/serviceTypeFilter/);
    expect(source).toMatch(/driverFilter/);
    expect(source).toMatch(/vesselFilter/);
    expect(source).toMatch(/zoneFilter/);
    expect(source).not.toMatch(/dateFilter/);
  });

  it("refresh() e la subscription Realtime del hook non sono state toccate (nessuna sostituzione di useTenantOperationalData)", () => {
    expect(source).toMatch(/import \{ useTenantOperationalData \} from "@\/lib\/supabase\/use-tenant-operational-data";/);
    expect(source).toMatch(/await refresh\(\);/);
  });
});

describe("bus-tours/page.tsx — non e' piu' sul ramo LEGACY", () => {
  const source = read("app/(app)/bus-tours/page.tsx");

  it("passa un serviceScope mode:'range' con finestra +/-180gg calcolata da oggi", () => {
    expect(source).toMatch(/rangeFrom\.setDate\(rangeFrom\.getDate\(\) - 180\)/);
    expect(source).toMatch(/rangeTo\.setDate\(rangeTo\.getDate\(\) \+ 180\)/);
    expect(source).toMatch(/serviceScope:\s*\{\s*mode:\s*"range",\s*from:\s*rangeFrom\.toISOString\(\)\.slice\(0, 10\),\s*to:\s*rangeTo\.toISOString\(\)\.slice\(0, 10\)\s*\}/);
  });

  it("i dataset richiesti restano invariati (services, assignments, hotels, memberships, busLotConfigs)", () => {
    expect(source).toMatch(/datasets:\s*\{\s*services:\s*true,\s*assignments:\s*true,\s*hotels:\s*true,\s*memberships:\s*true,\s*busLotConfigs:\s*true\s*\}/);
  });

  it("availableDates resta derivato dai dati caricati (nessun input data libero introdotto — il dropdown si autolimita allo scope)", () => {
    expect(source).toMatch(/const availableDates = useMemo\(/);
    expect(source).toMatch(/<select className="input-saas mt-1 w-full" value=\{dateFilter\}/);
  });

  it("dateFilter/tourNameFilter/statusFilter client-side non sono stati toccati", () => {
    expect(source).toMatch(/const \[dateFilter, setDateFilter\] = useState\("all"\);/);
    expect(source).toMatch(/const \[tourNameFilter, setTourNameFilter\] = useState\(""\);/);
    expect(source).toMatch(/const \[statusFilter, setStatusFilter\] = useState<ServiceStatus \| "all">\("all"\);/);
  });
});

describe("crm-agencies/page.tsx — eccezione deliberata, LASCIATA sul ramo LEGACY", () => {
  const source = read("app/(app)/crm-agencies/page.tsx");

  it("NON ha serviceScope (invariato): agencyStats richiede lo storico completo per i totali lifetime", () => {
    expect(source).not.toMatch(/serviceScope:/);
    expect(source).toMatch(/useTenantOperationalData\(\{ datasets: \{ services: true, hotels: true \} \}\)/);
  });

  it("il motivo (totali lifetime per agenzia) e' effettivamente calcolato in agencyStats, non solo dichiarato nel commento", () => {
    expect(source).toMatch(/revenueTotal/);
    expect(source).toMatch(/agencyStats/);
  });

  it("porta un commento esplicito che documenta la scelta di restare full-history", () => {
    expect(source).toMatch(/full-history services \(no serviceScope\)/);
  });
});

describe("Nessuna delle tre pagine puo' raggiungere fetchAllServices() durante il caricamento normale — tranne l'eccezione documentata", () => {
  const routeSource = read("app/api/ops/tenant-data/route.ts");

  it("route.ts: il ramo LEGACY (fetchAllServices) scatta solo quando manca service_scope — logica non modificata da questo fix", () => {
    expect(routeSource).toMatch(/if \(!rawScopeMode \|\| rawScopeMode === "legacy"\) \{/);
    expect(routeSource).toMatch(/wantsLegacy\("services"\) \? fetchAllServices\(auth\.admin, tenantId\) : Promise\.resolve\(\{ data: \[\], error: null \}\)/);
  });

  it("map e bus-tours ora inviano sempre service_scope (mode date/range) -> mai piu' ramo LEGACY in condizioni normali", () => {
    const mapSource = read("app/(app)/map/page.tsx");
    const toursSource = read("app/(app)/bus-tours/page.tsx");
    expect(mapSource).toMatch(/serviceScope:/);
    expect(toursSource).toMatch(/serviceScope:/);
  });

  it("crm-agencies continua a chiamare fetchAllServices() ad ogni refresh — rischio residuo noto e documentato, non silenzioso", () => {
    const crmSource = read("app/(app)/crm-agencies/page.tsx");
    expect(crmSource).not.toMatch(/serviceScope:/);
  });
});

describe("fetchAllServices() stesso — NON toccato (fuori scope salvo stretta necessita')", () => {
  it("la funzione e la sua query restano identiche", () => {
    const source = read("lib/server/fetch-all-services.ts");
    expect(source).toMatch(/\.select\("\*"\)/);
    expect(source).toMatch(/\.eq\("tenant_id", tenantId\)/);
    expect(source).toMatch(/\.order\("created_at", \{ ascending: true \}\)/);
    expect(source).toMatch(/\.order\("id", \{ ascending: true \}\)/);
    expect(source).toMatch(/PAGE = 1000/);
  });
});

describe("Nessuna regressione sulle pagine gia' correttamente scoped (arrivals, departures, planning)", () => {
  it("arrivals/page.tsx: serviceScope mode:'date' invariato", () => {
    const source = read("app/(app)/arrivals/page.tsx");
    expect(source).toMatch(/serviceScope:\s*\{\s*mode:\s*"date",\s*date:\s*selectedDate\s*\}/);
  });

  it("departures/page.tsx: serviceScope mode:'date' invariato", () => {
    const source = read("app/(app)/departures/page.tsx");
    expect(source).toMatch(/serviceScope:\s*\{\s*mode:\s*"date",\s*date:\s*selectedDate\s*\}/);
  });

  it("planning/page.tsx: serviceScope da computePlanningRangeScope invariato", () => {
    const source = read("app/(app)/planning/page.tsx");
    expect(source).toMatch(/serviceScope:\s*computePlanningRangeScope\(selectedDate\)/);
  });
});

describe("Realtime + refresh automatico del hook condiviso — non toccati da questo fix", () => {
  it("use-tenant-operational-data.ts: la subscription postgres_changes e il fallback polling sono ancora presenti", () => {
    const source = read("lib/supabase/use-tenant-operational-data.ts");
    expect(source).toMatch(/postgres_changes/);
    expect(source).toMatch(/setInterval/);
  });
});
