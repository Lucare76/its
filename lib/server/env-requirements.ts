export type EnvRequirement = {
  key: string;
  requiredForBeta: boolean;
  category: "core" | "agency" | "pdf" | "email" | "ops" | "whatsapp" | "medmar";
  notes: string;
};

export const ENV_REQUIREMENTS: EnvRequirement[] = [
  { key: "NEXT_PUBLIC_SUPABASE_URL", requiredForBeta: true, category: "core", notes: "Supabase project URL." },
  { key: "NEXT_PUBLIC_SUPABASE_ANON_KEY", requiredForBeta: true, category: "core", notes: "Client auth and app session." },
  { key: "SUPABASE_SERVICE_ROLE_KEY", requiredForBeta: true, category: "core", notes: "Server APIs and protected jobs." },
  { key: "NEXT_PUBLIC_APP_URL", requiredForBeta: true, category: "ops", notes: "Used by share links and smoke scripts." },
  { key: "PDF_PREVIEW_USER_EMAIL", requiredForBeta: true, category: "pdf", notes: "Smoke test operator/admin account." },
  { key: "PDF_PREVIEW_USER_PASSWORD", requiredForBeta: true, category: "pdf", notes: "Smoke test operator/admin password." },
  { key: "GOOGLE_CLOUD_PROJECT_ID", requiredForBeta: false, category: "pdf", notes: "Needed only for Google Cloud OCR fallback." },
  { key: "GOOGLE_CLOUD_VISION_CLIENT_EMAIL", requiredForBeta: false, category: "pdf", notes: "Service account client email for Google OCR fallback." },
  { key: "GOOGLE_CLOUD_VISION_PRIVATE_KEY", requiredForBeta: false, category: "pdf", notes: "Service account private key for Google OCR fallback." },
  { key: "GOOGLE_CLOUD_VISION_INPUT_BUCKET", requiredForBeta: false, category: "pdf", notes: "GCS bucket for source PDFs when using Google Vision async OCR." },
  { key: "GOOGLE_CLOUD_VISION_OUTPUT_BUCKET", requiredForBeta: false, category: "pdf", notes: "GCS bucket for OCR results when using Google Vision async OCR." },
  { key: "RESEND_API_KEY", requiredForBeta: false, category: "email", notes: "Optional until domain is verified." },
  { key: "AGENCY_BOOKING_FROM_EMAIL", requiredForBeta: false, category: "agency", notes: "Needed only for real agency confirmation mail." },
  { key: "AGENCY_BOOKING_BETA_RECIPIENT_EMAIL", requiredForBeta: false, category: "agency", notes: "Fallback recipient for beta mail." },
  { key: "NEXT_PUBLIC_AGENCY_DEFAULT_CONFIRMATION_EMAIL", requiredForBeta: false, category: "agency", notes: "Default UI recipient hint." },
  { key: "EMAIL_INBOUND_TOKEN", requiredForBeta: false, category: "email", notes: "Needed for secure inbound email webhook." },
  { key: "IMAP_HOST", requiredForBeta: false, category: "email", notes: "Needed only for mailbox polling/import." },
  { key: "IMAP_PORT", requiredForBeta: false, category: "email", notes: "Needed only for mailbox polling/import." },
  { key: "IMAP_USER", requiredForBeta: false, category: "email", notes: "Needed only for mailbox polling/import." },
  { key: "IMAP_PASS", requiredForBeta: false, category: "email", notes: "Needed only for mailbox polling/import." },
  { key: "IMAP_TLS", requiredForBeta: false, category: "email", notes: "Needed only for mailbox polling/import." },
  { key: "CRON_SECRET", requiredForBeta: false, category: "ops", notes: "Needed for scheduled jobs." },
  { key: "WHATSAPP_ACCESS_TOKEN", requiredForBeta: true, category: "whatsapp", notes: "Meta WhatsApp Cloud API access token for reminders and templates." },
  { key: "WHATSAPP_PHONE_NUMBER_ID", requiredForBeta: true, category: "whatsapp", notes: "Meta WhatsApp Cloud API phone number ID." },
  { key: "WHATSAPP_VERIFY_TOKEN", requiredForBeta: true, category: "whatsapp", notes: "WhatsApp webhook verify token." },
  { key: "WHATSAPP_BUSINESS_ACCOUNT_ID", requiredForBeta: false, category: "whatsapp", notes: "Optional Meta WhatsApp Business Account ID." },
  { key: "WHATSAPP_APP_SECRET", requiredForBeta: false, category: "whatsapp", notes: "Optional Meta app secret for webhook/signature validation." },
  { key: "WHATSAPP_GRAPH_API_VERSION", requiredForBeta: false, category: "whatsapp", notes: "Optional Graph API version override." },
  { key: "WHATSAPP_REMINDER_WINDOW_MINUTES", requiredForBeta: false, category: "whatsapp", notes: "Optional tuning." },
  { key: "WHATSAPP_REMINDER_2H_ENABLED", requiredForBeta: false, category: "whatsapp", notes: "Optional tuning." },
  { key: "WHATSAPP_TEMPLATE_LANGUAGE", requiredForBeta: false, category: "whatsapp", notes: "Optional tuning." },
  { key: "WHATSAPP_ALLOW_TEXT_FALLBACK", requiredForBeta: false, category: "whatsapp", notes: "Optional tuning." },
  { key: "UPSTASH_REDIS_REST_URL", requiredForBeta: false, category: "ops", notes: "Upstash Redis per rate limiting distribuito. Senza, il rate limit è in-memory (non efficace su Vercel multi-istanza)." },
  { key: "UPSTASH_REDIS_REST_TOKEN", requiredForBeta: false, category: "ops", notes: "Token Upstash Redis (vedi UPSTASH_REDIS_REST_URL)." },
  { key: "MEDMAR_API_BASE_URL", requiredForBeta: false, category: "medmar", notes: "Override base URL API Medmar (Fase 1: nessun endpoint reale ancora verificato)." },
  { key: "MEDMAR_SESSION_TOKEN", requiredForBeta: false, category: "medmar", notes: "Token di sessione Medmar ottenuto manualmente, in attesa di un login automatico documentato." }
];

export function getEnvStatus() {
  return ENV_REQUIREMENTS.map((item) => ({
    ...item,
    present: Boolean(process.env[item.key])
  }));
}
