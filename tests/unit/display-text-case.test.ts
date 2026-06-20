import { describe, expect, it } from "vitest";
import { displaySentenceCase, displayTitleCase } from "@/lib/display-text-case";

describe("display text case", () => {
  it("softens all-uppercase English service titles", () => {
    expect(displayTitleCase("CAPRI WITH PRIVATE GUIDE", "en")).toBe("Capri with Private Guide");
    expect(displayTitleCase("TRANSFER FROM VILLA ARAUCARIA TO NAPLES", "en"))
      .toBe("Transfer from Villa Araucaria to Naples");
    expect(displayTitleCase("5-HOUR ISLAND TOUR", "en")).toBe("5-Hour Island Tour");
  });

  it("softens all-uppercase descriptions and preserves known acronyms", () => {
    expect(displaySentenceCase("INCLUDES FERRY TICKET AND EXCLUSIVE GUIDE FOR THE GROUP. SNAV TICKET INCLUDED."))
      .toBe("Includes ferry ticket and exclusive guide for the group. SNAV ticket included.");
  });

  it("does not modify text that already has intentional casing", () => {
    expect(displayTitleCase("Airport Transfer", "en")).toBe("Airport Transfer");
    expect(displaySentenceCase("Meet us at Sant'Angelo.")).toBe("Meet us at Sant'Angelo.");
  });
});
