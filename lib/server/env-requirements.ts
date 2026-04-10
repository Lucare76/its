export type EnvRequirement = {
  key: string;
  requiredForBeta: boolean;
  category: "core" | "agency" | "pdf" | "email" | "ops" | "whatsapp";
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
  { key: "WHATSAPP_TOKEN", requiredForBeta: false, category: "whatsapp", notes: "Needed only for WhatsApp reminders." },
  { key: "WHATSAPP_PHONE_NUMBER_ID", requiredForBeta: false, category: "whatsapp", notes: "Needed only for WhatsApp reminders." },
  { key: "WHATSAPP_VERIFY_TOKEN", requiredForBeta: false, category: "whatsapp", notes: "Needed only for WhatsApp webhook." },
  { key: "WHATSAPP_REMINDER_WINDOW_MINUTES", requiredForBeta: false, category: "whatsapp", notes: "Optional tuning." },
  { key: "WHATSAPP_REMINDER_2H_ENABLED", requiredForBeta: false, category: "whatsapp", notes: "Optional tuning." },
  { key: "WHATSAPP_TEMPLATE_LANGUAGE", requiredForBeta: false, category: "whatsapp", notes: "Optional tuning." },
  { key: "WHATSAPP_ALLOW_TEXT_FALLBACK", requiredForBeta: false, category: "whatsapp", notes: "Optional tuning." }
];

export function getEnvStatus() {
  return ENV_REQUIREMENTS.map((item) => ({
    ...item,
    present: Boolean(process.env[item.key])
  }));
}
