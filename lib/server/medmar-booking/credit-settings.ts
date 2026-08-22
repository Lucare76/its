/**
 * Credito Medmar gestito manualmente da impostazioni (DB) — vedi
 * supabase/migrations/0240_medmar_credit_settings.sql. Sola logica pura
 * (nessun accesso DB qui), stesso pattern di
 * lib/server/medmar-booking/delivery-summary.ts: la route fa le query e
 * delega il calcolo a queste funzioni, cosi' restano testabili senza
 * Supabase.
 *
 * Formula:
 *   available_cents = initial_credit_cents + total_topups_cents - total_issued_cents
 *
 * Priorita' sorgente credito:
 *   1. setting DB (medmar_credit_settings) -> "manual_estimated"
 *   2. env MEDMAR_MANUAL_CREDIT_CENTS, SOLO se manca il setting DB
 *      (fallback opzionale/transitorio, non obbligatorio) -> "env_estimated"
 *   3. nessuno dei due -> "unavailable" (mai un valore inventato), stesso
 *      principio gia' applicato in delivery-summary.ts#resolveMedmarCreditInfo.
 */

export type MedmarCreditSettingsRow = {
  initial_credit_cents: number;
  safety_threshold_cents: number;
  updated_at: string;
};

export type MedmarCreditTopupRow = {
  amount_cents: number;
};

export type MedmarIssuedAmountRow = {
  status: string;
  final_total_cents: number | null;
};

/** Stessa soglia iniziale di delivery-summary.ts#MEDMAR_CREDIT_SAFETY_THRESHOLD_CENTS (€200), usata quando non esiste ancora un setting DB. */
export const MEDMAR_DEFAULT_SAFETY_THRESHOLD_CENTS = 20_000;

/** Somma le ricariche registrate (medmar_credit_topups). Importi non finiti vengono ignorati (mai NaN propagato). */
export function sumMedmarTopupsCents(rows: readonly MedmarCreditTopupRow[]): number {
  return rows.reduce((sum, r) => (Number.isFinite(r.amount_cents) ? sum + r.amount_cents : sum), 0);
}

/**
 * Totale biglietti Medmar emessi (centesimi): solo emissioni con
 * status='completed' e final_total_cents valorizzato — stesso filtro usato
 * per activity/forecast in delivery-summary.ts. Il credito si scala
 * all'emissione/pagamento del biglietto, MAI alla consegna email.
 */
export function sumMedmarIssuedCentsForCredit(rows: readonly MedmarIssuedAmountRow[]): number {
  return rows.reduce((sum, r) => {
    if (r.status !== "completed" || r.final_total_cents == null) return sum;
    return sum + r.final_total_cents;
  }, 0);
}

export type MedmarManualCreditType = "manual_estimated" | "env_estimated" | "unavailable";

export type MedmarManualCreditInfo = {
  type: MedmarManualCreditType;
  initial_credit_cents: number | null;
  total_topups_cents: number | null;
  total_issued_cents: number | null;
  available_cents: number | null;
  safety_threshold_cents: number;
  updated_at: string | null;
};

/**
 * Risolve il credito Medmar stimato: preferisce sempre il setting DB (se
 * esiste) e calcola available_cents = iniziale + ricariche - emesso. Se
 * manca il setting DB, usa MEDMAR_MANUAL_CREDIT_CENTS come fallback
 * opzionale/transitorio ("env_estimated") — stessa validazione (numero
 * finito, non negativo) gia' usata da resolveMedmarCreditInfo. Se manca
 * tutto, "unavailable" (mai inventato).
 */
export function resolveMedmarManualCredit(params: {
  settings: MedmarCreditSettingsRow | null;
  totalTopupsCents: number;
  totalIssuedCents: number;
  envManualCreditCents?: string | undefined;
}): MedmarManualCreditInfo {
  const { settings, totalTopupsCents, totalIssuedCents, envManualCreditCents } = params;

  if (settings) {
    const availableCents = settings.initial_credit_cents + totalTopupsCents - totalIssuedCents;
    return {
      type: "manual_estimated",
      initial_credit_cents: settings.initial_credit_cents,
      total_topups_cents: totalTopupsCents,
      total_issued_cents: totalIssuedCents,
      available_cents: availableCents,
      safety_threshold_cents: settings.safety_threshold_cents,
      updated_at: settings.updated_at,
    };
  }

  const raw = (envManualCreditCents ?? "").trim();
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return {
        type: "env_estimated",
        initial_credit_cents: null,
        total_topups_cents: null,
        total_issued_cents: null,
        available_cents: Math.round(parsed),
        safety_threshold_cents: MEDMAR_DEFAULT_SAFETY_THRESHOLD_CENTS,
        updated_at: null,
      };
    }
  }

  return {
    type: "unavailable",
    initial_credit_cents: null,
    total_topups_cents: null,
    total_issued_cents: null,
    available_cents: null,
    safety_threshold_cents: MEDMAR_DEFAULT_SAFETY_THRESHOLD_CENTS,
    updated_at: null,
  };
}
