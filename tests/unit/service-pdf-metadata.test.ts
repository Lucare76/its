import { describe, expect, it } from "vitest";
import { getServiceOperationalSource, getServicePdfOperationalMeta } from "@/lib/service-pdf-metadata";
import type { InboundEmail, Service } from "@/lib/types";

/**
 * Regression coverage for the isPdf-always-true bug: safeRecord() always
 * returned at least {}, so Boolean(safeRecord(pdf_import)) was always true
 * regardless of whether pdf_import actually existed. Fixed by checking the
 * raw pre-safeRecord value's shape instead (see lib/service-pdf-metadata.ts).
 */

function service(overrides: Partial<Service> = {}): Service {
  return {
    id: "s1",
    tenant_id: "tenant-1",
    date: "2026-08-16",
    time: "10:00",
    direction: "arrival",
    vessel: "Alilauro",
    pax: 2,
    hotel_id: "hotel-1",
    customer_name: "Cliente Test",
    phone: "3331234567",
    notes: "",
    status: "new",
    ...overrides
  };
}

function inboundEmail(overrides: Partial<InboundEmail> = {}): InboundEmail {
  return {
    id: "ie1",
    tenant_id: "tenant-1",
    raw_text: "raw",
    parsed_json: {},
    ...overrides
  } as InboundEmail;
}

describe("getServicePdfOperationalMeta / getServiceOperationalSource", () => {
  it("1. real PDF service: parsed_json.pdf_import present -> isPdf=true, source=pdf", () => {
    const inbound = inboundEmail({
      id: "ie-pdf",
      parsed_json: { pdf_import: { parser_key: "royal", parsing_quality: "high" } } as any
    });
    const s = service({ inbound_email_id: "ie-pdf" });
    const meta = getServicePdfOperationalMeta(s, [inbound]);
    expect(meta.isPdf).toBe(true);
    expect(getServiceOperationalSource(s, [inbound])).toBe("pdf");
  });

  it("2. pure manual service: no inbound_email, no agency_id, no PDF marker -> isPdf=false, source=manual", () => {
    const s = service();
    const meta = getServicePdfOperationalMeta(s, []);
    expect(meta.isPdf).toBe(false);
    expect(getServiceOperationalSource(s, [])).toBe("manual");
  });

  it("3. agency service: agency_id present, no PDF -> source=agency", () => {
    const s = service({ agency_id: "agency-1" });
    const meta = getServicePdfOperationalMeta(s, []);
    expect(meta.isPdf).toBe(false);
    expect(getServiceOperationalSource(s, [])).toBe("agency");
  });

  it("4. missing parsed_json (no linked inbound email) -> not PDF", () => {
    const s = service({ inbound_email_id: null });
    const meta = getServicePdfOperationalMeta(s, []);
    expect(meta.isPdf).toBe(false);
  });

  it("5. parsed_json = {} -> not PDF", () => {
    const inbound = inboundEmail({ id: "ie-empty", parsed_json: {} });
    const s = service({ inbound_email_id: "ie-empty" });
    const meta = getServicePdfOperationalMeta(s, [inbound]);
    expect(meta.isPdf).toBe(false);
  });

  it("6. pdf_import = null -> not PDF", () => {
    const inbound = inboundEmail({ id: "ie-null", parsed_json: { pdf_import: null } as any });
    const s = service({ inbound_email_id: "ie-null" });
    const meta = getServicePdfOperationalMeta(s, [inbound]);
    expect(meta.isPdf).toBe(false);
  });

  it("7. pdf_import = [] -> not PDF", () => {
    const inbound = inboundEmail({ id: "ie-array", parsed_json: { pdf_import: [] } as any });
    const s = service({ inbound_email_id: "ie-array" });
    const meta = getServicePdfOperationalMeta(s, [inbound]);
    expect(meta.isPdf).toBe(false);
  });

  it("8. notes marker [source:pdf] -> stays PDF even without pdf_import", () => {
    const s = service({ notes: "[source:pdf]" });
    const meta = getServicePdfOperationalMeta(s, []);
    expect(meta.isPdf).toBe(true);
    expect(getServiceOperationalSource(s, [])).toBe("pdf");
  });

  it("9. excursion_details.source = pdf -> stays PDF", () => {
    const s = service({ excursion_details: { source: "pdf" } });
    const meta = getServicePdfOperationalMeta(s, []);
    expect(meta.isPdf).toBe(true);
    expect(getServiceOperationalSource(s, [])).toBe("pdf");
  });

  it("10. reviewRecommended: a pure manual service is not flagged just for lacking PDF metadata", () => {
    const s = service();
    const meta = getServicePdfOperationalMeta(s, []);
    expect(meta.reviewRecommended).toBe(false);
  });
});
