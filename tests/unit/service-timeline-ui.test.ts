import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

/**
 * UI Cronologia (Fase 8): no JSON grezzo, "Carica altri", icone per tipo
 * actor, il box "Log modifiche prenotazione" è stato evoluto/sostituito nel
 * page servizio.
 */

function read(relPath: string) {
  return readFileSync(join(process.cwd(), relPath), "utf8");
}

describe("components/service-timeline.tsx — no JSON grezzo, formato leggibile", () => {
  const source = read("components/service-timeline.tsx");

  it("non fa mai JSON.stringify di un evento nel markup", () => {
    expect(source).not.toMatch(/JSON\.stringify/);
  });

  it("non accede mai a event.old_data/event.new_data/event.metadata grezzi (solo changes[] già normalizzato)", () => {
    expect(source).not.toMatch(/event\.old_data|event\.new_data|event\.metadata/);
    expect(source).toMatch(/changes\?:/);
  });

  it("ha un pulsante 'Carica altri' per la paginazione, disabilitato durante il caricamento", () => {
    expect(source).toMatch(/Carica altri/);
    expect(source).toMatch(/disabled=\{loadingMore\}/);
  });

  it("mostra un'icona diversa per ogni tipo di actor (human/system/import/provider/agency)", () => {
    for (const type of ["human", "system", "import", "provider", "agency"]) {
      expect(source).toMatch(new RegExp(`${type}:`));
    }
  });

  it("chiama l'endpoint lazy dedicato, con Authorization Bearer (stesso pattern delle altre fetch della pagina)", () => {
    expect(source).toMatch(/\/api\/ops\/services\/\$\{serviceId\}\/timeline/);
    expect(source).toMatch(/Authorization: `Bearer \$\{accessToken\}`/);
  });
});

describe("app/(app)/services/[id]/edit/page.tsx — box evoluto in Cronologia", () => {
  const source = read("app/(app)/services/[id]/edit/page.tsx");

  it("usa <ServiceTimeline>, non più il vecchio box 'Log modifiche prenotazione'", () => {
    expect(source).toMatch(/<ServiceTimeline serviceId=\{service\.id\} accessToken=\{accessToken\} \/>/);
    expect(source).not.toMatch(/Log modifiche prenotazione/);
  });

  it("il codice morto del vecchio box (fieldLabel/formatLogDate/logFerryDetails/changeLogs) è stato rimosso, non lasciato inutilizzato", () => {
    expect(source).not.toMatch(/function fieldLabel/);
    expect(source).not.toMatch(/function formatLogDate/);
    expect(source).not.toMatch(/function logFerryDetails/);
    expect(source).not.toMatch(/changeLogs/);
    expect(source).not.toMatch(/type ServiceChangeLog/);
  });

  it("importa ServiceTimeline dal componente condiviso", () => {
    expect(source).toMatch(/import \{ ServiceTimeline \} from "@\/components\/service-timeline";/);
  });

  it("ferryMeta/isFerryFormula restano usati altrove nella pagina (non erano dead code, solo il box li usava anche per i dettagli traghetto)", () => {
    expect(source).toMatch(/isFerryFormula/);
    expect(source).toMatch(/ferryMeta/);
  });
});
