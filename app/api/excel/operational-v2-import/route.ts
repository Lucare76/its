import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  buildOperationalV2ServerPreview,
  operationalV2DbRowStatus,
  type OperationalV2ServerPreviewRow,
} from "@/lib/server/operational-v2-server-preview";
import { authorizePricingRequest, type PricingAuthContext } from "@/lib/server/pricing-auth";
import type { OperationalV2PreviewRow } from "@/lib/operational-excel-normalize";

export const runtime = "nodejs";

const payloadSchema = z.object({
  rows: z.array(z.record(z.string(), z.unknown())).min(1).max(1000),
});

const VALID_BOOKING_KINDS = new Set([
  "transfer_port_hotel",
  "transfer_airport_hotel",
  "transfer_airport_hotel_exclusive",
  "transfer_airport_hotel_aliscafo",
  "transfer_train_hotel",
  "transfer_train_hotel_exclusive",
  "transfer_train_hotel_aliscafo",
  "bus_city_hotel",
  "excursion",
  "formula_snav",
  "formula_medmar_napoli",
  "formula_medmar_pozzuoli",
  "transfer_hotel_hotel",
  "shuttle_hotel",
  "private_island",
  "navetta",
]);

function normalizeText(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isIslandPort(value: string | null) {
  const normalized = normalizeText(value);
  return normalized === "casamicciola"
    || normalized === "ischia porto"
    || normalized === "porto ischia"
    || normalized === "ischia";
}

function hasCasamicciola(...values: Array<string | null | undefined>) {
  return values.some((value) => normalizeText(value).includes("casamicciola"));
}

function dbBookingKind(row: OperationalV2PreviewRow, serverRow: OperationalV2ServerPreviewRow) {
  const proposed = row.classification.booking_service_kind;
  if (proposed === "transfer_hotel_airport") return "transfer_airport_hotel";
  if (proposed === "transfer_hotel_train") return "transfer_train_hotel";
  if (proposed === "formula_medmar_unknown") {
    return hasCasamicciola(row.normalized.from, row.normalized.to, serverRow.computed.porto_bruno)
      ? "formula_medmar_pozzuoli"
      : "formula_medmar_napoli";
  }
  if (proposed && VALID_BOOKING_KINDS.has(proposed)) return proposed;
  return null;
}

function serviceTypeCode(kind: string, category: string) {
  if (category === "ESCURSIONE") return "excursion";
  if (kind.includes("airport")) return "transfer_airport_hotel";
  if (kind.includes("train")) return "transfer_station_hotel";
  if (kind.startsWith("formula_")) return "ferry_transfer";
  return "transfer_port_hotel";
}

function placeType(kind: string) {
  if (kind.includes("airport")) return "airport";
  if (kind.includes("train")) return "station";
  return "hotel";
}

function dbDirection(row: OperationalV2PreviewRow) {
  if (row.classification.direction === "arrival") return "arrival";
  if (row.classification.direction === "departure") return "departure";
  if (row.classification.direction === "excursion_return") return "arrival";
  if (row.classification.direction === "excursion_outbound") return "departure";
  if (isIslandPort(row.normalized.from) && !isIslandPort(row.normalized.to)) return "arrival";
  return "departure";
}

function operationalTime(row: OperationalV2PreviewRow, serverRow: OperationalV2ServerPreviewRow, direction: "arrival" | "departure") {
  if (row.classification.category === "ESCURSIONE") {
    return row.normalized.departure_time;
  }
  if (row.classification.category === "TRANSFER" && direction === "arrival") {
    return serverRow.computed.arrival_at_ischia ?? row.normalized.arrival_time;
  }
  if (row.classification.category === "TRANSFER" && direction === "departure") {
    return serverRow.computed.pickup_hotel ?? row.normalized.departure_time;
  }
  if (row.classification.category === "FORMULA_NAVE" && direction === "arrival") {
    return serverRow.computed.arrival_at_ischia ?? row.normalized.ferry_time;
  }
  if (row.classification.category === "FORMULA_NAVE" && direction === "departure") {
    return serverRow.computed.pickup_hotel ?? row.normalized.ferry_time;
  }
  return row.normalized.departure_time ?? row.normalized.arrival_time ?? row.normalized.ferry_time;
}

function sourceTime(row: OperationalV2PreviewRow, direction: "arrival" | "departure") {
  if (row.classification.category === "FORMULA_NAVE") return row.normalized.ferry_time;
  if (row.classification.category === "ESCURSIONE") return row.normalized.departure_time;
  return direction === "arrival" ? row.normalized.arrival_time : row.normalized.departure_time;
}

function serviceVessel(row: OperationalV2PreviewRow, serverRow: OperationalV2ServerPreviewRow) {
  if (row.classification.category === "ESCURSIONE") return row.normalized.service ?? "Escursione";
  if (row.classification.category === "FORMULA_NAVE") {
    return serverRow.computed.barca_compagnia ?? row.normalized.ferry_company ?? row.normalized.service ?? "Formula nave";
  }
  return row.normalized.flight_or_train_number
    ?? serverRow.computed.nave_db
    ?? row.normalized.service
    ?? "Transfer";
}

function sourceDetails(row: OperationalV2PreviewRow, serverRow: OperationalV2ServerPreviewRow) {
  return {
    template_kind: "operational_v2",
    row_number: row.row_number,
    category: row.normalized.category,
    service: row.normalized.service,
    trip_type: row.normalized.trip_type,
    from: row.normalized.from,
    to: row.normalized.to,
    source_arrival_time: row.normalized.arrival_time,
    source_departure_time: row.normalized.departure_time,
    source_ferry_time: row.normalized.ferry_time,
    ferry_company: row.normalized.ferry_company,
    flight_or_train_number: row.normalized.flight_or_train_number,
    db_computed: serverRow.computed,
  };
}

function rowImportLabel(row: OperationalV2PreviewRow) {
  return [
    row.normalized.date,
    row.normalized.category,
    row.normalized.service,
    row.normalized.trip_type,
    row.normalized.customer_name,
    row.normalized.agency,
    row.normalized.pax ? `${row.normalized.pax} pax` : null,
  ].filter(Boolean).join(" - ");
}

function missingSchemaColumn(message: string) {
  return message.match(/Could not find the '([^']+)' column/)?.[1] ?? null;
}

async function insertServicesWithSchemaFallback(
  admin: PricingAuthContext["admin"],
  payloads: Record<string, unknown>[],
) {
  const omittedColumns: string[] = [];
  let currentPayloads = payloads;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await admin
      .from("services")
      .insert(currentPayloads)
      .select("id");

    if (!result.error) return { ...result, omittedColumns };

    const missingColumn = missingSchemaColumn(result.error.message);
    if (!missingColumn) return { ...result, omittedColumns };

    omittedColumns.push(missingColumn);
    currentPayloads = currentPayloads.map(({ [missingColumn]: _omitted, ...payload }) => payload);
  }

  return {
    data: null,
    error: new Error(`Schema cache non allineata: troppe colonne mancanti (${omittedColumns.join(", ")}).`),
    omittedColumns,
  };
}

function buildServicePayload(
  tenantId: string,
  row: OperationalV2PreviewRow,
  serverRow: OperationalV2ServerPreviewRow,
) {
  const kind = dbBookingKind(row, serverRow);
  if (!kind) return { error: `Riga ${row.row_number}: booking kind non supportato (${row.classification.booking_service_kind ?? "vuoto"}).` };
  if (!row.normalized.date) return { error: `Riga ${row.row_number}: data non disponibile.` };
  if (!row.normalized.customer_name) return { error: `Riga ${row.row_number}: cliente non disponibile.` };
  if (!row.normalized.pax) return { error: `Riga ${row.row_number}: pax non disponibile.` };
  if (row.normalized.pax > 500) return { error: `Pax ${row.normalized.pax} supera il limite DB servizi (500).` };

  const direction = dbDirection(row);
  const time = operationalTime(row, serverRow, direction);
  if (!time) return { error: `Riga ${row.row_number}: orario operativo non disponibile.` };

  const source = sourceTime(row, direction);
  const code = serviceTypeCode(kind, row.classification.category);
  const details = sourceDetails(row, serverRow);
  const notes = [
    row.normalized.notes,
    `Import operational_v2 riga ${row.row_number}`,
  ].filter(Boolean).join("\n");

  const payload: Record<string, unknown> = {
    tenant_id: tenantId,
    is_draft: false,
    status: "new",
    date: row.normalized.date,
    time,
    service_type: row.classification.category === "ESCURSIONE" ? "bus_tour" : "transfer",
    direction,
    vessel: serviceVessel(row, serverRow),
    pax: row.normalized.pax,
    hotel_id: serverRow.hotel_match?.id ?? null,
    customer_name: row.normalized.customer_name,
    billing_party_name: serverRow.agency_match?.name ?? row.normalized.agency,
    agency_id: serverRow.agency_match?.id ?? null,
    phone: row.normalized.phone || "0000",
    notes,
    meeting_point: row.normalized.from,
    booking_service_kind: kind,
    service_type_code: code,
    place_type: placeType(kind),
    transport_code: row.normalized.flight_or_train_number,
    pickup_hotel: serverRow.computed.pickup_hotel,
    barca_compagnia: serverRow.computed.barca_compagnia,
    orario_barca: serverRow.computed.orario_barca,
    porto_bruno: serverRow.computed.porto_bruno,
    ferry_details: details,
    excursion_details: {},
  };

  if (row.classification.category === "ESCURSIONE") {
    payload.tour_name = row.normalized.service ?? "Escursione";
    payload.excursion_details = details;
  }

  if (direction === "arrival") {
    payload.arrival_date = row.normalized.date;
    payload.arrival_time = source ?? time;
  } else {
    payload.departure_date = row.normalized.date;
    payload.departure_time = source ?? time;
  }

  if (kind.includes("train")) {
    if (direction === "arrival") {
      payload.train_arrival_number = row.normalized.flight_or_train_number;
      payload.train_arrival_time = row.normalized.arrival_time;
    } else {
      payload.train_departure_number = row.normalized.flight_or_train_number;
      payload.train_departure_time = row.normalized.departure_time;
    }
  }

  return { payload };
}

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator"]);
  if (auth instanceof NextResponse) return auth;

  const parsed = payloadSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: parsed.error.issues[0]?.message ?? "Payload non valido." }, { status: 400 });
  }

  try {
    const preview = await buildOperationalV2ServerPreview(auth, parsed.data.rows);
    const tenantId = auth.membership.tenant_id;
    const blocking: Array<{ row_number: number; message: string }> = [];
    const payloads: Record<string, unknown>[] = [];

    preview.rows.forEach((serverRow, index) => {
      const row = preview.parser_preview.rows[index];
      if (!row) {
        blocking.push({ row_number: serverRow.row_number, message: "Riga parser non trovata." });
        return;
      }

      const status = operationalV2DbRowStatus(serverRow, row);
      if (status === "blocking_error" || status === "needs_review") {
        blocking.push({
          row_number: row.row_number,
          message: [...row.errors, ...serverRow.errors, ...row.warnings, ...serverRow.warnings].join("; ") || "Riga da verificare.",
        });
        return;
      }
      if (serverRow.duplicate_service_ids.length > 0) {
        blocking.push({ row_number: row.row_number, message: "Possibile duplicato gia presente nel DB." });
        return;
      }

      const built = buildServicePayload(tenantId, row, serverRow);
      if ("error" in built) {
        const label = rowImportLabel(row);
        blocking.push({
          row_number: row.row_number,
          message: `${label ? `${label}: ` : ""}${built.error ?? "Riga non importabile."}`,
        });
        return;
      }
      payloads.push(built.payload);
    });

    if (blocking.length > 0) {
      return NextResponse.json(
        {
          ok: false,
          error: "Import bloccato: ci sono righe da verificare, errori o duplicati DB.",
          blocking,
          summary: preview.summary,
        },
        { status: 409 }
      );
    }

    if (payloads.length === 0) {
      return NextResponse.json({ ok: false, error: "Nessuna riga importabile." }, { status: 400 });
    }

    const { data, error, omittedColumns } = await insertServicesWithSchemaFallback(auth.admin, payloads);

    if (error) {
      return NextResponse.json(
        {
          ok: false,
          error: `Import bloccato dal DB: ${error.message}`,
          summary: preview.summary,
        },
        { status: 409 }
      );
    }

    const serviceIds = (data ?? []).map((item) => String(item.id));
    if (serviceIds.length > 0) {
      await auth.admin.from("status_events").insert(serviceIds.map((serviceId) => ({
        tenant_id: tenantId,
        service_id: serviceId,
        status: "new",
        by_user_id: auth.user.id,
      })));
    }

    return NextResponse.json({
      ok: true,
      template_kind: "operational_v2",
      summary: {
        imported_rows: serviceIds.length,
        status_events_created: serviceIds.length,
        assignments_created: 0,
        trip_groups_created: 0,
        omitted_schema_columns: omittedColumns,
      },
      service_ids: serviceIds,
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Import operational_v2 non riuscito." },
      { status: 500 }
    );
  }
}
