/**
 * POST   /api/push/subscribe   — salva iscrizione push per l'utente autenticato
 * DELETE /api/push/subscribe   — rimuove iscrizione push
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator", "driver", "supervisor"]);
    if (auth instanceof NextResponse) return auth;

    const body = await request.json().catch(() => null) as {
      endpoint?: string;
      keys?: { p256dh?: string; auth?: string };
    } | null;

    const endpoint = body?.endpoint;
    const p256dh = body?.keys?.p256dh;
    const authKey = body?.keys?.auth;

    if (!endpoint || !p256dh || !authKey) {
      return NextResponse.json({ ok: false, error: "Subscription incompleta (endpoint/p256dh/auth)." }, { status: 400 });
    }

    const userAgent = request.headers.get("user-agent")?.slice(0, 250) ?? null;

    await auth.admin.from("push_subscriptions").upsert(
      {
        tenant_id: auth.membership.tenant_id,
        user_id: auth.user.id,
        endpoint,
        p256dh,
        auth_key: authKey,
        user_agent: userAgent,
      },
      { onConflict: "endpoint" }
    );

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Errore" },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator", "driver", "supervisor"]);
    if (auth instanceof NextResponse) return auth;

    const body = await request.json().catch(() => null) as { endpoint?: string } | null;
    const endpoint = body?.endpoint;

    if (!endpoint) {
      return NextResponse.json({ ok: false, error: "Endpoint mancante." }, { status: 400 });
    }

    await auth.admin
      .from("push_subscriptions")
      .delete()
      .eq("endpoint", endpoint)
      .eq("user_id", auth.user.id);

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Errore" },
      { status: 500 }
    );
  }
}
