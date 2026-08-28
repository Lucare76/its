import { describe, expect, it } from "vitest";
import {
  isOperationalV2Header,
  parseOperationalV2Rows,
  type RawOperationalExcelRow,
} from "@/lib/operational-excel-normalize";

function row(overrides: Partial<RawOperationalExcelRow> = {}): RawOperationalExcelRow {
  return {
    "DATA": "07/05/2026",
    "ORARIO DI ARRIVO": "08:40",
    "ORARIO DI PARTENZA": "",
    "COMPAGNIA NAVE": "",
    "ORARIO NAVE": "",
    "NUMERO PAX": "2",
    "AGENZIA": "ALESTE VIAGGI",
    "VOLO NUMERO": "LX1712",
    "DA": "AEROPORTO",
    "A": "PUNTO AZZURRO",
    "NOME": "ROSSI MARIO",
    "CELLULARE": "081 123456",
    "NOTE": "note test",
    "SERVIZIO": "AEROPORTO HOTEL",
    "CATEGORIA": "TRANSFER",
    "TIPO": "ANDATA",
    ...overrides,
  };
}

describe("operational_v2 parser", () => {
  it("riconosce header operational_v2", () => {
    expect(isOperationalV2Header([
      "DATA",
      "ORARIO DI ARRIVO",
      "ORARIO DI PARTENZA",
      "COMPAGNIA NAVE",
      "ORARIO NAVE",
      "NUMERO PAX",
      "AGENZIA",
      "VOLO NUMERO",
      "DA",
      "A",
      "NOME",
      "CELLULARE",
      "NOTE",
      "SERVIZIO",
      "CATEGORIA",
      "TIPO",
    ])).toBe(true);
  });

  it("normalizza trim, telefono testo, data, orari e pax", () => {
    const parsed = parseOperationalV2Rows([
      row({
        "DATA": "7/5/2026",
        "ORARIO DI ARRIVO": "840",
        "ORARIO DI PARTENZA": "09.30",
        "NUMERO PAX": "02 pax",
        "A": "RE FERDINANDO ",
        "CELLULARE": 3331234567,
      }),
    ]);

    expect(parsed.rows[0].normalized.date).toBe("2026-05-07");
    expect(parsed.rows[0].normalized.arrival_time).toBe("08:40");
    expect(parsed.rows[0].normalized.departure_time).toBe("09:30");
    expect(parsed.rows[0].normalized.pax).toBe(2);
    expect(parsed.rows[0].normalized.to).toBe("RE FERDINANDO");
    expect(parsed.rows[0].normalized.phone).toBe("3331234567");
  });

  it("conteggia 38 righe: 12 transfer, 15 formula nave, 11 escursione", () => {
    const rows: RawOperationalExcelRow[] = [];
    for (let i = 0; i < 12; i += 1) {
      rows.push(row({ "NOME": `TRANSFER ${i}`, "CELLULARE": `3330000${i}` }));
    }
    for (let i = 0; i < 15; i += 1) {
      rows.push(row({
        "NOME": `FERRY ${i}`,
        "CATEGORIA": "FORMULA NAVE",
        "SERVIZIO": i % 2 === 0 ? "SNAV" : "MEDMAR",
        "TIPO": i % 2 === 0 ? "ANDATA" : "RITORNO",
        "ORARIO DI ARRIVO": "",
        "COMPAGNIA NAVE": i % 2 === 0 ? "SNAV" : "MEDMAR",
        "ORARIO NAVE": "16:20",
        "DA": i % 2 === 0 ? "CASAMICCIOLA" : "COLELLA",
        "A": i % 2 === 0 ? "COLELLA" : "CASAMICCIOLA",
        "CELLULARE": `3340000${i}`,
      }));
    }
    for (let i = 0; i < 11; i += 1) {
      rows.push(row({
        "NOME": `ESC ${i}`,
        "CATEGORIA": "ESCURSIONE",
        "SERVIZIO": "ESCURSIONE",
        "TIPO": i % 2 === 0 ? "ANDATA" : "RITORNO",
        "ORARIO DI ARRIVO": "",
        "ORARIO DI PARTENZA": "09:30",
        "DA": i % 2 === 0 ? "PARCO AURORA" : "MORTELLA",
        "A": i % 2 === 0 ? "MORTELLA" : "PARCO AURORA",
        "CELLULARE": `3350000${i}`,
      }));
    }

    const parsed = parseOperationalV2Rows(rows);
    expect(parsed.summary.service_rows).toBe(38);
    expect(parsed.summary.transfer_count).toBe(12);
    expect(parsed.summary.ferry_formula_count).toBe(15);
    expect(parsed.summary.excursion_count).toBe(11);
  });

  it("classifica AEROPORTO HOTEL ANDATA", () => {
    const parsed = parseOperationalV2Rows([row()]);
    const first = parsed.rows[0];

    expect(first.classification.direction).toBe("arrival");
    expect(first.classification.booking_service_kind).toBe("transfer_airport_hotel");
    expect(first.classification.operational_target).toBe("bruno");
    expect(first.classification.requires_db_rules).toBe(true);
  });

  it("classifica STAZIONE HOTEL ANDATA senza Bruno automatico", () => {
    const parsed = parseOperationalV2Rows([
      row({
        "SERVIZIO": "STAZIONE HOTEL",
        "VOLO NUMERO": "FRECCIAROSSA",
        "DA": "STAZIONE",
        "A": "COLELLA",
      }),
    ]);
    const first = parsed.rows[0];

    expect(first.classification.direction).toBe("arrival");
    expect(first.classification.booking_service_kind).toBe("transfer_train_hotel");
    expect(first.classification.operational_target).toBe("continent_dispatch");
  });

  it("classifica STAZIONE HOTEL RITORNO con orario di partenza e regole DB richieste", () => {
    const parsed = parseOperationalV2Rows([
      row({
        "SERVIZIO": "STAZIONE HOTEL",
        "TIPO": "RITORNO",
        "ORARIO DI ARRIVO": "",
        "ORARIO DI PARTENZA": "14:30",
        "VOLO NUMERO": "FRECCIAROSSA",
        "DA": "LA VILLA",
        "A": "STAZIONE",
      }),
    ]);
    const first = parsed.rows[0];

    expect(first.classification.direction).toBe("departure");
    expect(first.normalized.departure_time).toBe("14:30");
    expect(first.classification.booking_service_kind).toBe("transfer_hotel_train");
    expect(first.classification.requires_db_rules).toBe(true);
  });

  it("NOTE con 'ALISCAFO' esplicito su AEROPORTO HOTEL -> transfer_airport_hotel_aliscafo", () => {
    const parsed = parseOperationalV2Rows([
      row({
        "SERVIZIO": "AEROPORTO HOTEL",
        "TIPO": "ANDATA",
        "NOTE": "SUPPL. ALISCAFO richiesto",
      }),
    ]);
    expect(parsed.rows[0].classification.booking_service_kind).toBe("transfer_airport_hotel_aliscafo");
  });

  it("NOTE con 'aliscafo' esplicito su STAZIONE HOTEL RITORNO -> transfer_hotel_train_aliscafo (collassato poi a transfer_train_hotel_aliscafo dall'import route)", () => {
    const parsed = parseOperationalV2Rows([
      row({
        "SERVIZIO": "STAZIONE HOTEL",
        "TIPO": "RITORNO",
        "ORARIO DI ARRIVO": "",
        "ORARIO DI PARTENZA": "14:30",
        "NOTE": "aliscafo per rientro",
      }),
    ]);
    expect(parsed.rows[0].classification.booking_service_kind).toBe("transfer_hotel_train_aliscafo");
  });

  it("solo 'SNAV' in COMPAGNIA NAVE su un transfer AEROPORTO HOTEL -> NON transfer_airport_hotel_aliscafo (SNAV non affidabile da solo)", () => {
    const parsed = parseOperationalV2Rows([
      row({
        "SERVIZIO": "AEROPORTO HOTEL",
        "TIPO": "ANDATA",
        "COMPAGNIA NAVE": "SNAV",
        "NOTE": "",
      }),
    ]);
    expect(parsed.rows[0].classification.booking_service_kind).toBe("transfer_airport_hotel");
  });

  it("solo 'MEDMAR' in NOTE -> NON transfer_train_hotel_aliscafo", () => {
    const parsed = parseOperationalV2Rows([
      row({
        "SERVIZIO": "STAZIONE HOTEL",
        "TIPO": "ANDATA",
        "NOTE": "MEDMAR confermato",
      }),
    ]);
    expect(parsed.rows[0].classification.booking_service_kind).toBe("transfer_train_hotel");
  });

  it("NOTE ambigua (nessuna parola pertinente) -> resta standard, non aliscafo", () => {
    const parsed = parseOperationalV2Rows([
      row({
        "SERVIZIO": "AEROPORTO HOTEL",
        "TIPO": "ANDATA",
        "NOTE": "cliente VIP camera vista mare",
      }),
    ]);
    expect(parsed.rows[0].classification.booking_service_kind).toBe("transfer_airport_hotel");
  });

  it("AGENZIA 'sosandra'/dimhotels non cambia automaticamente il kind solo per nome agenzia", () => {
    const parsed = parseOperationalV2Rows([
      row({
        "SERVIZIO": "AEROPORTO HOTEL",
        "TIPO": "ANDATA",
        "AGENZIA": "DIMHOTELS SOSANDRA",
        "NOTE": "",
      }),
    ]);
    expect(parsed.rows[0].classification.booking_service_kind).toBe("transfer_airport_hotel");
  });

  it("classifica SNAV ANDATA come island_only", () => {
    const parsed = parseOperationalV2Rows([
      row({
        "CATEGORIA": "FORMULA NAVE",
        "SERVIZIO": "SNAV",
        "COMPAGNIA NAVE": "SNAV",
        "ORARIO NAVE": "16:20",
        "ORARIO DI ARRIVO": "",
        "DA": "CASAMICCIOLA",
        "A": "COLELLA",
      }),
    ]);
    const first = parsed.rows[0];

    expect(first.classification.booking_service_kind).toBe("formula_snav");
    expect(first.classification.operational_target).toBe("island_only");
    expect(first.classification.operational_target).not.toBe("bruno");
  });

  it("classifica MEDMAR RITORNO come formula medmar unknown e island_only", () => {
    const parsed = parseOperationalV2Rows([
      row({
        "CATEGORIA": "FORMULA NAVE",
        "SERVIZIO": "MEDMAR",
        "TIPO": "RITORNO",
        "COMPAGNIA NAVE": "MEDMAR",
        "ORARIO NAVE": "11:50",
        "ORARIO DI ARRIVO": "",
        "ORARIO DI PARTENZA": "",
        "DA": "COLELLA",
        "A": "CASAMICCIOLA",
      }),
    ]);
    const first = parsed.rows[0];

    expect(first.classification.direction).toBe("departure");
    expect(first.classification.booking_service_kind).toBe("formula_medmar_unknown");
    expect(first.classification.operational_target).toBe("island_only");
    expect(first.classification.requires_db_rules).toBe(true);
  });

  it("classifica escursione andata e ritorno", () => {
    const parsed = parseOperationalV2Rows([
      row({
        "CATEGORIA": "ESCURSIONE",
        "SERVIZIO": "ESCURSIONE",
        "TIPO": "ANDATA",
        "ORARIO DI ARRIVO": "",
        "ORARIO DI PARTENZA": "09:30",
        "DA": "PARCO AURORA",
        "A": "MORTELLA",
      }),
      row({
        "CATEGORIA": "ESCURSIONE",
        "SERVIZIO": "ESCURSIONE",
        "TIPO": "RITORNO",
        "ORARIO DI ARRIVO": "",
        "ORARIO DI PARTENZA": "13:00",
        "DA": "MORTELLA",
        "A": "PARCO AURORA",
      }),
    ]);

    expect(parsed.rows[0].classification.booking_service_kind).toBe("excursion");
    expect(parsed.rows[0].classification.operational_target).toBe("excursion");
    expect(parsed.rows[0].classification.direction).toBe("excursion_outbound");
    expect(parsed.rows[1].classification.direction).toBe("excursion_return");
  });

  it("gestisce CAM 320 come riferimento camera non bloccante", () => {
    const parsed = parseOperationalV2Rows([row({ "NOME": "CAM 320" })]);
    const first = parsed.rows[0];

    expect(first.normalized.customer_name).toBe("CAM 320");
    expect(first.classification.is_room_reference_name).toBe(true);
    expect(first.warnings).toContain("Nome cliente non disponibile: usato riferimento camera");
    expect(first.status).not.toBe("blocking_error");
  });

  it("gestisce cellulare mancante con 0000 e warning non bloccante", () => {
    const parsed = parseOperationalV2Rows([row({ "CELLULARE": "" })]);
    const first = parsed.rows[0];

    expect(first.normalized.phone).toBe("0000");
    expect(first.warnings).toContain("Telefono mancante: impostato 0000");
    expect(first.status).not.toBe("blocking_error");
  });

  it("blocca pax mancante", () => {
    const parsed = parseOperationalV2Rows([row({ "NUMERO PAX": "" })]);

    expect(parsed.rows[0].status).toBe("blocking_error");
    expect(parsed.rows[0].errors).toContain("NUMERO PAX mancante o non valido");
  });

  it("marca categoria sconosciuta come needs_review", () => {
    const parsed = parseOperationalV2Rows([row({ "CATEGORIA": "ALTRO" })]);

    expect(parsed.rows[0].classification.category).toBe("UNKNOWN");
    expect(parsed.rows[0].status).toBe("needs_review");
  });

  it("segnala duplicato interno file", () => {
    const parsed = parseOperationalV2Rows([row(), row()]);

    expect(parsed.rows[0].warnings).toContain("Possibile duplicato nel file");
    expect(parsed.rows[1].warnings).toContain("Possibile duplicato nel file");
    expect(parsed.rows[0].status).toBe("warning");
  });

  it("ignora righe vuote finali senza contarle come errori", () => {
    const parsed = parseOperationalV2Rows([
      row({ "NOME": "CLIENTE UNO", "CELLULARE": "3331111111" }),
      row({ "NOME": "CLIENTE DUE", "CELLULARE": "3332222222" }),
      {},
      {
        "DATA": "",
        "ORARIO DI ARRIVO": "",
        "ORARIO DI PARTENZA": "",
        "COMPAGNIA NAVE": "",
        "ORARIO NAVE": "",
        "NUMERO PAX": "",
        "AGENZIA": "",
        "VOLO NUMERO": "",
        "DA": "",
        "A": "",
        "NOME": "",
        "CELLULARE": "",
        "NOTE": "",
        "SERVIZIO": "",
        "CATEGORIA": "",
        "TIPO": "",
      },
      {
        "DATA": null,
        "ORARIO DI ARRIVO": null,
        "ORARIO DI PARTENZA": null,
        "COMPAGNIA NAVE": null,
        "ORARIO NAVE": null,
        "NUMERO PAX": null,
        "AGENZIA": null,
        "VOLO NUMERO": null,
        "DA": null,
        "A": null,
        "NOME": null,
        "CELLULARE": null,
        "NOTE": null,
        "SERVIZIO": null,
        "CATEGORIA": null,
        "TIPO": null,
      },
    ]);

    expect(parsed.summary.total_rows).toBe(5);
    expect(parsed.summary.service_rows).toBe(2);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.summary.blocking_error_count).toBe(0);
  });

  it("non ignora una riga parziale con dati reali mancanti", () => {
    const parsed = parseOperationalV2Rows([
      {
        "NOME": "CLIENTE PARZIALE",
      },
    ]);

    expect(parsed.summary.service_rows).toBe(1);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].status).toBe("blocking_error");
    expect(parsed.rows[0].errors).toContain("DATA mancante o non valida");
    expect(parsed.rows[0].errors).toContain("CATEGORIA mancante");
  });

  it("ignora una riga composta solo da spazi", () => {
    const parsed = parseOperationalV2Rows([
      {
        "DATA": "   ",
        "ORARIO DI ARRIVO": " ",
        "ORARIO DI PARTENZA": " ",
        "COMPAGNIA NAVE": " ",
        "ORARIO NAVE": " ",
        "NUMERO PAX": " ",
        "AGENZIA": " ",
        "VOLO NUMERO": " ",
        "DA": " ",
        "A": " ",
        "NOME": " ",
        "CELLULARE": " ",
        "NOTE": " ",
        "SERVIZIO": " ",
        "CATEGORIA": " ",
        "TIPO": " ",
      },
    ]);

    expect(parsed.summary.service_rows).toBe(0);
    expect(parsed.rows).toHaveLength(0);
    expect(parsed.summary.blocking_error_count).toBe(0);
  });
});
