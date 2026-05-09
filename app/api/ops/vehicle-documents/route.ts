import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const BUCKET = "vehicle-documents";

const documentSchema = z.object({
  vehicle_id: z.string().uuid(),
  title: z.string().trim().min(1).max(160),
  file_path: z.string().trim().min(1).max(500),
  notes: z.string().trim().max(1000).optional().nullable(),
});

const deleteSchema = z.object({
  id: z.string().uuid(),
});

const noStoreHeaders = {
  "Cache-Control": "no-store, no-cache, must-revalidate",
};

type AuthorizedContext = Exclude<Awaited<ReturnType<typeof authorizePricingRequest>>, NextResponse>;

async function vehicleExists(ctx: AuthorizedContext, vehicleId: string) {
  const { data, error } = await ctx.admin
    .from("vehicles")
    .select("id")
    .eq("tenant_id", ctx.membership.tenant_id)
    .eq("id", vehicleId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return Boolean(data?.id);
}

async function withSignedUrls(ctx: AuthorizedContext, rows: Array<{
  id: string;
  title: string;
  file_path: string;
  uploaded_at: string;
  uploaded_by: string | null;
  notes: string | null;
}>) {
  return Promise.all(rows.map(async (row) => {
    const { data, error } = await ctx.admin.storage
      .from(BUCKET)
      .createSignedUrl(row.file_path, 300);
    return {
      ...row,
      signed_url: data?.signedUrl ?? null,
      download_error: error?.message ?? null,
    };
  }));
}

export async function GET(request: NextRequest) {
  try {
    const ctx = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
    if (ctx instanceof NextResponse) return ctx;

    const vehicleId = request.nextUrl.searchParams.get("vehicle_id") ?? "";
    if (!z.string().uuid().safeParse(vehicleId).success) {
      return NextResponse.json({ ok: false, error: "vehicle_id non valido." }, { status: 400, headers: noStoreHeaders });
    }

    if (!(await vehicleExists(ctx, vehicleId))) {
      return NextResponse.json({ ok: false, error: "Veicolo non trovato." }, { status: 404, headers: noStoreHeaders });
    }

    const { data, error } = await ctx.admin
      .from("vehicle_documents")
      .select("id, title, file_path, uploaded_at, uploaded_by, notes")
      .eq("tenant_id", ctx.membership.tenant_id)
      .eq("vehicle_id", vehicleId)
      .order("uploaded_at", { ascending: false });
    if (error) throw new Error(error.message);

    const documents = await withSignedUrls(ctx, data ?? []);
    return NextResponse.json({ ok: true, documents }, { headers: noStoreHeaders });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Errore documenti veicolo." },
      { status: 500, headers: noStoreHeaders }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const ctx = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
    if (ctx instanceof NextResponse) return ctx;

    const parsed = documentSchema.parse(await request.json().catch(() => ({})));
    if (!parsed.file_path.startsWith(`${parsed.vehicle_id}/`)) {
      return NextResponse.json({ ok: false, error: "Percorso documento non coerente con il veicolo." }, { status: 400, headers: noStoreHeaders });
    }
    if (!(await vehicleExists(ctx, parsed.vehicle_id))) {
      return NextResponse.json({ ok: false, error: "Veicolo non trovato." }, { status: 404, headers: noStoreHeaders });
    }

    const { data, error } = await ctx.admin
      .from("vehicle_documents")
      .insert({
        tenant_id: ctx.membership.tenant_id,
        vehicle_id: parsed.vehicle_id,
        title: parsed.title,
        file_path: parsed.file_path,
        uploaded_by: ctx.user.id,
        notes: parsed.notes || null,
      })
      .select("id, title, file_path, uploaded_at, uploaded_by, notes")
      .single();
    if (error) throw new Error(error.message);

    const [document] = await withSignedUrls(ctx, [data]);
    return NextResponse.json({ ok: true, document }, { headers: noStoreHeaders });
  } catch (error) {
    const status = error instanceof z.ZodError ? 400 : 500;
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Errore salvataggio documento." },
      { status, headers: noStoreHeaders }
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const ctx = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
    if (ctx instanceof NextResponse) return ctx;

    const parsed = deleteSchema.parse(await request.json().catch(() => ({})));
    const { data: document, error: findError } = await ctx.admin
      .from("vehicle_documents")
      .select("id, file_path")
      .eq("tenant_id", ctx.membership.tenant_id)
      .eq("id", parsed.id)
      .maybeSingle();
    if (findError) throw new Error(findError.message);
    if (!document?.id) {
      return NextResponse.json({ ok: false, error: "Documento non trovato." }, { status: 404, headers: noStoreHeaders });
    }

    const { error: deleteError } = await ctx.admin
      .from("vehicle_documents")
      .delete()
      .eq("tenant_id", ctx.membership.tenant_id)
      .eq("id", parsed.id);
    if (deleteError) throw new Error(deleteError.message);

    await ctx.admin.storage.from(BUCKET).remove([document.file_path]);
    return NextResponse.json({ ok: true }, { headers: noStoreHeaders });
  } catch (error) {
    const status = error instanceof z.ZodError ? 400 : 500;
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Errore rimozione documento." },
      { status, headers: noStoreHeaders }
    );
  }
}
