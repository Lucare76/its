import fs from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
import { createClient } from "@supabase/supabase-js";
import { resolveHotelMatch } from "@/lib/server/hotel-matching";

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

function loadLocalEnv() {
  for (const filename of [".env.local", ".env"]) {
    const fullPath = path.resolve(process.cwd(), filename);
    if (!fs.existsSync(fullPath)) continue;
    const content = fs.readFileSync(fullPath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex === -1) continue;
      const key = trimmed.slice(0, separatorIndex).trim();
      let value = trimmed.slice(separatorIndex + 1).trim();
      if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
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

function parseTimeCell(value: string) {
  const raw = value.trim();
  if (!raw) return "";
  const compact = raw.replace(".", ":");
  const hhmmss = compact.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (hhmmss) return `${hhmmss[1].padStart(2, "0")}:${hhmmss[2]}:00`;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 4) return `${digits.slice(0, 2)}:${digits.slice(2, 4)}:00`;
  if (digits.length === 3) return `0${digits[0]}:${digits.slice(1, 3)}:00`;
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

function isMeaningfulReference(value: string) {
  const normalized = normalizeText(value);
  return Boolean(
    normalized &&
    normalized !== "arrivo" &&
    normalized !== "partenza" &&
    normalized !== "navetta" &&
    normalized !== "escursione"
  );
}

function inferDirection(rawType: string, origin: string, destination: string): "arrival" | "departure" {
  const type = normalizeText(rawType);
  if (type === "arrivo" || type === "arrival") return "arrival";
  if (type === "partenza" || type === "departure") return "departure";
  if (type === "escursione") return "departure";

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

function buildNotes(row: ParsedDriverFileRow, direction: "arrival" | "departure") {
  const parts = [
    row.extra_1.trim(),
    row.extra_2.trim(),
    row.pax_raw.trim() && row.pax === 0 ? `Pax file: ${row.pax_raw.trim()}` : "",
    row.source_driver_name.trim() ? `Autista file: ${row.source_driver_name.trim()}` : "",
    direction === "departure" && row.service_type_label.trim() ? `Tipo file: ${row.service_type_label.trim()}` : "",
    "Import source: driver-file-direct"
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
    .filter((row) => Object.values(row).some((value) => String(value ?? "").trim()));
}

async function main() {
  loadLocalEnv();
  const [, , fileArg, dateArg, driverNameArg] = process.argv;
  const filePath = fileArg ? path.resolve(fileArg) : path.resolve("c:/Users/user/Downloads/Foglio di lavoro senza nome.xlsx");
  const serviceDate = dateArg ?? "2026-04-26";
  const driverName = driverNameArg ?? "LEO";

  if (!fs.existsSync(filePath)) {
    throw new Error(`File non trovato: ${filePath}`);
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/^["']|["']$/g, "");
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim().replace(/^["']|["']$/g, "");
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Variabili Supabase mancanti.");
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const { data: memberships, error: membershipError } = await admin
    .from("memberships")
    .select("user_id, tenant_id, full_name, role")
    .eq("role", "driver")
    .ilike("full_name", driverName);
  if (membershipError) throw new Error(membershipError.message);
  const driverMembership = memberships?.[0];
  if (!driverMembership) {
    throw new Error(`Autista app non trovato: ${driverName}`);
  }

  const tenantId = driverMembership.tenant_id as string;
  const driverUserId = driverMembership.user_id as string;

  const { data: hotels, error: hotelsError } = await admin
    .from("hotels")
    .select("id, name, normalized_name")
    .eq("tenant_id", tenantId)
    .order("name", { ascending: true });
  if (hotelsError) throw new Error(hotelsError.message);

  const { data: aliasRows, error: aliasesError } = await admin
    .from("hotel_aliases")
    .select("hotel_id, alias")
    .eq("tenant_id", tenantId)
    .limit(5000);
  if (aliasesError) throw new Error(aliasesError.message);

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

  const workbook = XLSX.read(fs.readFileSync(filePath), { type: "buffer" });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) throw new Error("Nessun foglio disponibile nel file.");
  const rows = XLSX.utils.sheet_to_json<string[]>(workbook.Sheets[firstSheetName], { header: 1, raw: false, defval: "" }) as string[][];
  const parsedRows = parseRowsFromSheet(rows);

  const inserts: Array<Record<string, unknown>> = [];
  const errors: Array<{ row_index: number; message: string }> = [];

  for (const row of parsedRows) {
    if (!row.time) {
      errors.push({ row_index: row.row_index, message: "Campo time non valido." });
      continue;
    }

    const direction = inferDirection(row.service_type_label || row.reference, row.origin, row.destination);
    const hotelName = direction === "arrival" ? row.destination : row.origin;
    const meetingPoint = direction === "arrival" ? row.origin : row.destination;
    const transportCode = isMeaningfulReference(row.reference)
      ? row.reference
      : (direction === "arrival" ? row.origin : row.destination);
    const notes = buildNotes(row, direction);
    const customerContact = resolveCustomerContact(row);
    const resolvedHotelId = resolveHotelMatch(hotelRows, hotelName, null);

    if (!resolvedHotelId) {
      errors.push({ row_index: row.row_index, message: `Hotel non riconosciuto: ${hotelName || "vuoto"}` });
      continue;
    }

    const pax = row.pax > 0 ? row.pax : 1;
    const vessel = (isMeaningfulReference(row.reference) ? row.reference : row.service_type_label || "Servizio autista").slice(0, 80);
    const bookingServiceKind =
      normalizeText(row.service_type_label) === "escursione" ? "excursion"
      : normalizeText(row.service_type_label) === "navetta" ? "shuttle_hotel"
      : null;

    inserts.push({
      tenant_id: tenantId,
      created_by_user_id: driverUserId,
      is_draft: false,
      status: "assigned",
      date: serviceDate,
      time: row.time,
      direction,
      service_type: "transfer",
      vessel,
      pax,
      hotel_id: resolvedHotelId,
      customer_name: customerContact.customerName,
      billing_party_name: row.billing_party_name || null,
      phone: customerContact.phone,
      notes: notes || null,
      meeting_point: meetingPoint || null,
      booking_service_kind: bookingServiceKind,
      service_type_code: null,
      arrival_date: serviceDate,
      arrival_time: row.time,
      departure_date: direction === "departure" ? serviceDate : null,
      departure_time: direction === "departure" ? row.time : null,
      transport_code: transportCode.slice(0, 80) || null
    });
  }

  const existingForDate = await admin
    .from("services")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("date", serviceDate)
    .ilike("notes", "%Import source: driver-file-direct%");
  if (existingForDate.error) throw new Error(existingForDate.error.message);
  if ((existingForDate.data ?? []).length > 0) {
    throw new Error(`Esistono gia import diretti per la data ${serviceDate}.`);
  }

  if (inserts.length === 0) {
    throw new Error(`Nessuna riga valida da importare. Errori: ${errors.length}`);
  }

  const { data: insertedServices, error: insertError } = await admin
    .from("services")
    .insert(inserts)
    .select("id");
  if (insertError) throw new Error(insertError.message);

  const insertedIds = (insertedServices ?? []).map((row) => row.id as string);

  const { error: assignmentsError } = await admin.from("assignments").insert(
    insertedIds.map((serviceId) => ({
      tenant_id: tenantId,
      service_id: serviceId,
      driver_user_id: driverUserId,
      vehicle_label: ""
    }))
  );
  if (assignmentsError) throw new Error(assignmentsError.message);

  const { error: eventsError } = await admin.from("status_events").insert(
    insertedIds.map((serviceId) => ({
      tenant_id: tenantId,
      service_id: serviceId,
      status: "assigned",
      by_user_id: driverUserId
    }))
  );
  if (eventsError) throw new Error(eventsError.message);

  console.log(JSON.stringify({
    tenant_id: tenantId,
    driver_user_id: driverUserId,
    service_date: serviceDate,
    imported_rows: insertedIds.length,
    invalid_rows: errors.length,
    errors: errors.slice(0, 20)
  }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
