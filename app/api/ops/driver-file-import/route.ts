import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { resolveHotelMatch } from "@/lib/server/hotel-matching";
import { extractFeatures, logAssignmentChange, type AssignmentHistoryEntry } from "@/lib/server/assignment-history";
import { updateLearnedPatterns } from "@/lib/server/learned-patterns";
import { auditLog } from "@/lib/server/ops-audit";
import { verifyDriverBelongsToTenant, verifyDriverIsOperational } from "@/lib/server/assign-service-core";

export const runtime = "nodejs";

type HotelRow = {
  id: string;
  name: string;
  normalized_name?: string | null;
  aliases?: string[];
};

type ParsedDriverFileRow = {
  row_index: number;
  source_driver_name: string;
  time: string;
  reference: string;
  pax: number;
  pax_raw: string;
  service_type_label: string;
  billing_party_name: string;
  origin: string;
  destination: string;
  extra_1: string;
  extra_2: string;
  customer_raw: string;
};

type ParsedCustomerContact = {
  customerName: string;
  phone: string;
};

type PreviewRow = {
  row_index: number;
  time: string;
  direction: "arrival" | "departure";
  service_visual_kind: "arrival" | "departure" | "excursion";
  service_type_label: string;
  billing_party_name: string;
  hotel_name: string;
  meeting_point: string;
  pax: number;
  transport_code: string;
  notes: string;
};

const payloadSchema = z.object({
  service_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  driver_user_id: z.string().uuid(),
  dry_run: z.boolean().default(true)
});

function normalizeText(value: string | null | undefined) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function parseTimeCell(value: string) {
  const raw = value.trim();
  if (!raw) return "";
  const compact = raw.replace(".", ":");
  const hhmmss = compact.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (hhmmss) return `${hhmmss[1].padStart(2, "0")}:${hhmmss[2]}`;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 4) return `${digits.slice(0, 2)}:${digits.slice(2, 4)}`;
  if (digits.length === 3) return `0${digits[0]}:${digits.slice(1, 3)}`;
  return "";
}

function parsePax(value: string) {
  const digits = value.replace(/[^\d]/g, "");
  return digits ? Number(digits) : 0;
}

function normalizeBillingPartyName(value: string) {
  const raw = value.trim();
  const normalized = normalizeText(raw);
  if (normalized === "ischia enjoy" || normalized === "ischia enoy") return "Aleste Viaggi";
  return raw;
}

function isPortMeetingPoint(value: string) {
  const normalized = normalizeText(value);
  return normalized === "casamicciola"
    || normalized === "porto di casamicciola"
    || normalized === "porto casamicciola"
    || normalized === "casamicciola porto";
}

function normalizeImportedLocationAlias(value: string) {
  const raw = value.trim();
  const normalized = normalizeText(raw);

  if (
    normalized === "porto di casamicciola" ||
    normalized === "porto casamicciola" ||
    normalized === "porto di casamicciola terme" ||
    normalized === "porto casamicciola terme"
  ) {
    return "Casamicciola";
  }

  return raw;
}

function isMeaningfulReference(value: string) {
  const normalized = normalizeText(value);
  return Boolean(
    normalized &&
    normalized !== "arrivo" &&
    normalized !== "partenza" &&
    normalized !== "navetta" &&
    normalized !== "escursione" &&
    normalized !== "escursioni"
  );
}

function isExcursionRow(rawType: string, reference: string) {
  const type = normalizeText(rawType);
  const ref = normalizeText(reference);

  if (type.startsWith("escursion")) return true;

  return /capri|procida|giro isola|escurs|amalfi|positano|pompei|sorrento|caserta|napoli|mortella|nitrodi|castello|crateri|cooking/.test(ref);
}

function inferDirection(rawType: string, reference: string, origin: string, destination: string): "arrival" | "departure" {
  const type = normalizeText(rawType);
  if (isExcursionRow(rawType, reference)) return "departure";
  if (type === "arrivo" || type === "arrival") return "arrival";
  if (type === "partenza" || type === "departure") return "departure";

  const originIsPortMeetingPoint = isPortMeetingPoint(origin);
  const destinationIsPortMeetingPoint = isPortMeetingPoint(destination);
  if (originIsPortMeetingPoint && !destinationIsPortMeetingPoint) return "arrival";
  if (!originIsPortMeetingPoint && destinationIsPortMeetingPoint) return "departure";

  const originNorm = normalizeText(origin);
  const destinationNorm = normalizeText(destination);
  const hotelHints = /\bhtl\b|\bhotel\b|cristallo|president|augusto|valentino|verde|felix|bellevue|colella|imperial|villa|terme|castello|coco/;
  const transportHints = /\bstz\b|porto|piazza|p zza|bar|snav|medmar|alilauro|gestour|n gestour|fr \d|ic \d|italo|apt\b/;

  if (hotelHints.test(originNorm) && transportHints.test(destinationNorm)) return "departure";
  if (transportHints.test(originNorm) && hotelHints.test(destinationNorm)) return "arrival";
  if (hotelHints.test(originNorm) && !hotelHints.test(destinationNorm)) return "departure";
  if (!hotelHints.test(originNorm) && hotelHints.test(destinationNorm)) return "arrival";
  return "departure";
}

function inferServiceVisualKind(rawType: string, reference: string): "arrival" | "departure" | "excursion" {
  const type = normalizeText(rawType);
  if (isExcursionRow(rawType, reference) || type === "excursion") return "excursion";
  if (type === "arrivo" || type === "arrival") return "arrival";
  return "departure";
}

function resolveImportedHotelAndMeetingPoint(
  direction: "arrival" | "departure",
  origin: string,
  destination: string
) {
  const normalizedOrigin = normalizeImportedLocationAlias(origin);
  const normalizedDestination = normalizeImportedLocationAlias(destination);
  const originIsPort = isPortMeetingPoint(origin);
  const destinationIsPort = isPortMeetingPoint(destination);

  if (originIsPort && !destinationIsPort) {
    return {
      hotelName: normalizedDestination,
      meetingPoint: origin.trim(),
    };
  }

  if (destinationIsPort && !originIsPort) {
    return {
      hotelName: normalizedOrigin,
      meetingPoint: destination.trim(),
    };
  }

  return {
    hotelName: direction === "arrival" ? normalizedDestination : normalizedOrigin,
    meetingPoint: direction === "arrival" ? origin.trim() : destination.trim(),
  };
}

function buildNotes(row: ParsedDriverFileRow, serviceVisualKind: "arrival" | "departure" | "excursion") {
  const parts = [
    row.extra_1.trim(),
    row.extra_2.trim(),
    row.pax_raw.trim() && row.pax === 0 ? `Pax file: ${row.pax_raw.trim()}` : "",
    row.source_driver_name.trim() ? `Autista file: ${row.source_driver_name.trim()}` : "",
    serviceVisualKind !== "arrival" && row.service_type_label.trim() ? `Tipo file: ${row.service_type_label.trim()}` : ""
  ].filter(Boolean);
  return parts.join(" | ");
}

function extractCustomerRaw(row: string[]) {
  for (let index = row.length - 1; index >= 0; index -= 1) {
    const value = String(row[index] ?? "").trim();
    if (!value) continue;
    const normalized = normalizeText(value);
    if (normalized === "its" || normalized === "bruno") continue;
    return value;
  }
  return "";
}

function looksLikeTimeOrCode(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  if (/^\d{1,2}:\d{2}$/.test(normalized)) return true;
  if (/^\d{1,2}:\d{2}\s+[a-z]+/.test(normalized)) return true;
  if (/^(fr|ic|fb|az|u2|km)\s*\d+/i.test(normalized)) return true;
  return false;
}

function parseCustomerContact(value: string): ParsedCustomerContact {
  const raw = value.trim();
  if (!raw) return { customerName: "", phone: "" };

  const phoneMatch = raw.match(/(?:\+?\d[\d\s./-]{6,}\d)/);
  const phone = phoneMatch ? phoneMatch[0].replace(/[^\d+]/g, "") : "";
  const baseName = phoneMatch
    ? raw.replace(phoneMatch[0], "").replace(/\s+/g, " ").trim()
    : raw;
  const customerName = baseName
    .replace(/\bTRF\b.*$/i, "")
    .replace(/\bTRAGHETTO\b.*$/i, "")
    .replace(/\bTRANSFER\b.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();

  return { customerName, phone };
}

function resolveCustomerContact(row: ParsedDriverFileRow): ParsedCustomerContact {
  const customerRaw = row.customer_raw.trim();
  if (customerRaw && !looksLikeTimeOrCode(customerRaw)) {
    const parsed = parseCustomerContact(customerRaw);
    if (parsed.customerName || parsed.phone) return parsed;
  }

  const extra2 = row.extra_2.trim();
  if (extra2 && !looksLikeTimeOrCode(extra2)) {
    const parsed = parseCustomerContact(extra2);
    if (parsed.customerName || parsed.phone) return parsed;
  }

  const extra1 = row.extra_1.trim();
  if (extra1 && !looksLikeTimeOrCode(extra1)) {
    const parsed = parseCustomerContact(extra1);
    if (parsed.customerName || parsed.phone) return parsed;
  }

  const billingParty = row.billing_party_name.trim();
  if (billingParty) return { customerName: billingParty, phone: "" };

  const reference = row.reference.trim();
  if (reference && !looksLikeTimeOrCode(reference) && isMeaningfulReference(reference)) {
    return { customerName: reference, phone: "" };
  }

  return { customerName: `Servizio autista riga ${row.row_index}`, phone: "" };
}

function parseRowsFromSheet(rows: string[][]) {
  return rows
    .map((row, index) => ({
      row_index: index + 1,
      source_driver_name: String(row[0] ?? "").trim(),
      time: parseTimeCell(String(row[1] ?? "").trim()),
      reference: String(row[2] ?? "").trim(),
      pax: parsePax(String(row[3] ?? "").trim()),
      pax_raw: String(row[3] ?? "").trim(),
      service_type_label: String(row[4] ?? "").trim(),
      billing_party_name: normalizeBillingPartyName(String(row[5] ?? "").trim()),
      origin: String(row[6] ?? "").trim(),
      destination: String(row[7] ?? "").trim(),
      extra_1: String(row[8] ?? "").trim(),
      extra_2: String(row[9] ?? "").trim(),
      customer_raw: extractCustomerRaw(row)
    }))
    .filter((row) => {
      const joined = normalizeText([
        row.source_driver_name,
        row.time,
        row.reference,
        row.pax_raw,
        row.service_type_label,
        row.billing_party_name,
        row.origin,
        row.destination
      ].join(" "));

      const looksLikeHeader =
        joined.includes("autista") &&
        joined.includes("time") &&
        joined.includes("origine") &&
        joined.includes("destinazione");

      return !looksLikeHeader;
    })
    .filter((row) => Object.values(row).some((value) => String(value ?? "").trim()));
}

export async function POST(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;

    const formData = await request.formData();
    const payload = payloadSchema.safeParse({
      service_date: String(formData.get("service_date") ?? ""),
      driver_user_id: String(formData.get("driver_user_id") ?? ""),
      dry_run: String(formData.get("dry_run") ?? "true") !== "false"
    });

    if (!payload.success) {
      return NextResponse.json({ error: payload.error.issues[0]?.message ?? "Payload non valido." }, { status: 400 });
    }

    const file = formData.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "File Excel mancante." }, { status: 400 });
    }

    const workbook = XLSX.read(Buffer.from(await file.arrayBuffer()), { type: "buffer" });
    const firstSheetName = workbook.SheetNames[0];
    if (!firstSheetName) {
      return NextResponse.json({ error: "Nessun foglio disponibile nel file." }, { status: 400 });
    }

    const rows = XLSX.utils.sheet_to_json<string[]>(workbook.Sheets[firstSheetName], { header: 1, raw: false, defval: "" }) as string[][];
    const parsedRows = parseRowsFromSheet(rows);

    const { data: hotels, error: hotelsError } = await auth.admin
      .from("hotels")
      .select("id, name, normalized_name")
      .eq("tenant_id", auth.membership.tenant_id)
      .order("name", { ascending: true });

    if (hotelsError) {
      return NextResponse.json({ error: "Errore caricamento hotel per import autista." }, { status: 500 });
    }

    const { data: aliasRows } = await auth.admin
      .from("hotel_aliases")
      .select("hotel_id, alias")
      .eq("tenant_id", auth.membership.tenant_id)
      .limit(5000);

    const aliasesByHotel = new Map<string, string[]>();
    for (const row of (aliasRows ?? []) as Array<{ hotel_id: string; alias: string }>) {
      const bucket = aliasesByHotel.get(row.hotel_id) ?? [];
      bucket.push(row.alias);
      aliasesByHotel.set(row.hotel_id, bucket);
    }

    const hotelRows = ((hotels ?? []) as HotelRow[]).map((hotel) => ({
      ...hotel,
      aliases: aliasesByHotel.get(hotel.id) ?? []
    }));

    const preview: PreviewRow[] = [];
    const errors: Array<{ row_index: number; message: string }> = [];
    const inserts: Array<Record<string, unknown>> = [];

    for (const row of parsedRows) {
      if (!row.time) {
        errors.push({ row_index: row.row_index, message: "Campo time non valido." });
        continue;
      }

      const direction = inferDirection(row.service_type_label || row.reference, row.reference, row.origin, row.destination);
      const serviceVisualKind = inferServiceVisualKind(row.service_type_label || row.reference, row.reference);
      const { hotelName, meetingPoint } = resolveImportedHotelAndMeetingPoint(direction, row.origin, row.destination);
      const transportCode = isMeaningfulReference(row.reference)
        ? row.reference
        : (direction === "arrival" ? row.origin : row.destination);
      const notes = buildNotes(row, serviceVisualKind);
      const customerContact = resolveCustomerContact(row);
      const resolvedHotelId = resolveHotelMatch(hotelRows, hotelName, null);

      if (!resolvedHotelId) {
        errors.push({ row_index: row.row_index, message: `Hotel non riconosciuto: ${hotelName || "vuoto"}` });
        continue;
      }

      const pax = row.pax > 0 ? row.pax : 1;
      const vessel = (isMeaningfulReference(row.reference) ? row.reference : row.service_type_label || "Servizio autista").slice(0, 80);
      const isExcursion = serviceVisualKind === "excursion";
      const bookingServiceKind =
        isExcursion ? "excursion"
        : normalizeText(row.service_type_label) === "navetta" ? "shuttle_hotel"
        : undefined;

      preview.push({
        row_index: row.row_index,
        time: row.time,
        direction,
        service_visual_kind: serviceVisualKind,
        service_type_label: row.service_type_label || "servizio autista",
        billing_party_name: row.billing_party_name,
        hotel_name: hotelName,
        meeting_point: meetingPoint,
        pax,
        transport_code: transportCode.slice(0, 80),
        notes
      });

      inserts.push({
        tenant_id: auth.membership.tenant_id,
        created_by_user_id: auth.user.id,
        is_draft: false,
        // Data Integrity Sprint 7: nasce "new", non più "assigned" — lo
        // status passa ad "assigned" solo dopo che assignments.insert() è
        // confermato riuscito (vedi sotto), altrimenti un fallimento del
        // secondo insert lascerebbe service.status='assigned' senza alcun
        // assignment corrispondente (invariante violata).
        status: "new",
        date: payload.data.service_date,
        time: row.time,
        direction,
        service_type: isExcursion ? "bus_tour" : "transfer",
        vessel,
        pax,
        hotel_id: resolvedHotelId,
        customer_name: customerContact.customerName,
        billing_party_name: row.billing_party_name || null,
        phone: customerContact.phone,
        notes: notes || null,
        meeting_point: meetingPoint || null,
        booking_service_kind: bookingServiceKind ?? null,
        service_type_code: isExcursion ? "excursion" : null,
        arrival_date: direction === "arrival" ? payload.data.service_date : null,
        arrival_time: direction === "arrival" ? row.time : null,
        departure_date: direction === "departure" ? payload.data.service_date : null,
        departure_time: direction === "departure" ? row.time : null,
        transport_code: transportCode.slice(0, 80) || null
      });
    }

    if (payload.data.dry_run) {
      return NextResponse.json({
        ok: true,
        dry_run: true,
        summary: {
          total_rows: parsedRows.length,
          valid_rows: preview.length,
          invalid_rows: errors.length,
          imported_rows: 0
        },
        preview,
        errors
      });
    }

    if (inserts.length === 0) {
      return NextResponse.json({
        error: "Nessuna riga valida da importare.",
        summary: {
          total_rows: parsedRows.length,
          valid_rows: 0,
          invalid_rows: errors.length,
          imported_rows: 0
        },
        preview,
        errors
      }, { status: 400 });
    }

    // Sprint 8: verifica server-side che driver_user_id esista, appartenga
    // al tenant corrente, sia realmente associato a un driver_profile
    // valido e sia operativo — riusa gli stessi helper già validati in
    // assign-service-core.ts (SEC-05/FUNC-03), nessuna nuova regola.
    // Eseguita PRIMA di qualunque insert (services incluso): un driver non
    // valido non deve produrre nemmeno service "new" orfani di destinazione.
    const { data: driverProfileLookup } = await auth.admin
      .from("driver_profiles")
      .select("id")
      .eq("tenant_id", auth.membership.tenant_id)
      .eq("user_id", payload.data.driver_user_id)
      .maybeSingle();
    const driverProfileIdForImport = (driverProfileLookup?.id as string | undefined) ?? null;

    const driverOwnership = await verifyDriverBelongsToTenant(
      auth.admin,
      auth.membership.tenant_id,
      { driverUserId: payload.data.driver_user_id, driverProfileId: driverProfileIdForImport },
      { userId: auth.user.id }
    );
    if (!driverOwnership.ok) {
      auditLog({
        event: "driver_file_import_write_failed",
        level: "error",
        tenantId: auth.membership.tenant_id,
        userId: auth.user.id,
        details: { step: "driver_validation", reason: "driver_not_found_or_wrong_tenant" },
      });
      return NextResponse.json({
        error: "Autista non trovato o non appartenente al tenant corrente.",
        summary: {
          total_rows: parsedRows.length,
          valid_rows: preview.length,
          invalid_rows: errors.length,
          imported_rows: 0
        },
        preview,
        errors
      }, { status: 404 });
    }

    if (!driverProfileIdForImport) {
      auditLog({
        event: "driver_file_import_write_failed",
        level: "error",
        tenantId: auth.membership.tenant_id,
        userId: auth.user.id,
        details: { step: "driver_validation", reason: "no_driver_profile" },
      });
      return NextResponse.json({
        error: "L'autista selezionato non ha un profilo autista valido.",
        summary: {
          total_rows: parsedRows.length,
          valid_rows: preview.length,
          invalid_rows: errors.length,
          imported_rows: 0
        },
        preview,
        errors
      }, { status: 409 });
    }

    const driverOperational = await verifyDriverIsOperational(
      auth.admin,
      auth.membership.tenant_id,
      { driverUserId: payload.data.driver_user_id, driverProfileId: driverProfileIdForImport },
      { userId: auth.user.id }
    );
    if (!driverOperational.ok) {
      auditLog({
        event: "driver_file_import_write_failed",
        level: "error",
        tenantId: auth.membership.tenant_id,
        userId: auth.user.id,
        details: { step: "driver_validation", reason: "driver_not_operational" },
      });
      return NextResponse.json({
        error: "L'autista non è attualmente disponibile per nuove assegnazioni.",
        summary: {
          total_rows: parsedRows.length,
          valid_rows: preview.length,
          invalid_rows: errors.length,
          imported_rows: 0
        },
        preview,
        errors
      }, { status: 409 });
    }

    const { data: insertedServices, error: insertError } = await auth.admin
      .from("services")
      .insert(inserts)
      .select("id");

    if (insertError) {
      return NextResponse.json({
        error: insertError.message,
        summary: {
          total_rows: parsedRows.length,
          valid_rows: preview.length,
          invalid_rows: errors.length,
          imported_rows: 0
        },
        preview,
        errors
      }, { status: 500 });
    }

    const insertedIds = (insertedServices ?? []).map((row) => row.id as string);
    if (insertedIds.length > 0) {
      const assignmentsPayload = insertedIds.map((serviceId) => ({
        tenant_id: auth.membership.tenant_id,
        service_id: serviceId,
        driver_user_id: payload.data.driver_user_id,
        vehicle_label: ""
      }));

      const { error: assignmentsError } = await auth.admin.from("assignments").insert(assignmentsPayload);
      if (assignmentsError) {
        // Data Integrity Sprint 7: i services sono già stati inseriti sopra,
        // ma con status "new" (non più "assigned") — nessun mismatch,
        // restano semplicemente non assegnati. Nessuna compensating delete:
        // cancellare righe services appena create rischierebbe di rompere
        // riferimenti non ancora auditati (Fase 5 dello sprint), mentre
        // restare "new" è uno stato di riposo già valido nel dominio.
        auditLog({
          event: "driver_file_import_write_failed",
          level: "error",
          tenantId: auth.membership.tenant_id,
          userId: auth.user.id,
          details: { step: "assignments_insert", message: assignmentsError.message, serviceCount: insertedIds.length },
        });
        return NextResponse.json({
          error: "Errore durante il salvataggio delle assegnazioni. Nessun servizio è stato importato.",
          summary: {
            total_rows: parsedRows.length,
            valid_rows: preview.length,
            invalid_rows: errors.length,
            imported_rows: 0
          },
          preview,
          errors
        }, { status: 500 });
      }

      // Data Integrity Sprint 7: assignments scritti con successo — ora (e
      // solo ora) lo status passa ad "assigned", con un retry prima di
      // compensare, stesso pattern già in uso in auto-assign/route.ts e
      // piano-giorno/trips/route.ts (Sprint 5/6).
      let statusRes = await auth.admin.from("services").update({ status: "assigned" }).in("id", insertedIds).eq("tenant_id", auth.membership.tenant_id);
      if (statusRes.error) {
        statusRes = await auth.admin.from("services").update({ status: "assigned" }).in("id", insertedIds).eq("tenant_id", auth.membership.tenant_id);
      }
      if (statusRes.error) {
        // Assignment scritto ma status non aggiornabile — mai lasciare
        // "assignment presente + status 'new'" (invariante 2). Questi
        // assignment sono garantiti nuovi (insertedIds sono service_id
        // appena generati in questa stessa richiesta, nessuna riga
        // preesistente può esistere per costruzione): la compensazione è
        // quindi sempre e solo un delete delle righe appena inserite, mai
        // un restore (nessun "CASO B" possibile in questo import).
        const compensateRes = await auth.admin.from("assignments").delete().eq("tenant_id", auth.membership.tenant_id).in("service_id", insertedIds);
        const compensationFailed = Boolean(compensateRes.error);
        auditLog({
          event: "driver_file_import_write_failed",
          level: "error",
          tenantId: auth.membership.tenant_id,
          userId: auth.user.id,
          details: {
            step: "status_update",
            message: statusRes.error.message,
            serviceCount: insertedIds.length,
            compensation_deleted_new: !compensationFailed,
            compensation_failed: compensationFailed,
            compensation_error: compensateRes.error?.message ?? null,
          },
        });
        return NextResponse.json({
          error: compensationFailed
            ? "Errore aggiornamento stato servizi: incoerenza NON risolta automaticamente, richiede verifica manuale."
            : "Errore aggiornamento stato servizi: assegnazioni annullate, nessun servizio è stato importato.",
          summary: {
            total_rows: parsedRows.length,
            valid_rows: preview.length,
            invalid_rows: errors.length,
            imported_rows: 0
          },
          preview,
          errors
        }, { status: 500 });
      }

      // CONC-07: storico strutturato per le assignments appena create.
      // insertedIds proviene da .insert(inserts).select("id") sullo stesso
      // batch nello stesso ordine di `inserts` (nessuna riga preesistente
      // può comparire: i service_id sono appena generati in questa stessa
      // richiesta) — previous è quindi sempre null per costruzione, nessuna
      // query di snapshot necessaria. Sprint 8: driverProfileIdForImport è
      // già stato risolto e verificato non-null dal guard di validazione
      // driver sopra (nessuna nuova query qui, era una lettura duplicata).
      // Riusa il contratto già validato altrove: changeType "driver_swap"
      // (driver sempre risolvibile ora, per costruzione del guard sopra);
      // vehicle_label è sempre "" per questo import (mai "" → "" reale),
      // quindi non genera mai "vehicle_binding".
      try {
        const toDriverProfileId = driverProfileIdForImport;
        // vehicle_label per questo import è sempre "" (riga 501): normalizzato
        // a null come da convenzione già in uso in assign-service/swap_vehicle.
        const toVehicleLabel: string | null = null;

        const historyEntries: AssignmentHistoryEntry[] = insertedIds.flatMap((serviceId, index) => {
          const driverChanged = toDriverProfileId !== null;
          const vehicleChanged = toVehicleLabel !== null;
          if (!driverChanged && !vehicleChanged) return [];

          const insertRow = inserts[index] as Record<string, unknown> | undefined;
          const changeType = driverChanged ? ("driver_swap" as const) : ("vehicle_binding" as const);
          const features = extractFeatures({
            serviceDate: payload.data.service_date,
            changeType,
            fromDriverProfileId: null,
            toDriverProfileId,
            fromVehicleLabel: null,
            toVehicleLabel,
            direction: (insertRow?.direction as string | null) ?? null,
            zone: (insertRow?.meeting_point as string | null) ?? null,
            time: (insertRow?.time as string | null) ?? null,
            vessel: (insertRow?.vessel as string | null) ?? null,
            pax: (insertRow?.pax as number | null) ?? null,
            isNavetta: insertRow?.booking_service_kind === "shuttle_hotel",
          });
          return [{
            tenantId: auth.membership.tenant_id,
            serviceDate: payload.data.service_date,
            serviceId,
            groupId: null,
            changeType,
            fromDriverProfileId: null,
            toDriverProfileId,
            fromVehicleLabel: null,
            toVehicleLabel,
            features,
            operatorId: auth.user.id,
          }];
        });

        if (historyEntries.length > 0) {
          void logAssignmentChange(auth.admin, historyEntries)
            .then(() => updateLearnedPatterns(auth.admin, auth.membership.tenant_id))
            .catch(() => undefined);
        }
      } catch {
        // best-effort: mai bloccare né alterare la risposta principale già determinata.
      }

      const statusEventsPayload = insertedIds.map((serviceId) => ({
        tenant_id: auth.membership.tenant_id,
        service_id: serviceId,
        status: "assigned",
        by_user_id: auth.user.id
      }));
      await auth.admin.from("status_events").insert(statusEventsPayload);
    }

    return NextResponse.json({
      ok: true,
      dry_run: false,
      summary: {
        total_rows: parsedRows.length,
        valid_rows: preview.length,
        invalid_rows: errors.length,
        imported_rows: insertedIds.length
      },
      preview,
      errors
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Errore import file autista." },
      { status: 500 }
    );
  }
}
