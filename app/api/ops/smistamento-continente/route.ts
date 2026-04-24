import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import {
  loadContinentDispatchServices,
  resetContinentDispatchTarget,
  setContinentDispatchTarget,
  setContinentDispatchVendor,
} from "@/lib/server/continent-dispatch";

export const runtime = "nodejs";

async function loadSmistamentoData(
  auth: ReturnType<typeof authorizePricingRequest> extends Promise<infer T> ? T : never,
  date: string
) {
  const data = await loadContinentDispatchServices(
    // @ts-expect-error auth type resolved at runtime
    auth,
    date
  );

  return {
    services: data.services.filter((service) => service.effective_target === "continent_dispatch"),
  };
}

export async function GET(req: NextRequest) {
  try {
    const auth = await authorizePricingRequest(req, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;

    const date = req.nextUrl.searchParams.get("date")?.trim() || new Date().toISOString().slice(0, 10);
    const data = await loadSmistamentoData(auth, date);
    return NextResponse.json({ ok: true, ...data });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Errore" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await authorizePricingRequest(req, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;

    const body = (await req.json()) as Record<string, unknown>;
    const action = body.action as string;
    const date = ((body.date as string) ?? "").trim() || new Date().toISOString().slice(0, 10);

    if (action === "set_dispatch_target") {
      const { service_id, target, reason } = body as {
        service_id: string;
        target: "bruno" | "continent_dispatch";
        reason?: string;
      };
      if (target !== "bruno" && target !== "continent_dispatch") {
        return NextResponse.json({ ok: false, error: "Target non valido." }, { status: 400 });
      }
      await setContinentDispatchTarget(auth, {
        serviceId: service_id,
        target,
        reason: reason ?? null,
      });
      const data = await loadSmistamentoData(auth, date);
      return NextResponse.json({ ok: true, ...data });
    }

    if (action === "reset_dispatch_target") {
      const { service_id } = body as { service_id: string };
      await resetContinentDispatchTarget(auth, service_id);
      const data = await loadSmistamentoData(auth, date);
      return NextResponse.json({ ok: true, ...data });
    }

    if (action === "set_vendor") {
      const { service_id, vendor_name } = body as { service_id: string; vendor_name?: string | null };
      await setContinentDispatchVendor(auth, service_id, vendor_name ?? null);
      const data = await loadSmistamentoData(auth, date);
      return NextResponse.json({ ok: true, ...data });
    }

    return NextResponse.json({ ok: false, error: "Azione non riconosciuta." }, { status: 400 });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Errore" },
      { status: 500 }
    );
  }
}
