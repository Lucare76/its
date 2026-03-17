import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { existsSync } from "node:fs";
import path from "node:path";
import { getEnvStatus } from "@/lib/server/env-requirements";

export async function GET() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const inboundToken = process.env.EMAIL_INBOUND_TOKEN;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  const resendApiKey = process.env.RESEND_API_KEY;
  const agencyBookingFromEmail = process.env.AGENCY_BOOKING_FROM_EMAIL;
  const agencyBookingBetaRecipient = process.env.AGENCY_BOOKING_BETA_RECIPIENT_EMAIL;
  const agencyDefaultConfirmationEmail = process.env.NEXT_PUBLIC_AGENCY_DEFAULT_CONFIRMATION_EMAIL;
  const imapHost = process.env.IMAP_HOST;
  const imapPort = process.env.IMAP_PORT;
  const imapUser = process.env.IMAP_USER;
  const imapPass = process.env.IMAP_PASS;
  const imapTls = process.env.IMAP_TLS;
  const ocrSpaceApiKey = process.env.OCR_SPACE_API_KEY;
  const cronSecret = process.env.CRON_SECRET;
  const whatsappToken = process.env.WHATSAPP_TOKEN;
  const whatsappPhoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const whatsappVerifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
  const whatsappReminderWindow = process.env.WHATSAPP_REMINDER_WINDOW_MINUTES;
  const whatsappReminder2hEnabled = process.env.WHATSAPP_REMINDER_2H_ENABLED;
  const whatsappTemplateLanguage = process.env.WHATSAPP_TEMPLATE_LANGUAGE;
  const whatsappAllowTextFallback = process.env.WHATSAPP_ALLOW_TEXT_FALLBACK;

  const env = {
    NEXT_PUBLIC_SUPABASE_URL: Boolean(supabaseUrl),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: Boolean(anonKey),
    SUPABASE_SERVICE_ROLE_KEY: Boolean(serviceRoleKey),
    NEXT_PUBLIC_APP_URL: Boolean(appUrl),
    EMAIL_INBOUND_TOKEN: Boolean(inboundToken),
    RESEND_API_KEY: Boolean(resendApiKey),
    AGENCY_BOOKING_FROM_EMAIL: Boolean(agencyBookingFromEmail),
    AGENCY_BOOKING_BETA_RECIPIENT_EMAIL: Boolean(agencyBookingBetaRecipient),
    NEXT_PUBLIC_AGENCY_DEFAULT_CONFIRMATION_EMAIL: Boolean(agencyDefaultConfirmationEmail),
    IMAP_HOST: Boolean(imapHost),
    IMAP_PORT: Boolean(imapPort),
    IMAP_USER: Boolean(imapUser),
    IMAP_PASS: Boolean(imapPass),
    IMAP_TLS: Boolean(imapTls),
    OCR_SPACE_API_KEY: Boolean(ocrSpaceApiKey),
    CRON_SECRET: Boolean(cronSecret),
    WHATSAPP_TOKEN: Boolean(whatsappToken),
    WHATSAPP_PHONE_NUMBER_ID: Boolean(whatsappPhoneNumberId),
    WHATSAPP_VERIFY_TOKEN: Boolean(whatsappVerifyToken),
    WHATSAPP_REMINDER_WINDOW_MINUTES: Boolean(whatsappReminderWindow),
    WHATSAPP_REMINDER_2H_ENABLED: Boolean(whatsappReminder2hEnabled),
    WHATSAPP_TEMPLATE_LANGUAGE: Boolean(whatsappTemplateLanguage),
    WHATSAPP_ALLOW_TEXT_FALLBACK: Boolean(whatsappAllowTextFallback)
  };
  const features = {
    excel_export_route_enabled: true,
    share_route_present: existsSync(path.join(process.cwd(), "app", "share", "service", "[token]", "page.tsx")),
    share_og_image_present: existsSync(path.join(process.cwd(), "app", "share", "service", "[token]", "opengraph-image.tsx"))
  };
  const envRequirements = getEnvStatus();

  if (!supabaseUrl || !serviceRoleKey) {
    return NextResponse.json(
      {
        ok: false,
        server: { ok: false },
        env,
        env_requirements: envRequirements,
        features,
        timestamp: new Date().toISOString()
      },
      { status: 500 }
    );
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const { error } = await admin.from("tenants").select("id", { head: true, count: "exact" });

  return NextResponse.json(
    {
      ok: !error,
      server: {
        ok: !error,
        error: error?.message ?? null
      },
      env,
      env_requirements: envRequirements,
      features,
      timestamp: new Date().toISOString()
    },
    { status: error ? 500 : 200 }
  );
}
