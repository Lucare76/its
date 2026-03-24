import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import * as XLSX from "xlsx";
import { findBusStopsByCity, findNearestBusStop } from "@/lib/bus-lines-catalog";
import {
  appendSplitImportNote,
  formatImportValidationMessage,
  isPlaceholderHotelValue,
  sanitizeImportCustomerName,
  sanitizeImportPhone,
  splitPassengerChunks
} from "@/lib/server/bus-excel-import";
import { resolveHotelMatch } from "@/lib/server/hotel-matching";
import { serviceCreateSchema } from "@/lib/validation";

type Direction = "arrival" | "departure";
type ParsedInputRow = {
  sourceFile: string;
  rowIndex: number;
  direction: Direction;
  customerName: string;
  phone: string;
  pax: number;
  hotelName: string;
  agencyName: string;
  mainlandCity: string;
  lineCode: string;
  notes: string;
  date: string;
  time: string;
};

type HotelRow = {
  id: string;
  name: string;
  normalized_name?: string | null;
};
type InsertServiceRow = Record<string, unknown>;

function loadDotEnvLocal() {
  const envPath = path.resolve(".env.local");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^"|"$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

function normalizeText(value: string | null | undefined) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function inferDateFromFilename(fileName: string) {
  const monthMap: Record<string, string> = {
    gen: "01",
    feb: "02",
    mar: "03",
    apr: "04",
    mag: "05",
    giu: "06",
    lug: "07",
    ago: "08",
    set: "09",
    ott: "10",
    nov: "11",
    dic: "12"
  };
  const normalized = fileName
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const match = normalizeText(normalized).match(/^(\d{1,2}) ([a-z]{3,9}) (\d{4})$/);
  if (!match) return "";
  const day = match[1].padStart(2, "0");
  const month = monthMap[match[2].slice(0, 3)] ?? "";
  return month ? `${match[3]}-${month}-${day}` : "";
}

function parsePax(value: unknown) {
  const digits = String(value ?? "").replace(/[^\d]/g, "");
  return digits ? Number(digits) : 0;
}

function parseTimeAndCity(raw: unknown) {
  const compact = String(raw ?? "").replace(/\s+/g, " ").trim();
  const match = compact.match(/^(\d{1,2}:\d{2})\s+(.+)$/);
  return {
    time: match?.[1] ?? "",
    city: match?.[2]?.trim() ?? compact
  };
}

function extractDestinationCity(raw: unknown) {
  const compact = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!compact) return "";
  return compact.split(" - ")[0]?.split(",")[0]?.trim() ?? compact;
}

function parseWorkbook(filePath: string): ParsedInputRow[] {
  const workbook = XLSX.readFile(filePath, { cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0] ?? "Foglio1"];
  const rows = XLSX.utils.sheet_to_json<(string | number)[]>(sheet, { header: 1, raw: false }) as Array<Array<string | number>>;
  const title = normalizeText(String(rows[0]?.[2] ?? ""));
  const date = inferDateFromFilename(path.basename(filePath));
  const parsed: ParsedInputRow[] = [];

  if (title.includes("arrivi")) {
    for (const [index, row] of rows.slice(2).entries()) {
      const pax = parsePax(row[2]);
      const customerName = String(row[3] ?? "").trim();
      if (!customerName && pax <= 0) continue;
      const { time, city } = parseTimeAndCity(row[0]);
      const matched = findNearestBusStop(city, time) ?? findBusStopsByCity(city)[0] ?? null;
      parsed.push({
        sourceFile: path.basename(filePath),
        rowIndex: index + 3,
        direction: "arrival",
        customerName,
        phone: String(row[4] ?? "").trim(),
        pax,
        hotelName: String(row[5] ?? "").trim(),
        agencyName: String(row[9] ?? "").trim(),
        mainlandCity: matched?.stop.city ?? city,
        lineCode: matched?.lineCode ?? "",
        notes: [String(row[7] ?? "").trim(), String(row[6] ?? "").trim()].filter(Boolean).join(" | "),
        date,
        time: time || matched?.stop.time || ""
      });
    }
    return parsed;
  }

  if (title.includes("partenze")) {
    for (const [index, row] of rows.slice(2).entries()) {
      const pax = parsePax(row[1]);
      const customerName = String(row[2] ?? "").trim();
      if (!customerName && pax <= 0) continue;
      const mainlandCity = extractDestinationCity(row[4]);
      const matched = findNearestBusStop(mainlandCity) ?? findBusStopsByCity(mainlandCity)[0] ?? null;
      parsed.push({
        sourceFile: path.basename(filePath),
        rowIndex: index + 3,
        direction: "departure",
        customerName,
        phone: String(row[3] ?? "").trim(),
        pax,
        hotelName: String(row[0] ?? "").trim(),
        agencyName: String(row[6] ?? "").trim(),
        mainlandCity: matched?.stop.city ?? mainlandCity,
        lineCode: matched?.lineCode ?? "",
        notes: [String(row[7] ?? "").trim(), String(row[4] ?? "").trim()].filter(Boolean).join(" | "),
        date,
        time: matched?.stop.time ?? ""
      });
    }
    return parsed;
  }

  throw new Error(`Formato file non riconosciuto: ${path.basename(filePath)}`);
}

function parseArgs(args: string[]) {
  const files: string[] = [];
  let tenantId = "";
  let userId = "";
  let apply = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--tenant") {
      tenantId = args[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--user") {
      userId = args[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    files.push(arg);
  }

  return { tenantId, userId, apply, files };
}

async function main() {
  loadDotEnvLocal();
  const { tenantId, userId, apply, files } = parseArgs(process.argv.slice(2));

  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Env Supabase mancanti.");
  }
  if (!tenantId) {
    throw new Error("Passa --tenant <tenant_id>.");
  }
  if (files.length === 0) {
    throw new Error("Passa almeno un file xlsx.");
  }

  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const { data: hotels, error: hotelsError } = await admin
    .from("hotels")
    .select("id, name, normalized_name")
    .eq("tenant_id", tenantId)
    .order("name", { ascending: true });
  if (hotelsError) throw new Error(hotelsError.message);

  let createdByUserId = userId;
  if (!createdByUserId) {
    const membershipResult = await admin
      .from("memberships")
      .select("user_id, role")
      .eq("tenant_id", tenantId)
      .in("role", ["admin", "operator"])
      .limit(1)
      .maybeSingle();
    if (membershipResult.error || !membershipResult.data?.user_id) {
      throw new Error(membershipResult.error?.message ?? "Nessun admin/operator disponibile per l'import.");
    }
    createdByUserId = membershipResult.data.user_id;
  }

  const parsedRows = files.flatMap(parseWorkbook);
  const validRows: Array<{ rowIndex: number; file: string; payload: Record<string, unknown> }> = [];
  const errors: Array<{ file: string; row: number; message: string }> = [];
  let skippedRows = 0;

  for (const row of parsedRows) {
    if (row.pax <= 0) {
      skippedRows += 1;
      continue;
    }
    if (isPlaceholderHotelValue(row.hotelName)) {
      skippedRows += 1;
      continue;
    }

    const hotelId = resolveHotelMatch((hotels ?? []) as HotelRow[], row.hotelName);
    if (!hotelId) {
      errors.push({ file: row.sourceFile, row: row.rowIndex, message: `Hotel non riconosciuto: ${row.hotelName || "vuoto"}` });
      continue;
    }

    const paxChunks = splitPassengerChunks(row.pax);
    const customerName = sanitizeImportCustomerName(row.customerName, row.rowIndex);
    const phone = sanitizeImportPhone(row.phone);

    for (const [chunkIndex, paxChunk] of paxChunks.entries()) {
      const payload = {
        date: row.date,
        time: row.time,
        service_type: "transfer" as const,
        direction: row.direction,
        vessel: "Linea bus",
        pax: paxChunk,
        hotel_id: hotelId,
        customer_name: customerName,
        phone,
        notes: appendSplitImportNote(row.notes, row.pax, chunkIndex + 1, paxChunks.length),
        meeting_point: row.direction === "arrival" ? row.mainlandCity : row.hotelName,
        stops: [],
        bus_plate: "",
        billing_party_name: row.agencyName,
        customer_email: "",
        booking_service_kind: "bus_city_hotel" as const,
        service_type_code: "bus_line" as const,
        arrival_date: row.date,
        arrival_time: row.time,
        departure_date: "",
        departure_time: "",
        transport_code: row.lineCode,
        bus_city_origin: row.mainlandCity,
        tour_name: row.lineCode || row.mainlandCity || "Linea bus",
        capacity: 54,
        low_seat_threshold: 5,
        minimum_passengers: null,
        waitlist_enabled: false,
        waitlist_count: 0,
        status: "new" as const
      };

      const validated = serviceCreateSchema.safeParse(payload);
      if (!validated.success) {
        errors.push({
          file: row.sourceFile,
          row: row.rowIndex,
          message: formatImportValidationMessage(validated.error.issues[0])
        });
        continue;
      }
      validRows.push({ rowIndex: row.rowIndex, file: row.sourceFile, payload: validated.data as unknown as Record<string, unknown> });
    }
  }

  const summary = {
    tenant_id: tenantId,
    apply,
    total_rows: parsedRows.length,
    skipped_rows: skippedRows,
    valid_rows: validRows.length,
    invalid_rows: errors.length,
    files
  };

  if (!apply) {
    console.log(JSON.stringify({ ok: true, dry_run: true, summary, errors }, null, 2));
    return;
  }

  if (validRows.length === 0) {
    throw new Error("Nessuna riga valida da importare.");
  }

  const servicesToInsert: InsertServiceRow[] = validRows.map(({ payload }) => ({
    ...payload,
    tenant_id: tenantId,
    created_by_user_id: createdByUserId,
    is_draft: false,
    billing_party_name: (payload.billing_party_name as string) || null,
    customer_email: null,
    booking_service_kind: payload.booking_service_kind || null,
    service_type_code: payload.service_type_code || null,
    arrival_date: payload.arrival_date || payload.date,
    arrival_time: payload.arrival_time || payload.time,
    departure_date: null,
    departure_time: null,
    transport_code: (payload.transport_code as string) || null,
    bus_city_origin: (payload.bus_city_origin as string) || null
  }));

  let insertPayload: InsertServiceRow[] = servicesToInsert;
  const droppedColumns: string[] = [];
  let insertResult = await admin.from("services").insert(insertPayload).select("id");

  while (insertResult.error) {
    const missingColumnMatch = insertResult.error.message.match(/Could not find the '([^']+)' column/i);
    if (!missingColumnMatch) break;
    const missingColumn = missingColumnMatch[1] ?? "";
    if (!missingColumn || droppedColumns.includes(missingColumn)) break;
    droppedColumns.push(missingColumn);
    insertPayload = insertPayload.map((row) => {
      const nextRow = { ...row } as InsertServiceRow;
      delete nextRow[missingColumn];
      return nextRow;
    });
    insertResult = await admin.from("services").insert(insertPayload).select("id");
  }

  if (insertResult.error) throw new Error(insertResult.error.message);

  const insertedIds = (insertResult.data ?? []).map((item: { id: string }) => item.id);
  if (insertedIds.length > 0) {
    await admin.from("status_events").insert(
      insertedIds.map((serviceId) => ({
        tenant_id: tenantId,
        service_id: serviceId,
        status: "new",
        by_user_id: createdByUserId
      }))
    );
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        dry_run: false,
        summary: { ...summary, imported_rows: insertedIds.length },
        inserted_service_ids: insertedIds,
        dropped_columns: droppedColumns,
        errors
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
