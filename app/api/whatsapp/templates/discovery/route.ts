import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import {
  fetchWhatsAppGraph,
  getWhatsAppBusinessAccountId,
  getWhatsAppPhoneNumberId
} from "@/lib/server/whatsapp";

export const runtime = "nodejs";

type DiscoveryStep = {
  label: string;
  target: string;
  ok: boolean;
  status: number;
  error: string | null;
  data: unknown;
};

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin"]);
  if (auth instanceof NextResponse) return auth;

  const businessId = getWhatsAppBusinessAccountId();
  const phoneNumberId = getWhatsAppPhoneNumberId();

  const steps: DiscoveryStep[] = [];

  const run = async (label: string, target: string) => {
    const result = await fetchWhatsAppGraph(target);
    steps.push({
      label,
      target,
      ok: result.ok,
      status: result.status,
      error: result.error,
      data: result.data
    });
  };

  await run(
    "Configured WABA templates",
    `${businessId}/message_templates?fields=id,name,language,status,category&limit=20`
  );
  await run(
    "Configured WABA details",
    `${businessId}?fields=id,name,currency,timezone_id,primary_funding_id`
  );
  await run(
    "Configured phone number details",
    `${phoneNumberId}?fields=id,display_phone_number,verified_name,quality_rating,name_status`
  );
  await run(
    "Business owned WhatsApp accounts",
    `me?fields=businesses{id,name,owned_whatsapp_business_accounts{id,name}}`
  );

  return NextResponse.json({
    ok: true,
    configured_business_account_id: businessId,
    configured_phone_number_id: phoneNumberId,
    steps
  });
}
