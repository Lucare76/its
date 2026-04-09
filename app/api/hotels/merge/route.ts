import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { auditLog } from "@/lib/server/ops-audit";
import { normalizeHotelText } from "@/lib/server/hotel-matching";

export const runtime = "nodejs";

const payloadSchema = z.object({
  source_hotel_id: z.string().uuid(),
  target_hotel_id: z.string().uuid()
});

export async function POST(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;

    const raw = await request.json().catch(() => null);
    const parsed = payloadSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: parsed.error.issues[0]?.message ?? "Payload non valido." }, { status: 400 });
    }

    const { source_hotel_id: sourceHotelId, target_hotel_id: targetHotelId } = parsed.data;
    if (sourceHotelId === targetHotelId) {
      return NextResponse.json({ ok: false, error: "Sorgente e destinazione non possono coincidere." }, { status: 400 });
    }

    const tenantId = auth.membership.tenant_id;
    const { data: hotelRows, error: hotelError } = await auth.admin
      .from("hotels")
      .select("id, name")
      .eq("tenant_id", tenantId)
      .in("id", [sourceHotelId, targetHotelId]);

    if (hotelError) {
      return NextResponse.json({ ok: false, error: hotelError.message }, { status: 500 });
    }

    const hotels = (hotelRows ?? []) as Array<{ id: string; name: string }>;
    const sourceHotel = hotels.find((row) => row.id === sourceHotelId) ?? null;
    const targetHotel = hotels.find((row) => row.id === targetHotelId) ?? null;
    if (!sourceHotel || !targetHotel) {
      return NextResponse.json({ ok: false, error: "Hotel sorgente o destinazione non trovato." }, { status: 404 });
    }

    const { data: sourceAliases, error: aliasError } = await auth.admin
      .from("hotel_aliases")
      .select("alias, alias_normalized")
      .eq("tenant_id", tenantId)
      .eq("hotel_id", sourceHotelId);
    if (aliasError) {
      return NextResponse.json({ ok: false, error: aliasError.message }, { status: 500 });
    }

    const { data: targetAliases, error: targetAliasError } = await auth.admin
      .from("hotel_aliases")
      .select("alias, alias_normalized")
      .eq("tenant_id", tenantId)
      .eq("hotel_id", targetHotelId);
    if (targetAliasError) {
      return NextResponse.json({ ok: false, error: targetAliasError.message }, { status: 500 });
    }

    const targetAliasSet = new Set(
      [
        normalizeHotelText(targetHotel.name),
        ...((targetAliases ?? []) as Array<{ alias: string; alias_normalized: string | null }>).map((row) =>
          normalizeHotelText(row.alias_normalized ?? row.alias)
        )
      ].filter(Boolean)
    );

    const aliasPayloads = Array.from(
      new Map(
        [sourceHotel.name, ...((sourceAliases ?? []) as Array<{ alias: string; alias_normalized: string | null }>).map((row) => row.alias)]
          .map((alias) => {
            const aliasNormalized = normalizeHotelText(alias);
            return [aliasNormalized, aliasNormalized ? { alias, alias_normalized: aliasNormalized } : null] as const;
          })
          .filter((entry): entry is readonly [string, { alias: string; alias_normalized: string }] => Boolean(entry[0] && entry[1]))
      ).values()
    ).filter((row) => !targetAliasSet.has(row.alias_normalized));

    if (aliasPayloads.length > 0) {
      const { error: insertAliasError } = await auth.admin.from("hotel_aliases").insert(
        aliasPayloads.map((row) => ({
          tenant_id: tenantId,
          hotel_id: targetHotelId,
          alias: row.alias,
          alias_normalized: row.alias_normalized,
          source: "hotel_merge"
        }))
      );
      if (insertAliasError) {
        return NextResponse.json({ ok: false, error: insertAliasError.message }, { status: 500 });
      }
    }

    const { error: servicesError } = await auth.admin
      .from("services")
      .update({ hotel_id: targetHotelId })
      .eq("tenant_id", tenantId)
      .eq("hotel_id", sourceHotelId);
    if (servicesError) {
      return NextResponse.json({ ok: false, error: servicesError.message }, { status: 500 });
    }

    const { error: deleteSourceAliasesError } = await auth.admin
      .from("hotel_aliases")
      .delete()
      .eq("tenant_id", tenantId)
      .eq("hotel_id", sourceHotelId);
    if (deleteSourceAliasesError) {
      return NextResponse.json({ ok: false, error: deleteSourceAliasesError.message }, { status: 500 });
    }

    const { error: deleteHotelError } = await auth.admin
      .from("hotels")
      .delete()
      .eq("tenant_id", tenantId)
      .eq("id", sourceHotelId);
    if (deleteHotelError) {
      return NextResponse.json({ ok: false, error: deleteHotelError.message }, { status: 500 });
    }

    auditLog({
      event: "hotel_merge_completed",
      tenantId,
      userId: auth.user.id,
      role: auth.membership.role,
      outcome: "merged",
      details: {
        source_hotel_id: sourceHotelId,
        source_hotel_name: sourceHotel.name,
        target_hotel_id: targetHotelId,
        target_hotel_name: targetHotel.name,
        aliases_moved: aliasPayloads.length
      }
    });

    return NextResponse.json({
      ok: true,
      source_hotel_id: sourceHotelId,
      target_hotel_id: targetHotelId,
      aliases_moved: aliasPayloads.length
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
