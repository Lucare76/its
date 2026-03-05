import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { z } from "https://esm.sh/zod@3.24.1";

const payloadSchema = z.object({
  tenant_id: z.string().uuid(),
  raw_text: z.string().min(10)
});

const parseInbound = (rawText: string) => {
  const dateMatch = rawText.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  const timeMatch = rawText.match(/\b([01]\d|2[0-3]):([0-5]\d)\b/);
  const vesselMatch = rawText.match(/(?:nave|vessel)\s*[:=-]?\s*([A-Za-z0-9\s]+)/i);
  const hotelMatch = rawText.match(/(?:hotel)\s*[:=-]?\s*([A-Za-z0-9\s']+)/i);
  const paxMatch = rawText.match(/(?:pax|persone)\s*[:=-]?\s*(\d{1,2})/i);
  const nameMatch = rawText.match(/(?:nome|name)\s*[:=-]?\s*([A-Za-z\s']+)/i);
  return {
    date: dateMatch?.[1],
    time: timeMatch ? `${timeMatch[1]}:${timeMatch[2]}` : undefined,
    vessel: vesselMatch?.[1]?.trim(),
    hotel: hotelMatch?.[1]?.trim(),
    pax: paxMatch ? Number(paxMatch[1]) : undefined,
    customer_name: nameMatch?.[1]?.trim()
  };
};

Deno.serve(async (request) => {
  try {
    const payload = payloadSchema.parse(await request.json());
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const { error } = await supabase.from("inbound_emails").insert({
      tenant_id: payload.tenant_id,
      raw_text: payload.raw_text,
      parsed_json: parseInbound(payload.raw_text)
    });

    if (error) {
      return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 400 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ ok: false, error: message }), { status: 400 });
  }
});
