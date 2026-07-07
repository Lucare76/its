import { describe, expect, it } from "vitest";
import { buildServiceQuoteVoucherHtml } from "@/lib/server/service-quote-voucher";

function queryResult(result: { data: unknown; error?: unknown }) {
  const query = {
    select: () => query,
    eq: () => query,
    order: () => query,
    single: () => Promise.resolve(result),
    maybeSingle: () => Promise.resolve(result),
    then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
  return query;
}

function adminForVoucher(language: "it" | "en") {
  const quote = {
    id: "quote-1",
    tenant_id: "tenant-1",
    quote_number: "QT-2026-0003",
    status: "confirmed",
    customer_language: language,
    customer_first_name: "Priscilla",
    customer_last_name: "Siano",
    customer_email: "priscila@example.com",
    customer_phone: "+393331234567",
    is_agency: false,
    end_customer_name: null,
    service_type: "transfer_airport",
    direction: "arrival",
    arrival_date: "2026-08-03",
    arrival_time: "10:30",
    arrival_flight_train: "AZ123",
    departure_date: null,
    departure_time: null,
    departure_flight_train: null,
    hotel_name: "Villa Araucaria",
    hotel_address: "Via Roma 1",
    pax: 2,
    luggage_notes: "2 bags",
    special_requests: "Baby seat",
  };

  return {
    from: (table: string) => {
      if (table === "service_quotes") return queryResult({ data: quote, error: null });
      if (table === "service_quote_items") return queryResult({ data: [], error: null });
      if (table === "tenants") {
        return queryResult({
          data: {
            name: "Ischia Transfer Service",
            contact_phone: "+39081123456",
            quote_company_phone: null,
            quote_company_whatsapp: "+393331234567",
          },
          error: null,
        });
      }
      return queryResult({ data: null, error: null });
    },
  };
}

describe("buildServiceQuoteVoucherHtml language", () => {
  it("renders booking voucher copy in English when quote language is en", async () => {
    const html = await buildServiceQuoteVoucherHtml(adminForVoucher("en") as never, "tenant-1", "quote-1");

    expect(html).toContain('<html lang="en">');
    expect(html).toContain('/brand/logo-email-header.png');
    expect(html).toContain("Booking voucher");
    expect(html).toContain("Included services");
    expect(html).toContain("Airport Transfer");
    expect(html).toContain("Arrival ref.");
    expect(html).toContain("Print / save PDF");
    expect(html).not.toContain("Voucher prenotazione");
    expect(html).not.toContain("Servizi inclusi");
    expect(html).not.toContain("Il giorno prima del servizio");
  });
});
