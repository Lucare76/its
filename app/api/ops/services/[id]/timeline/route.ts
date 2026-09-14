/**
 * GET /api/ops/services/[id]/timeline?cursor=...
 *
 * Timeline/Audit per servizio — endpoint separato e lazy (Fase 6/7): NON fa
 * parte del payload di GET /api/ops/services/[id], viene interrogato solo
 * quando la UI mostra la sezione "Cronologia". Aggrega in lettura 7 fonti
 * esistenti (vedi lib/server/service-timeline.ts) — nessuna scrittura qui.
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { getServiceTimelinePage, isValidUuid } from "@/lib/server/service-timeline";

export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await authorizePricingRequest(req, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  if (!isValidUuid(id)) {
    return NextResponse.json({ ok: false, error: "ID servizio non valido." }, { status: 400 });
  }

  const cursor = req.nextUrl.searchParams.get("cursor");

  try {
    const page = await getServiceTimelinePage(auth.admin, {
      tenantId: auth.membership.tenant_id,
      serviceId: id,
      cursor,
    });
    return NextResponse.json({ ok: true, events: page.events, next_cursor: page.nextCursor });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Errore nel caricamento della cronologia." },
      { status: 500 }
    );
  }
}
