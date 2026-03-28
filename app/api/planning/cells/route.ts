import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

// GET /api/planning/cells?type=bus|route&year=2025&month=9
export async function GET(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request);
    if (auth instanceof NextResponse) return auth;

    const { searchParams } = new URL(request.url);
    const type = searchParams.get("type");
    const year = parseInt(searchParams.get("year") ?? "0", 10);
    const month = parseInt(searchParams.get("month") ?? "0", 10);

    if (!type || !year || !month || month < 1 || month > 12) {
      return NextResponse.json({ error: "Parametri mancanti o non validi." }, { status: 400 });
    }

    const tenantId = auth.membership.tenant_id;
    const startDate = `${year}-${String(month).padStart(2, "0")}-01`;
    const endDay = new Date(year, month, 0).getDate();
    const endDate = `${year}-${String(month).padStart(2, "0")}-${String(endDay).padStart(2, "0")}`;

    const { data: cells, error: cellsError } = await auth.admin
      .from("tenant_planning_cells")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("planning_type", type)
      .gte("cell_date", startDate)
      .lte("cell_date", endDate)
      .order("cell_date")
      .order("row_key")
      .order("col_index");

    if (cellsError) throw new Error(cellsError.message);

    let bus_units: unknown[] = [];
    if (type === "bus") {
      const { data: units, error: unitsError } = await auth.admin
        .from("tenant_bus_units")
        .select("id, label, capacity, status, bus_line_id, sort_order, driver_name")
        .eq("tenant_id", tenantId)
        .eq("active", true)
        .order("sort_order")
        .order("label");
      if (unitsError) throw new Error(unitsError.message);
      bus_units = units ?? [];
    }

    return NextResponse.json({ cells: cells ?? [], bus_units });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Errore interno." }, { status: 500 });
  }
}

const PostSchema = z.object({
  type: z.enum(["bus", "route"]),
  cell_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  row_key: z.string().min(1).max(200),
  col_index: z.number().int().min(0).max(99).default(0),
  content: z.string().max(500),
  bg_color: z.enum(["yellow", "red", "green", "blue", "orange"]).nullable().default("yellow"),
  service_id: z.string().uuid().nullable().optional(),
});

// POST /api/planning/cells — upsert
export async function POST(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request);
    if (auth instanceof NextResponse) return auth;

    const body = await request.json();
    const parsed = PostSchema.parse(body);
    const tenantId = auth.membership.tenant_id;

    const { error } = await auth.admin.from("tenant_planning_cells").upsert(
      {
        tenant_id: tenantId,
        planning_type: parsed.type,
        cell_date: parsed.cell_date,
        row_key: parsed.row_key,
        col_index: parsed.col_index,
        content: parsed.content,
        bg_color: parsed.bg_color,
        service_id: parsed.service_id ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "tenant_id,planning_type,cell_date,row_key,col_index" }
    );

    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Errore interno." }, { status: 500 });
  }
}

// DELETE /api/planning/cells — cancella per id
export async function DELETE(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request);
    if (auth instanceof NextResponse) return auth;

    const body = await request.json();
    const { id } = z.object({ id: z.string().uuid() }).parse(body);
    const tenantId = auth.membership.tenant_id;

    const { error } = await auth.admin
      .from("tenant_planning_cells")
      .delete()
      .eq("tenant_id", tenantId)
      .eq("id", id);

    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Errore interno." }, { status: 500 });
  }
}
