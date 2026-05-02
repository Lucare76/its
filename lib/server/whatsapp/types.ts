export type WhatsAppMatchStatus = "matched" | "unmatched" | "ambiguous" | "needs_review";

export type WhatsAppServiceSuggestion = {
  id: string;
  tenant_id: string;
  customer_name: string | null;
  phone: string | null;
  phone_e164: string | null;
  date: string | null;
  time: string | null;
  hotel_name?: string | null;
  booking_service_kind?: string | null;
  reason: string;
};

export type WhatsAppMatchResult = {
  tenantId: string | null;
  bookingId: string | null;
  transferId: string | null;
  customerId: string | null;
  status: WhatsAppMatchStatus;
  suggestions: WhatsAppServiceSuggestion[];
};

export type MetaContact = {
  wa_id?: string;
  profile?: { name?: string };
};

export type MetaMessage = {
  id?: string;
  from?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  image?: { id?: string; mime_type?: string; sha256?: string; caption?: string };
  document?: { id?: string; mime_type?: string; sha256?: string; caption?: string; filename?: string };
  audio?: { id?: string; mime_type?: string; sha256?: string };
  video?: { id?: string; mime_type?: string; sha256?: string; caption?: string };
  button?: { text?: string; payload?: string };
  interactive?: unknown;
  [key: string]: unknown;
};

export type MetaStatus = {
  id?: string;
  status?: string;
  timestamp?: string;
  recipient_id?: string;
  conversation?: { id?: string };
  pricing?: { category?: string };
  errors?: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

export type MetaChangeValue = {
  messaging_product?: string;
  metadata?: { phone_number_id?: string; display_phone_number?: string };
  contacts?: MetaContact[];
  messages?: MetaMessage[];
  statuses?: MetaStatus[];
};

export type MetaWebhookPayload = {
  object?: string;
  entry?: Array<{
    id?: string;
    changes?: Array<{
      field?: string;
      value?: MetaChangeValue;
    }>;
  }>;
};

