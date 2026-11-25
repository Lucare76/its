/**
 * Come è stato pagato un rifornimento (colonna vehicle_fuel.invoice_supplier).
 * È la CARTA usata, non la marca del distributore: una carta UTA si usa anche
 * alle pompe Q8 e il rifornimento arriva nella fattura UTA.
 */
export const FUEL_PAYMENT_METHODS = ["ENI", "UTA", "Q8", "CONTANTI"] as const;
export type FuelPaymentMethod = (typeof FUEL_PAYMENT_METHODS)[number];

/** Fornitori di cui sappiamo leggere e confrontare la fattura PDF. */
export const FUEL_INVOICE_IMPORT_SUPPLIERS = ["ENI", "UTA"] as const;
export type FuelInvoiceImportSupplier = (typeof FUEL_INVOICE_IMPORT_SUPPLIERS)[number];

export const FUEL_PAYMENT_LABELS: Record<FuelPaymentMethod, string> = {
  ENI: "Carta ENI",
  UTA: "Carta UTA",
  Q8: "Carta Q8",
  CONTANTI: "Contanti / carta di credito personale (da rimborsare)",
};

export function isFuelPaymentMethod(value: unknown): value is FuelPaymentMethod {
  return typeof value === "string" && (FUEL_PAYMENT_METHODS as readonly string[]).includes(value);
}

export function fuelPaymentLabel(value: string | null | undefined): string {
  return value && isFuelPaymentMethod(value) ? FUEL_PAYMENT_LABELS[value] : "Da associare";
}

export function isCashFuel(value: string | null | undefined): boolean {
  return value === "CONTANTI";
}
