import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeE164 } from "@/lib/server/whatsapp";
import type { WhatsAppMatchResult, WhatsAppServiceSuggestion } from "./types";

type ServiceRow = {
  id: string;
  tenant_id: string;
  customer_name: string | null;
  phone: string | null;
  phone_e164: string | null;
  date: string | null;
  time: string | null;
  notes?: string | null;
  message_id?: string | null;
  external_code?: string | null;
  source_quote_id?: string | null;
  booking_service_kind?: string | null;
  hotel_id?: string | null;
};

function phoneComparable(value: string | null | undefined) {
  return (value ?? "").replace(/\D/g, "").replace(/^00/, "").replace(/^0+/, "");
}

function toSuggestion(row: ServiceRow, reason: string): WhatsAppServiceSuggestion {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    customer_name: row.customer_name,
    phone: row.phone,
    phone_e164: row.phone_e164,
    date: row.date,
    time: row.time,
    booking_service_kind: row.booking_service_kind ?? null,
    reason
  };
}

function uniqueServices(rows: WhatsAppServiceSuggestion[]) {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
}

function extractPracticeTokens(text: string | null | undefined) {
  if (!text) return [];
  const tokens = new Set<string>();
  const patterns = [
    /\b(?:pratica|practice|rif|ref|codice|voucher)\s*[:#-]?\s*([A-Z0-9][A-Z0-9/_-]{3,24})\b/gi,
    /\b([A-Z]{1,4}\d{4,}[\w/-]*)\b/gi,
    /\b(\d{4,}[_/-]\d{2,}[_/-]\d{2,})\b/g
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const token = match[1]?.trim();
      if (token) tokens.add(token.toUpperCase());
    }
  }
  return [...tokens].slice(0, 8);
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function resolveSingleTenant(admin: SupabaseClient) {
  const { data, error } = await admin.from("tenants").select("id").limit(2);
  if (error) {
    console.error("WhatsApp inbound tenant lookup failed", {
      code: error.code ?? null,
      message: error.message
    });
    return null;
  }
  return data?.length === 1 ? String(data[0].id) : null;
}

function resolveFromSuggestions(suggestions: WhatsAppServiceSuggestion[]): WhatsAppMatchResult {
  const unique = uniqueServices(suggestions);
  if (unique.length === 1) {
    return {
      tenantId: unique[0].tenant_id,
      bookingId: unique[0].id,
      transferId: unique[0].id,
      customerId: null,
      status: "matched",
      suggestions: unique
    };
  }
  if (unique.length > 1) {
    const tenants = new Set(unique.map((item) => item.tenant_id));
    return {
      tenantId: tenants.size === 1 ? unique[0].tenant_id : null,
      bookingId: null,
      transferId: null,
      customerId: null,
      status: "ambiguous",
      suggestions: unique.slice(0, 10)
    };
  }
  return { tenantId: null, bookingId: null, transferId: null, customerId: null, status: "unmatched", suggestions: [] };
}

export async function matchWhatsAppInboundMessage(
  admin: SupabaseClient,
  input: { waId: string; phoneE164: string | null; textBody?: string | null; timestamp?: string | null }
): Promise<WhatsAppMatchResult> {
  const normalizedPhone = input.phoneE164 ?? normalizeE164(input.waId);
  const exactPhones = Array.from(new Set([input.waId, normalizedPhone].filter(Boolean)));
  const serviceColumns = "id, tenant_id, customer_name, phone, phone_e164, date, time, notes, message_id, external_code, source_quote_id, booking_service_kind, hotel_id";
  const [exactPhone, exactPhoneE164] = await Promise.all([
    exactPhones.length
      ? admin.from("services").select(serviceColumns).in("phone", exactPhones).order("date", { ascending: true }).limit(20)
      : Promise.resolve({ data: [], error: null }),
    exactPhones.length
      ? admin.from("services").select(serviceColumns).in("phone_e164", exactPhones).order("date", { ascending: true }).limit(20)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (exactPhone.error || exactPhoneE164.error) {
    console.error("WhatsApp inbound exact service lookup failed", {
      phoneError: exactPhone.error?.message ?? null,
      phoneE164Error: exactPhoneE164.error?.message ?? null
    });
  }

  const exactSuggestions = uniqueServices(
    ([...(exactPhone.data ?? []), ...(exactPhoneE164.data ?? [])] as ServiceRow[]).map((row) => toSuggestion(row, "phone_exact"))
  );
  const exactResult = resolveFromSuggestions(exactSuggestions);
  if (exactResult.status === "matched") return exactResult;

  const comparable = phoneComparable(normalizedPhone);
  if (comparable.length >= 7) {
    const { data: recentRows, error: recentError } = await admin
      .from("services")
      .select(serviceColumns)
      .gte("date", new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10))
      .order("date", { ascending: true })
      .limit(1000);
    if (recentError) {
      console.error("WhatsApp inbound normalized service lookup failed", {
        code: recentError.code ?? null,
        message: recentError.message
      });
    }

    const normalizedMatches = ((recentRows ?? []) as ServiceRow[])
      .filter((row) => phoneComparable(row.phone_e164) === comparable || phoneComparable(row.phone) === comparable)
      .map((row) => toSuggestion(row, "phone_normalized"));
    const normalizedResult = resolveFromSuggestions(normalizedMatches);
    if (normalizedResult.status === "matched") return normalizedResult;
    if (normalizedResult.status === "ambiguous") {
      const future = normalizedMatches.filter((row) => (row.date ?? "") >= new Date().toISOString().slice(0, 10));
      if (future.length === 1) return resolveFromSuggestions(future.map((row) => ({ ...row, reason: "nearest_future_phone" })));
      return normalizedResult;
    }
  }

  const tokens = extractPracticeTokens(input.textBody);
  if (tokens.length > 0) {
    const { data: tokenRows, error: tokenError } = await admin
      .from("services")
      .select(serviceColumns)
      .gte("date", new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10))
      .order("date", { ascending: true })
      .limit(1000);
    if (tokenError) {
      console.error("WhatsApp inbound token service lookup failed", {
        code: tokenError.code ?? null,
        message: tokenError.message
      });
    }
    const upperTokens = tokens.map((token) => token.toUpperCase());
    const tokenMatches = ((tokenRows ?? []) as ServiceRow[])
      .filter((row) => {
        const notes = (row.notes ?? "").toUpperCase();
        const externalCode = (row.external_code ?? "").toUpperCase();
        const messageId = (row.message_id ?? "").toUpperCase();
        const sourceQuoteId = (row.source_quote_id ?? "").toUpperCase();
        return upperTokens.some((token) =>
          externalCode.includes(token)
          || notes.includes(token)
          || messageId.includes(token)
          || sourceQuoteId === token
        );
      })
      .map((row) => toSuggestion(row, "practice_token"));
    const tokenResult = resolveFromSuggestions(tokenMatches);
    if (tokenResult.status !== "unmatched") return tokenResult;
  }

  if (exactResult.status === "ambiguous") return exactResult;

  return {
    tenantId: await resolveSingleTenant(admin),
    bookingId: null,
    transferId: null,
    customerId: null,
    status: "unmatched",
    suggestions: []
  };
}
