/**
 * Fase 2B.6 — email tecnica Medmar: source of truth server-side, globale
 * per ITS, MAI derivata da services.customer_email / agencies.email /
 * input browser. Stesso pattern di lettura env di issue-config.ts.
 */
function clean(value: string | undefined): string {
  return (value ?? "").trim().replace(/^["']|["']$/g, "");
}

export type MedmarDeliveryConfig = {
  technicalEmail: string | null;
};

export function getMedmarDeliveryConfig(): MedmarDeliveryConfig {
  const email = clean(process.env.MEDMAR_DELIVERY_EMAIL);
  return { technicalEmail: email.length > 0 ? email : null };
}
