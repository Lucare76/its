import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Obiettivo A — Hotel/struttura visibile nella UI Booking Groups.
 *
 * app/(app)/booking-groups/page.tsx è "use client" con hook React: nessun
 * harness di render component in questo progetto (nessun
 * @testing-library/react, vitest.config.ts usa environment "node" — stesso
 * vincolo già documentato in tests/unit/mts-globe-post-confirm.test.ts).
 * Questo test verifica quindi il contratto a livello di sorgente: il campo
 * Hotel/struttura è cablato sia nel modal di creazione sia nel dettaglio
 * gruppo, con placeholder e riuso dello stesso componente.
 */
const source = readFileSync(
  join(process.cwd(), "app/(app)/booking-groups/page.tsx"),
  "utf8"
);

describe("Booking Groups page.tsx — campo Hotel / struttura (Obiettivo A)", () => {
  it("il placeholder richiesto è presente", () => {
    expect(source).toMatch(/Cerca o inserisci hotel\/struttura/);
  });

  it("il modal 'Nuovo gruppo prenotazione' include <HotelField>", () => {
    const formStart = source.indexOf("function NewGroupForm(");
    const formEnd = source.indexOf("\nfunction ", formStart + 1);
    const formBody = source.slice(formStart, formEnd === -1 ? undefined : formEnd);
    expect(formBody).toMatch(/<HotelField\s/);
    expect(formBody).toMatch(/hotel_id:\s*hotelId/);
  });

  it("il dettaglio gruppo mostra il nome hotel risolto e include <HotelField> per la modifica", () => {
    const detailStart = source.indexOf("function GroupDetail(");
    const detailEnd = source.indexOf("\nfunction ", detailStart + 1);
    const detailBody = source.slice(detailStart, detailEnd === -1 ? undefined : detailEnd);
    expect(detailBody).toMatch(/Hotel \/ struttura:/);

    const editStart = source.indexOf("function GroupEditSection(");
    const editEnd = source.indexOf("\nfunction ", editStart + 1);
    const editBody = source.slice(editStart, editEnd === -1 ? undefined : editEnd);
    expect(editBody).toMatch(/<HotelField\s/);
    expect(editBody).toMatch(/hotel_id:\s*hotelId/);
  });

  it("il campo hotel non è mai obbligatorio: nessun 'required' sul form di creazione", () => {
    const formStart = source.indexOf("function NewGroupForm(");
    const formEnd = source.indexOf("\nfunction ", formStart + 1);
    const formBody = source.slice(formStart, formEnd === -1 ? undefined : formEnd);
    expect(formBody).not.toMatch(/hotelId[^\n]*required/i);
  });

  it("HotelField non inventa mai un hotel_id da testo libero: solo match esatto contro l'elenco hotel", () => {
    const fieldStart = source.indexOf("function HotelField(");
    const fieldEnd = source.indexOf("\nfunction ", fieldStart + 1);
    const fieldBody = source.slice(fieldStart, fieldEnd === -1 ? undefined : fieldEnd);
    expect(fieldBody).toMatch(/hotels\.find\(/);
    expect(fieldBody).toMatch(/onChange\(match \? match\.id : null\)/);
  });
});
