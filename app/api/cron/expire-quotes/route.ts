/**
 * GET /api/cron/expire-quotes
 * Segna come "expired" i preventivi in stato "sent" con valid_until < oggi.
 * Vercel Cron: ogni giorno alle 02:00  → schedule "0 2 * * *"
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

function adminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/^["']|["']$/g, "")!,
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim().replace(/^["']|["']$/g, "")!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ ok: false, error: "Server configuration error" }, { status: 500 });
  }
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const admin = adminClient();
  const todayIso = new Date().toISOString().slice(0, 10);

  const { data, error } = await admin
    .from("quotes")
    .update({ status: "expired" })
    .eq("status", "sent")
    .not("valid_until", "is", null)
    .lt("valid_until", todayIso)
    .select("id");

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, expired: data?.length ?? 0 });
}
