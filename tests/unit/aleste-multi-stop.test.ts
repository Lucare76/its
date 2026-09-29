import { describe, expect, it } from "vitest";
import { alesteMultiStopHotel, extractAlesteMultiStopRows, isAlesteMultiStop, pairAlesteBusRows } from "@/lib/server/aleste-multi-stop";

const operationalRow = (date: string, description: string, time: string, stop: string, destination: string) =>
  `Il ${date} 1 BUS DA ${description} ${description === "HOTEL ISCHIA" ? "PICK-UP" : "PARTENZA"} ORE ${time}\nMeeting point: ${stop} da: ${description === "HOTEL ISCHIA" ? "HOTEL" : description} a: PORTO dest: ${destination}\nL'ORARIO DI PARTENZA SARA' RICONFERMATO IL GIORNO PRIMA`;

describe("Aleste multi fermata", () => {
  it("separa due fermate in entrambe le direzioni e conserva un passeggero per riga", () => {
    const text = ["STAFF ALESTE", operationalRow("11-ott-26", "MILANO", "06:30", "CASCINA GOBBA", "ISOLA VERDE"), operationalRow("11-ott-26", "VALDARNO", "11:15", "CASELLO VALDARNO", "ISOLA VERDE"), operationalRow("18-ott-26", "HOTEL ISCHIA", "5:00", "DA HOTEL ISCHIA", "CASCINA GOBBA"), operationalRow("18-ott-26", "HOTEL ISCHIA", "5:00", "DA HOTEL ISCHIA", "CASELLO VALDARNO")].join("\n");
    const rows = extractAlesteMultiStopRows(text);
    expect(isAlesteMultiStop(text)).toBe(true);
    expect(rows.map(({ direction, pax, destination }) => [direction, pax, destination])).toEqual([
      ["andata", 1, "ISOLA VERDE"], ["andata", 1, "ISOLA VERDE"],
      ["ritorno", 1, "CASCINA GOBBA"], ["ritorno", 1, "CASELLO VALDARNO"]
    ]);
    expect(rows[2].time).toBe("05:00");
    expect(pairAlesteBusRows(rows)?.map((pair) => pair.departure.destination)).toEqual(["CASCINA GOBBA", "CASELLO VALDARNO"]);
    expect(alesteMultiStopHotel(rows)).toBe("ISOLA VERDE");
  });

  it("riconosce anche l'estrazione PDF con Il attaccato alla data e 1BUS", () => {
    const text = `STAFF ALESTE\nIl11-ott-26 1BUS DA MILANO PARTENZA ORE 06:30\nMeeting point: CASCINA GOBBA da: MILANO a: CELL. 123 dest: ISOLA VERDE\nL'ORARIO\nIl11-ott-26 1BUS DA VALDARNO PARTENZA ORE 11:15\nMeeting point: CASELLO VALDARNO da: VALDARNO a: CELL. 123 dest: ISOLA VERDE\nL'ORARIO\nIl18-ott-26 1BUS DA HOTEL ISCHIA PICK-UP ORE 5:00\nMeeting point: DA HOTEL ISCHIA da: HOTEL a: PORTO dest: CASCINA GOBBA\nL'ORARIO\nIl18-ott-26 1BUS DA HOTEL ISCHIA PICK-UP ORE 5:00\nMeeting point: DA HOTEL ISCHIA da: HOTEL a: PORTO dest: CASELLO VALDARNO\nSPETT.LE`;
    expect(pairAlesteBusRows(extractAlesteMultiStopRows(text))).toHaveLength(2);
  });

  it("non blocca una conferma Aleste con una sola fermata", () => {
    const text = `STAFF ALESTE\n${operationalRow("11-ott-26", "BOLOGNA", "06:30", "BOLOGNA", "ISOLA VERDE")}`;
    expect(isAlesteMultiStop(text)).toBe(false);
  });
});
