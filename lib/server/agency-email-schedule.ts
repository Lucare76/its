import { createHash } from "crypto";

export function previousAgencyInvoicePeriod(cadence: string, todayIso: string) {
  const today = new Date(`${todayIso}T12:00:00Z`);
  const to = new Date(today);
  to.setUTCDate(to.getUTCDate() - 1);
  const from = new Date(today);
  if (cadence === "monthly") {
    from.setUTCDate(1);
    from.setUTCMonth(from.getUTCMonth() - 1);
  } else {
    from.setUTCDate(from.getUTCDate() - (cadence === "biweekly" ? 14 : 7));
  }
  return { periodFrom: from.toISOString().slice(0, 10), periodTo: to.toISOString().slice(0, 10) };
}

/** UUID v5 stabile: la PK esistente impedisce due inserimenti automatici concorrenti. */
export function scheduledAgencyInvoiceId(tenantId: string, agencyId: string, periodFrom: string, periodTo: string) {
  const namespace = Buffer.from("3a5b610587874c61b8931e0cbaf8dd18", "hex");
  const bytes = createHash("sha1")
    .update(namespace)
    .update(JSON.stringify(["its:agency-invoice:v1", tenantId, agencyId, periodFrom, periodTo]))
    .digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
