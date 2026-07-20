import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

const bodySchema = z.object({
  csv: z.string().min(1).max(1_000_000),
  source_file: z.string().max(240).nullable().optional(),
  commit: z.boolean().optional().default(false),
});

type ParsedRow = {
  date: string;
  pricing_category: string;
  pricing_type: string | null;
  volume: number;
  cost: number;
  source_hash: string;
};

function splitCsvLine(line: string, separator: string) {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === "\"") {
      quoted = !quoted;
      continue;
    }
    if (char === separator && !quoted) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function parseItalianDate(value: string) {
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
  if (match) {
    const [, dd, mm, yyyy] = match;
    return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  return null;
}

function parseMoney(value: string) {
  const normalized = value
    .replace(/[€\s]/g, "")
    .replace(/\./g, "")
    .replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseVolume(value: string) {
  const parsed = Number(value.replace(/\./g, "").replace(",", ".").replace(/[^\d.]/g, ""));
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

function hashRow(parts: unknown[]) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function parseMetaCsv(csv: string) {
  const lines = csv.replace(/^\uFEFF/, "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const separator = (lines.find((line) => line.includes(";")) ?? "").includes(";") ? ";" : ",";
  const parsed: ParsedRow[] = [];
  const ignored: Array<{ line: number; reason: string }> = [];
  let headerIndexes: Record<string, number> | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const cells = splitCsvLine(lines[index], separator);
    const normalized = cells.map((cell) => cell.toLowerCase());
    if (!headerIndexes) {
      const dateIdx = normalized.findIndex((cell) => cell.includes("data") || cell.includes("date"));
      const categoryIdx = normalized.findIndex((cell) => cell.includes("categoria") || cell.includes("category"));
      const volumeIdx = normalized.findIndex((cell) => cell.includes("volume"));
      const costIdx = normalized.findIndex((cell) => cell.includes("costi") || cell.includes("cost"));
      if (dateIdx >= 0 && categoryIdx >= 0 && volumeIdx >= 0 && costIdx >= 0) {
        headerIndexes = {
          date: dateIdx,
          category: categoryIdx,
          type: normalized.findIndex((cell) => cell.includes("tipo") || cell.includes("type")),
          volume: volumeIdx,
          cost: costIdx,
        };
      } else {
        ignored.push({ line: index + 1, reason: "riga informativa" });
      }
      continue;
    }

    const date = parseItalianDate(cells[headerIndexes.date] ?? "");
    const category = (cells[headerIndexes.category] ?? "").trim().toLowerCase();
    const pricingType = headerIndexes.type >= 0 ? (cells[headerIndexes.type] ?? "").trim().toLowerCase() || null : null;
    const volume = parseVolume(cells[headerIndexes.volume] ?? "");
    const cost = parseMoney(cells[headerIndexes.cost] ?? "");
    if (!date || !category || volume == null || cost == null) {
      ignored.push({ line: index + 1, reason: "riga non valida" });
      continue;
    }
    parsed.push({
      date,
      pricing_category: category,
      pricing_type: pricingType,
      volume,
      cost,
      source_hash: hashRow([date, category, pricingType, volume, cost]),
    });
  }

  const byKey = new Map<string, ParsedRow>();
  for (const row of parsed) {
    const key = `${row.date}|${row.pricing_category}|${row.pricing_type ?? ""}|${row.source_hash}`;
    if (!byKey.has(key)) byKey.set(key, row);
  }

  return {
    rows: [...byKey.values()],
    ignored,
    duplicates: parsed.length - byKey.size,
  };
}

async function estimatedFor(
  admin: SupabaseClient,
  tenantId: string,
  date: string,
  category: string,
) {
  const { data, error } = await admin
    .from("whatsapp_message_events")
    .select("estimated_cost")
    .eq("tenant_id", tenantId)
    .eq("pricing_category", category)
    .gte("delivered_at", `${date}T00:00:00.000Z`)
    .lt("delivered_at", `${date}T23:59:59.999Z`);
  if (error) throw error;
  const rows = (data ?? []) as Array<{ estimated_cost: number | null }>;
  return {
    volume: rows.length,
    cost: rows.reduce((sum, row) => sum + Number(row.estimated_cost ?? 0), 0),
  };
}

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin"]);
  if (auth instanceof NextResponse) return auth;

  const parsedBody = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsedBody.success) {
    return NextResponse.json({ error: parsedBody.error.issues[0]?.message ?? "CSV non valido." }, { status: 400 });
  }

  const tenantId = auth.membership.tenant_id;
  const parsed = parseMetaCsv(parsedBody.data.csv);
  const enriched = [];
  for (const row of parsed.rows) {
    const estimated = await estimatedFor(auth.admin, tenantId, row.date, row.pricing_category);
    enriched.push({
      ...row,
      estimated_volume: estimated.volume,
      estimated_cost: estimated.cost,
      difference: estimated.cost - row.cost,
      difference_percent: row.cost > 0 ? ((estimated.cost - row.cost) / row.cost) * 100 : null,
    });
  }

  const preview = {
    period_start: enriched.map((row) => row.date).sort()[0] ?? null,
    period_end: enriched.map((row) => row.date).sort().at(-1) ?? null,
    valid_rows: enriched.length,
    ignored_rows: parsed.ignored.length,
    duplicate_rows: parsed.duplicates,
    volume_total: enriched.reduce((sum, row) => sum + row.volume, 0),
    cost_total: enriched.reduce((sum, row) => sum + row.cost, 0),
    categories: Array.from(new Set(enriched.map((row) => row.pricing_category))),
    rows: enriched,
    ignored: parsed.ignored.slice(0, 25),
  };

  if (!parsedBody.data.commit) {
    return NextResponse.json({ ok: true, preview });
  }

  const rows = enriched.map((row) => ({
    tenant_id: tenantId,
    period_start: row.date,
    period_end: row.date,
    pricing_category: row.pricing_category,
    pricing_type: row.pricing_type ?? "",
    estimated_volume: row.estimated_volume,
    estimated_cost: row.estimated_cost,
    meta_reported_volume: row.volume,
    meta_reported_cost: row.cost,
    difference: row.difference,
    source_file: parsedBody.data.source_file ?? null,
    source_hash: row.source_hash,
    reconciled_at: new Date().toISOString(),
  }));

  if (rows.length > 0) {
    const { error } = await auth.admin
      .from("whatsapp_cost_reconciliations")
      .upsert(rows, {
        onConflict: "tenant_id,period_start,period_end,pricing_category,pricing_type,source_hash",
      });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, imported: rows.length, preview });
}
