import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { existsSync } from "node:fs";
import path from "node:path";

export async function GET() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const inboundToken = process.env.EMAIL_INBOUND_TOKEN;
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
    EMAIL_INBOUND_TOKEN: Boolean(inboundToken),
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

  if (!supabaseUrl || !serviceRoleKey) {
    return NextResponse.json(
      {
        ok: false,
        server: { ok: false },
        env,
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
        ok: !error
      },
      env,
      features,
      timestamp: new Date().toISOString()
    },
    { status: error ? 500 : 200 }
  );
}
