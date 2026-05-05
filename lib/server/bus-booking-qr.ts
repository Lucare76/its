import { randomBytes } from "crypto";
import QRCode from "qrcode";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getRequestAppUrl } from "@/lib/app-url";
import { normalizeE164 } from "@/lib/server/whatsapp";
import { auditLog } from "@/lib/server/ops-audit";

export const runtime = "nodejs";

const QR_BUCKET = "bus-qr-codes";
const QR_DIRECTIONS = ["outbound", "return"] as const;

export type BusQrDirection = (typeof QR_DIRECTIONS)[number];
export type BusQrStatus = "active" | "used" | "cancelled";
export type BusQrValidationState = "valid" | "already_used" | "invalid" | "cancelled";

type BusBookingServiceRow = {
  id: string;
  tenant_id: string;
  date: string;
  time: string | null;
  direction: "arrival" | "departure";
  linked_service_id: string | null;
  booking_service_kind: string | null;
  service_type_code: string | null;
  customer_name: string | null;
  phone: string | null;
  customer_first_name: string | null;
  customer_last_name: string | null;
  arrival_date: string | null;
  arrival_time: string | null;
  departure_date: string | null;
  departure_time: string | null;
  bus_city_origin: string | null;
  vessel: string | null;
  hotel_id: string | null;
  notes: string | null;
  status: string | null;
};

type BookingQrRow = {
  id: string;
  tenant_id: string;
  booking_id: string;
  direction: BusQrDirection;
  service_date: string;
  qr_token: string;
  qr_payload: string;
  qr_image_url: string;
  qr_file_path: string | null;
  status: BusQrStatus;
  used_at: string | null;
  used_by: string | null;
  created_at: string;
  updated_at: string;
};

export type BusBookingQrSummary = {
  bookingId: string;
  tenantId: string;
  customerName: string;
  phone: string | null;
  busLabel: string | null;
  busCityOrigin: string | null;
  outboundServiceDate: string;
  returnServiceDate: string | null;
  codes: BookingQrRow[];
};

export type BusQrValidationResult = {
  state: BusQrValidationState;
  bookingId: string | null;
  tenantId: string | null;
  direction: BusQrDirection | null;
  qrCode: BookingQrRow | null;
  booking: BusBookingQrSummary | null;
  message: string;
};

type EnsureQrOptions = {
  admin: SupabaseClient;
  tenantId: string;
  serviceId: string;
  appUrl: string;
  force?: boolean;
};

type SendWhatsAppOptions = {
  admin: SupabaseClient;
  tenantId: string;
  bookingId: string;
  appUrl: string;
  selection: "outbound" | "return" | "both";
  mediaKind?: "image" | "document";
  dryRun?: boolean;
};

type WhatsAppSendResult = {
  ok: boolean;
  previewOnly: boolean;
  phone: string | null;
  templateName: string | null;
  messages: Array<Record<string, unknown>>;
  errors: string[];
};

function isBusBooking(service: Pick<BusBookingServiceRow, "booking_service_kind" | "service_type_code">) {
  return service.booking_service_kind === "bus_city_hotel" || service.service_type_code === "bus_line";
}

function qrToken() {
  return randomBytes(24).toString("hex");
}

function directionLabel(direction: BusQrDirection) {
  return direction === "outbound" ? "ANDATA" : "RITORNO";
}

function toVerifyPath(bookingId: string, direction: BusQrDirection, token: string) {
  return `/qr/bus/${bookingId}/${direction}/${token}`;
}

function toApiVerifyPath(bookingId: string, direction: BusQrDirection, token: string) {
  return `/api/qr/bus/${bookingId}/${direction}/${token}`;
}

function toImagePath(bookingId: string, direction: BusQrDirection) {
  return `/api/bookings/${bookingId}/qr-codes/${direction}/image`;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function loadService(admin: SupabaseClient, tenantId: string, serviceId: string) {
  const { data, error } = await admin
    .from("services")
    .select("id, tenant_id, date, time, direction, linked_service_id, booking_service_kind, service_type_code, customer_name, phone, customer_first_name, customer_last_name, arrival_date, arrival_time, departure_date, departure_time, bus_city_origin, vessel, hotel_id, notes, status")
    .eq("tenant_id", tenantId)
    .eq("id", serviceId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data ?? null) as BusBookingServiceRow | null;
}

async function loadHotelName(admin: SupabaseClient, tenantId: string, hotelId: string | null) {
  if (!hotelId) return null;
  const { data } = await admin
    .from("hotels")
    .select("name")
    .eq("tenant_id", tenantId)
    .eq("id", hotelId)
    .maybeSingle();
  return data?.name ?? null;
}

async function loadBusBookingContext(admin: SupabaseClient, tenantId: string, serviceId: string) {
  const service = await loadService(admin, tenantId, serviceId);
  if (!service) throw new Error("Prenotazione bus non trovata.");
  if (!isBusBooking(service)) throw new Error("Il servizio selezionato non e una prenotazione bus.");

  const linked = service.linked_service_id ? await loadService(admin, tenantId, service.linked_service_id) : null;
  const root = service.direction === "departure" && linked ? linked : service;
  const outboundService = [service, linked, root].find((row): row is BusBookingServiceRow => Boolean(row && row.direction === "arrival")) ?? root;
  const returnService = [service, linked].find((row): row is BusBookingServiceRow => Boolean(row && row.direction === "departure")) ?? null;

  return { root, outboundService, returnService };
}

async function uploadQrPng(
  admin: SupabaseClient,
  tenantId: string,
  bookingId: string,
  direction: BusQrDirection,
  png: Buffer
) {
  const objectPath = `${tenantId}/${bookingId}/bus-${bookingId}-${direction}.png`;
  const upload = await admin.storage.from(QR_BUCKET).upload(objectPath, png, {
    contentType: "image/png",
    upsert: true,
  });
  if (upload.error) {
    throw new Error(upload.error.message);
  }
  return objectPath;
}

export async function buildBusQrPng(payload: string) {
  return QRCode.toBuffer(payload, {
    width: 640,
    margin: 2,
    color: { dark: "#111827", light: "#ffffff" },
  });
}

async function upsertQrRecord(
  admin: SupabaseClient,
  root: BusBookingServiceRow,
  direction: BusQrDirection,
  serviceDate: string,
  appUrl: string,
  existing: BookingQrRow | undefined,
  force = false
) {
  const token = force || !existing ? qrToken() : existing.qr_token;
  const qrPayload = `${appUrl}${toVerifyPath(root.id, direction, token)}`;
  const qrImageUrl = `${appUrl}${toImagePath(root.id, direction)}`;
  const png = await buildBusQrPng(qrPayload);

  let qrFilePath = existing?.qr_file_path ?? null;
  try {
    qrFilePath = await uploadQrPng(admin, root.tenant_id, root.id, direction, png);
  } catch (error) {
    auditLog({
      event: "bus_booking_qr_upload_failed",
      level: "warn",
      tenantId: root.tenant_id,
      serviceId: root.id,
      details: {
        direction,
        message: error instanceof Error ? error.message : "upload_failed",
      },
    });
  }

  const payload = {
    tenant_id: root.tenant_id,
    booking_id: root.id,
    direction,
    service_date: serviceDate,
    qr_token: token,
    qr_payload: qrPayload,
    qr_image_url: qrImageUrl,
    qr_file_path: qrFilePath,
    status: "active" as const,
    used_at: null,
    used_by: null,
  };

  if (existing) {
    const { error } = await admin
      .from("booking_qr_codes")
      .update(payload)
      .eq("id", existing.id)
      .eq("tenant_id", root.tenant_id);
    if (error) throw new Error(error.message);
    return { ...existing, ...payload, updated_at: new Date().toISOString() } satisfies BookingQrRow;
  }

  const { data, error } = await admin
    .from("booking_qr_codes")
    .insert(payload)
    .select("*")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Inserimento QR non riuscito.");
  return data as BookingQrRow;
}

export async function listBusBookingQrCodes(admin: SupabaseClient, tenantId: string, serviceId: string): Promise<BusBookingQrSummary> {
  const { root, outboundService, returnService } = await loadBusBookingContext(admin, tenantId, serviceId);
  const { data, error } = await admin
    .from("booking_qr_codes")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("booking_id", root.id)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);

  return {
    bookingId: root.id,
    tenantId,
    customerName: root.customer_name?.trim() || [root.customer_first_name, root.customer_last_name].filter(Boolean).join(" ").trim() || "Cliente",
    phone: root.phone ?? null,
    busLabel: root.vessel ?? null,
    busCityOrigin: root.bus_city_origin ?? null,
    outboundServiceDate: outboundService.arrival_date ?? outboundService.date,
    returnServiceDate: returnService?.departure_date ?? returnService?.date ?? root.departure_date ?? null,
    codes: (data ?? []) as BookingQrRow[],
  };
}

export async function ensureBusBookingQrCodes(options: EnsureQrOptions) {
  const { admin, tenantId, serviceId, appUrl, force = false } = options;
  const { root, outboundService, returnService } = await loadBusBookingContext(admin, tenantId, serviceId);

  const summary = await listBusBookingQrCodes(admin, tenantId, root.id);
  const existingByDirection = new Map(summary.codes.map((row) => [row.direction, row]));

  const nextRows: BookingQrRow[] = [];
  nextRows.push(await upsertQrRecord(
    admin,
    root,
    "outbound",
    outboundService.arrival_date ?? outboundService.date,
    appUrl,
    existingByDirection.get("outbound"),
    force
  ));

  const returnDate = returnService?.departure_date ?? returnService?.date ?? root.departure_date ?? null;
  if (returnDate) {
    nextRows.push(await upsertQrRecord(
      admin,
      root,
      "return",
      returnDate,
      appUrl,
      existingByDirection.get("return"),
      force
    ));
  } else if (existingByDirection.get("return")) {
    const existing = existingByDirection.get("return")!;
    const { error } = await admin
      .from("booking_qr_codes")
      .update({ status: "cancelled" satisfies BusQrStatus, used_at: null, used_by: null })
      .eq("id", existing.id)
      .eq("tenant_id", tenantId);
    if (error) throw new Error(error.message);
    nextRows.push({ ...existing, status: "cancelled", used_at: null, used_by: null });
  }

  const hotelName = await loadHotelName(admin, tenantId, root.hotel_id);
  auditLog({
    event: force ? "bus_booking_qr_regenerated" : "bus_booking_qr_ensured",
    tenantId,
    serviceId: root.id,
    outcome: force ? "regenerated" : "generated",
    details: {
      directions: nextRows.map((row) => row.direction),
      hotel_name: hotelName,
    },
  });

  return {
    ...(await listBusBookingQrCodes(admin, tenantId, root.id)),
    codes: nextRows.sort((left, right) => left.direction.localeCompare(right.direction)),
  } satisfies BusBookingQrSummary;
}

async function loadQrByToken(admin: SupabaseClient, bookingId: string, direction: BusQrDirection, token: string) {
  const { data, error } = await admin
    .from("booking_qr_codes")
    .select("*")
    .eq("booking_id", bookingId)
    .eq("direction", direction)
    .eq("qr_token", token)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data ?? null) as BookingQrRow | null;
}

export async function validateBusBookingQr(
  admin: SupabaseClient,
  bookingId: string,
  direction: BusQrDirection,
  token: string
): Promise<BusQrValidationResult> {
  const qrCode = await loadQrByToken(admin, bookingId, direction, token);
  if (!qrCode) {
    return {
      state: "invalid",
      bookingId: null,
      tenantId: null,
      direction: null,
      qrCode: null,
      booking: null,
      message: "QR non valido o non trovato.",
    };
  }

  const booking = await listBusBookingQrCodes(admin, qrCode.tenant_id, qrCode.booking_id);
  const { root, returnService } = await loadBusBookingContext(admin, qrCode.tenant_id, qrCode.booking_id);
  const serviceStatus = direction === "outbound" ? root.status : returnService?.status;

  if (qrCode.status === "cancelled" || serviceStatus === "cancelled") {
    return {
      state: "cancelled",
      bookingId,
      tenantId: qrCode.tenant_id,
      direction,
      qrCode,
      booking,
      message: "QR annullato.",
    };
  }

  if (qrCode.status === "used") {
    return {
      state: "already_used",
      bookingId,
      tenantId: qrCode.tenant_id,
      direction,
      qrCode,
      booking,
      message: "QR gia utilizzato.",
    };
  }

  return {
    state: "valid",
    bookingId,
    tenantId: qrCode.tenant_id,
    direction,
    qrCode,
    booking,
    message: "QR valido.",
  };
}

export async function markBusBookingQrCodeUsed(
  admin: SupabaseClient,
  bookingId: string,
  direction: BusQrDirection,
  token: string,
  usedBy: string
) {
  const validation = await validateBusBookingQr(admin, bookingId, direction, token);
  if (validation.state !== "valid" || !validation.qrCode || !validation.tenantId) {
    return validation;
  }

  const usedAt = new Date().toISOString();
  const { error } = await admin
    .from("booking_qr_codes")
    .update({
      status: "used" satisfies BusQrStatus,
      used_at: usedAt,
      used_by: usedBy,
    })
    .eq("id", validation.qrCode.id)
    .eq("tenant_id", validation.tenantId)
    .eq("status", "active");
  if (error) throw new Error(error.message);

  auditLog({
    event: "bus_booking_qr_used",
    tenantId: validation.tenantId,
    userId: usedBy,
    serviceId: bookingId,
    outcome: direction,
    details: { qr_code_id: validation.qrCode.id },
  });

  return validateBusBookingQr(admin, bookingId, direction, token);
}

export async function getBusQrImageResponse(
  admin: SupabaseClient,
  bookingId: string,
  direction: BusQrDirection
) {
  const { data, error } = await admin
    .from("booking_qr_codes")
    .select("qr_payload, qr_file_path")
    .eq("booking_id", bookingId)
    .eq("direction", direction)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data?.qr_payload) {
    return new Response("QR non trovato", { status: 404 });
  }

  if (data.qr_file_path) {
    const download = await admin.storage.from(QR_BUCKET).download(data.qr_file_path);
    if (!download.error && download.data) {
      return new Response(download.data, {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=300",
          "Content-Disposition": `inline; filename="bus-${bookingId}-${direction}.png"`,
        },
      });
    }
  }

  const png = await buildBusQrPng(data.qr_payload);
  return new Response(png as BodyInit, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=300",
      "Content-Disposition": `inline; filename="bus-${bookingId}-${direction}.png"`,
    },
  });
}

export async function buildBusBookingQrPdfHtml(admin: SupabaseClient, tenantId: string, serviceId: string) {
  const summary = await listBusBookingQrCodes(admin, tenantId, serviceId);
  const hotelName = await loadHotelName(admin, tenantId, (await loadBusBookingContext(admin, tenantId, summary.bookingId)).root.hotel_id);
  const appUrl = getRequestAppUrl(new Headers());
  const buildCard = async (direction: BusQrDirection) => {
    const row = summary.codes.find((item) => item.direction === direction);
    if (!row) {
      return `<div class="empty-card"><div class="label">${directionLabel(direction)}</div><p>Non disponibile</p></div>`;
    }
    const dataUrl = await QRCode.toDataURL(row.qr_payload, {
      width: 360,
      margin: 1,
      color: { dark: "#111827", light: "#ffffff" },
    });
    return `<div class="card">
      <div class="label">${directionLabel(direction)}</div>
      <div class="date">${escapeHtml(row.service_date)}</div>
      <img src="${dataUrl}" alt="QR ${directionLabel(direction)}" />
      <div class="status ${row.status}">${escapeHtml(row.status.toUpperCase())}</div>
      <div class="small">${escapeHtml(`${appUrl}${toApiVerifyPath(summary.bookingId, direction, row.qr_token)}`)}</div>
    </div>`;
  };

  const outboundCard = await buildCard("outbound");
  const returnCard = await buildCard("return");

  return `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>QR Bus ${escapeHtml(summary.customerName)}</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: "Segoe UI", Arial, sans-serif; background: #f5f7fb; color: #0f172a; padding: 24px; }
    .sheet { max-width: 980px; margin: 0 auto; background: #ffffff; border: 1px solid #dbe3ef; border-radius: 24px; padding: 32px; }
    .header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; margin-bottom: 28px; }
    .eyebrow { font-size: 11px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #64748b; }
    h1 { margin: 8px 0 4px; font-size: 30px; }
    .meta { color: #475569; font-size: 14px; line-height: 1.6; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
    .card, .empty-card { border: 1px solid #dbe3ef; border-radius: 22px; padding: 20px; text-align: center; min-height: 420px; background: linear-gradient(180deg, #ffffff 0%, #f8fbff 100%); }
    .label { display: inline-flex; padding: 8px 14px; border-radius: 999px; background: #0f2744; color: #ffffff; font-size: 12px; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; }
    .date { margin-top: 12px; font-size: 16px; font-weight: 700; }
    img { width: 100%; max-width: 320px; margin: 20px auto 16px; display: block; }
    .status { display: inline-flex; padding: 7px 12px; border-radius: 999px; font-size: 12px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; }
    .status.active { background: #dcfce7; color: #166534; }
    .status.used { background: #e2e8f0; color: #334155; }
    .status.cancelled { background: #fee2e2; color: #991b1b; }
    .small { margin-top: 14px; color: #64748b; font-size: 11px; line-height: 1.5; word-break: break-all; }
    .print { margin-top: 24px; text-align: center; }
    button { background: #0f2744; color: #ffffff; border: none; border-radius: 999px; padding: 12px 20px; font-size: 14px; font-weight: 700; cursor: pointer; }
    @media print {
      body { padding: 0; background: #ffffff; }
      .sheet { border: none; border-radius: 0; padding: 0; }
      .print { display: none; }
      @page { size: A4 portrait; margin: 1cm; }
    }
    @media (max-width: 720px) {
      .grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="sheet">
    <div class="header">
      <div>
        <div class="eyebrow">Ischia Transfer Service</div>
        <h1>QR Bus</h1>
        <div class="meta">
          <div><strong>Cliente:</strong> ${escapeHtml(summary.customerName)}</div>
          <div><strong>Hotel:</strong> ${escapeHtml(hotelName ?? "N/D")}</div>
          <div><strong>Origine bus:</strong> ${escapeHtml(summary.busCityOrigin ?? summary.busLabel ?? "N/D")}</div>
        </div>
      </div>
      <div class="meta">
        <div><strong>Booking ID:</strong> ${escapeHtml(summary.bookingId)}</div>
        <div><strong>Telefono:</strong> ${escapeHtml(summary.phone ?? "N/D")}</div>
      </div>
    </div>
    <div class="grid">
      ${outboundCard}
      ${returnCard}
    </div>
    <div class="print">
      <button onclick="window.print()">Stampa / Salva PDF</button>
    </div>
  </div>
</body>
</html>`;
}

function buildWhatsAppTemplatePayload(input: {
  phone: string;
  templateName: string;
  languageCode: string;
  mediaKind: "image" | "document";
  mediaLink: string;
  direction: BusQrDirection;
  customerName: string;
  serviceDate: string;
  filename?: string;
}) {
  const headerParameter = input.mediaKind === "document"
    ? {
        type: "document",
        document: {
          link: input.mediaLink,
          filename: input.filename ?? "bus-qr.pdf",
        },
      }
    : {
        type: "image",
        image: { link: input.mediaLink },
      };

  return {
    messaging_product: "whatsapp",
    to: normalizeE164(input.phone),
    type: "template",
    template: {
      name: input.templateName,
      language: { code: input.languageCode },
      components: [
        { type: "header", parameters: [headerParameter] },
        {
          type: "body",
          parameters: [
            { type: "text", text: input.customerName.slice(0, 60) },
            { type: "text", text: input.serviceDate },
            { type: "text", text: directionLabel(input.direction) },
          ],
        },
      ],
    },
  };
}

export async function sendBusBookingQrWhatsApp(options: SendWhatsAppOptions): Promise<WhatsAppSendResult> {
  const summary = await listBusBookingQrCodes(options.admin, options.tenantId, options.bookingId);
  const phone = summary.phone?.trim() || null;
  if (!phone) {
    return { ok: false, previewOnly: true, phone: null, templateName: null, messages: [], errors: ["Telefono cliente assente."] };
  }

  const selectedDirections: BusQrDirection[] =
    options.selection === "both"
      ? ["outbound", "return"]
      : [options.selection];

  const mediaKind = options.mediaKind ?? "image";
  const languageCode = (process.env.WHATSAPP_TEMPLATE_LANGUAGE ?? "it").replace("-", "_");
  const templateName = mediaKind === "document"
    ? (process.env.WHATSAPP_TEMPLATE_BUS_QR_DOCUMENT ?? "its_qr_bus_pdf")
    : (process.env.WHATSAPP_TEMPLATE_BUS_QR ?? process.env.WHATSAPP_TEMPLATE_INFO_BUS ?? "its_qr_bus");

  const messages = selectedDirections
    .map((direction) => {
      const code = summary.codes.find((row) => row.direction === direction);
      if (!code) return null;
      const mediaLink = mediaKind === "document"
        ? `${options.appUrl}/api/bookings/${summary.bookingId}/qr-codes/pdf`
        : `${options.appUrl}${toImagePath(summary.bookingId, direction)}`;
      return buildWhatsAppTemplatePayload({
        phone,
        templateName,
        languageCode,
        mediaKind,
        mediaLink,
        direction,
        customerName: summary.customerName,
        serviceDate: code.service_date,
        filename: `bus-${summary.bookingId}.pdf`,
      });
    })
    .filter(Boolean) as Array<Record<string, unknown>>;

  if (messages.length === 0) {
    return { ok: false, previewOnly: true, phone, templateName, messages: [], errors: ["Nessun QR disponibile per l'invio richiesto."] };
  }

  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN?.trim() ?? process.env.WHATSAPP_TOKEN?.trim();
  if (!phoneNumberId || !accessToken || options.dryRun) {
    return {
      ok: true,
      previewOnly: true,
      phone: normalizeE164(phone),
      templateName,
      messages,
      errors: [],
    };
  }

  const errors: string[] = [];
  for (const message of messages) {
    const response = await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(message),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      errors.push(payload?.error?.message ?? `WhatsApp API error (${response.status})`);
    }
  }

  return {
    ok: errors.length === 0,
    previewOnly: false,
    phone: normalizeE164(phone),
    templateName,
    messages,
    errors,
  };
}

export function parseBusQrDirection(value: string): BusQrDirection | null {
  return QR_DIRECTIONS.includes(value as BusQrDirection) ? (value as BusQrDirection) : null;
}

export function appUrlFromRequest(request: Request) {
  return getRequestAppUrl(request.headers);
}
