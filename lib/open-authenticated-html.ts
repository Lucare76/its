import { supabase } from "@/lib/supabase/client";

export async function openAuthenticatedHtml(url: string) {
  if (!supabase) {
    alert("Configurazione Supabase mancante.");
    return;
  }

  const { data, error } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (error || !token) {
    alert("Sessione non valida. Effettua di nuovo il login.");
    return;
  }

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    alert(body?.error ?? "Impossibile aprire la stampa giornata.");
    return;
  }

  const html = await response.text();
  const blobUrl = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
  window.open(blobUrl, "_blank", "noopener,noreferrer");
  window.setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
}
