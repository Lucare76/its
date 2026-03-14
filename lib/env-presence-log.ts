const isDev = process.env.NODE_ENV === "development";

if (isDev) {
  const marker = "__it_env_presence_logged__";
  const globalScope = globalThis as typeof globalThis & { [key: string]: boolean | undefined };

  if (!globalScope[marker]) {
    globalScope[marker] = true;
    console.info("[env] presence", {
      NEXT_PUBLIC_SUPABASE_URL: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL),
      NEXT_PUBLIC_SUPABASE_ANON_KEY: Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
      SUPABASE_SERVICE_ROLE_KEY: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
      EMAIL_INBOUND_TOKEN: Boolean(process.env.EMAIL_INBOUND_TOKEN),
      RESEND_API_KEY: Boolean(process.env.RESEND_API_KEY),
      AGENCY_BOOKING_FROM_EMAIL: Boolean(process.env.AGENCY_BOOKING_FROM_EMAIL),
      AGENCY_BOOKING_BETA_RECIPIENT_EMAIL: Boolean(process.env.AGENCY_BOOKING_BETA_RECIPIENT_EMAIL),
      NEXT_PUBLIC_AGENCY_DEFAULT_CONFIRMATION_EMAIL: Boolean(process.env.NEXT_PUBLIC_AGENCY_DEFAULT_CONFIRMATION_EMAIL),
      IMAP_HOST: Boolean(process.env.IMAP_HOST),
      IMAP_PORT: Boolean(process.env.IMAP_PORT),
      IMAP_USER: Boolean(process.env.IMAP_USER),
      IMAP_PASS: Boolean(process.env.IMAP_PASS),
      IMAP_TLS: Boolean(process.env.IMAP_TLS),
      WHATSAPP_TOKEN: Boolean(process.env.WHATSAPP_TOKEN),
      WHATSAPP_PHONE_NUMBER_ID: Boolean(process.env.WHATSAPP_PHONE_NUMBER_ID),
      WHATSAPP_VERIFY_TOKEN: Boolean(process.env.WHATSAPP_VERIFY_TOKEN),
      WHATSAPP_REMINDER_WINDOW_MINUTES: Boolean(process.env.WHATSAPP_REMINDER_WINDOW_MINUTES),
      WHATSAPP_REMINDER_2H_ENABLED: Boolean(process.env.WHATSAPP_REMINDER_2H_ENABLED),
      WHATSAPP_TEMPLATE_LANGUAGE: Boolean(process.env.WHATSAPP_TEMPLATE_LANGUAGE),
      WHATSAPP_ALLOW_TEXT_FALLBACK: Boolean(process.env.WHATSAPP_ALLOW_TEXT_FALLBACK)
    });
  }
}

export {};
