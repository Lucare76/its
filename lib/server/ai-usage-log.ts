import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { calcAiCost } from "@/lib/ai-pricing";

export type AiUsageSource = "imap" | "manual";

export type AiUsageLogEntry = {
  tenantId: string;
  importId?: string | null;
  source: AiUsageSource;
  model: string;
  inputTokens: number;
  outputTokens: number;
  failed?: boolean;
  errorMessage?: string | null;
};

let usageAdminClient: SupabaseClient | null = null;

function getUsageAdminClient(): SupabaseClient | null {
  if (usageAdminClient) return usageAdminClient;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/^["']|["']$/g, "");
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim().replace(/^["']|["']$/g, "");
  if (!supabaseUrl || !serviceRoleKey) return null;
  usageAdminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  return usageAdminClient;
}

/**
 * Logga una chiamata AI di importazione (fire-and-forget: non deve mai
 * interrompere il flusso di importazione). Ritorna l'id della riga inserita
 * (per un eventuale updateAiUsageImportId successivo) o null se il logging
 * non è disponibile/fallito.
 */
export async function logAiUsage(entry: AiUsageLogEntry): Promise<string | null> {
  const admin = getUsageAdminClient();
  if (!admin) return null;

  const failed = entry.failed ?? false;
  let costUsd = 0;
  if (!failed) {
    try {
      costUsd = calcAiCost(entry.model, entry.inputTokens, entry.outputTokens);
    } catch (err) {
      console.error("[ai-usage-log] prezzo non configurato:", err);
    }
  }

  try {
    const { data } = await admin
      .from("ai_usage_log")
      .insert({
        tenant_id: entry.tenantId,
        import_id: entry.importId ?? null,
        source: entry.source,
        provider: "anthropic",
        model: entry.model,
        input_tokens: entry.inputTokens,
        output_tokens: entry.outputTokens,
        cost_usd: costUsd,
        failed,
        error_message: entry.errorMessage ?? null
      })
      .select("id")
      .single();
    return (data?.id as string | undefined) ?? null;
  } catch (err) {
    console.error("[ai-usage-log] insert fallito:", err);
    return null;
  }
}

/** Collega a posteriori una riga di log al record di importazione (inbound_emails) creato dopo la chiamata AI. */
export async function updateAiUsageImportId(logId: string, importId: string): Promise<void> {
  const admin = getUsageAdminClient();
  if (!admin) return;
  try {
    await admin.from("ai_usage_log").update({ import_id: importId }).eq("id", logId);
  } catch (err) {
    console.error("[ai-usage-log] update import_id fallito:", err);
  }
}
