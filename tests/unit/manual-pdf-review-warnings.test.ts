import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BELOTTI_AMBIGUOUS, BELOTTI_LIKE, SAMORI_LIKE } from "./fixtures/aleste-pdf-texts";

/**
 * Caricamento manuale PDF (POST /api/email/preview-pdf usato dalla Inbox,
 * POST /api/pdf/claude-extract usato da PdfClaudeUploader): gli avvisi dei
 * controlli deterministici Aleste devono arrivare alla UI esattamente come
 * nell'import IMAP (parsed_json.review_warnings) e il banner
 * "Verifica manuale richiesta" deve mostrarli.
 *
 * Il percorso è reale (extractWithHaiku + applyAlesteDeterministicChecks):
 * sono simulati solo il testo PDF (pdf-parse) e la risposta del modello.
 */

const mocks = vi.hoisted(() => ({
  authorizePricingRequest: vi.fn(),
  pdfText: "",
}));

vi.mock("@/lib/server/pricing-auth", () => ({ authorizePricingRequest: mocks.authorizePricingRequest }));
vi.mock("@/lib/server/ai-usage-log", () => ({
  logAiUsage: vi.fn(async () => null),
  updateAiUsageImportId: vi.fn(async () => undefined),
}));
vi.mock("pdf-parse", () => ({ default: vi.fn(async () => ({ text: mocks.pdfText })) }));

import { POST as previewPdf } from "@/app/api/email/preview-pdf/route";
import { POST as claudeExtract } from "@/app/api/pdf/claude-extract/route";
import { ReviewWarningsBanner } from "@/components/review-warnings-banner";

type AiJson = Record<string, unknown>;

function haikuJson(overrides: AiJson): AiJson {
  return {
    numero_pratica: "26/015867",
    cliente_nome: "CLIENTE TEST",
    cliente_cellulare: "3330000000",
    n_pax: 2,
    hotel: "LA VILLA RESORT & SPA",
    data_arrivo: "2026-10-29",
    data_partenza: "2026-11-08",
    orario_arrivo: "12:38",
    orario_partenza: "13:20",
    numero_mezzo_andata: "ITA 8903",
    numero_mezzo_ritorno: "ITA 9940",
    citta_partenza: "BOLOGNA",
    totale_pratica: 336,
    tipo_servizio: "transfer_station_hotel",
    agenzia: "Aleste Viaggi",
    note_operative: null,
    agency_key: "aleste",
    ...overrides,
  };
}

function scenario(pdfText: string, ai: AiJson) {
  mocks.pdfText = pdfText;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    content: [{ text: JSON.stringify(ai) }],
    usage: { input_tokens: 10, output_tokens: 10 },
  }), { status: 200, headers: { "content-type": "application/json" } })));
}

const SUBJECT = "CONFERMA D'ORDINE n. 009404 | pr. 26/015867 LA VILLA RESORT & SPA - SAMORI GIUSEPPE";

async function callPreviewPdf() {
  const form = new FormData();
  form.append("file", new File([Buffer.from("%PDF-1.4 fake")], "conferma.pdf", { type: "application/pdf" }));
  form.append("subject", SUBJECT);
  const res = await previewPdf(new NextRequest("http://localhost:3010/api/email/preview-pdf", { method: "POST", body: form }));
  return (await res.json()) as {
    ok: boolean;
    review_warnings: string[];
    claude_extracted: { form: Record<string, string>; review_warnings: string[] };
  };
}

async function callClaudeExtract() {
  const res = await claudeExtract(new NextRequest("http://localhost:3010/api/pdf/claude-extract", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pdf_base64: Buffer.from("%PDF-1.4 fake").toString("base64"), email_subject: SUBJECT }),
  }));
  return (await res.json()) as { ok: boolean; review_warnings: string[]; form: Record<string, string> };
}

function bannerHtml(warnings: unknown) {
  return renderToStaticMarkup(createElement(ReviewWarningsBanner, { warnings }));
}

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  mocks.authorizePricingRequest.mockResolvedValue({
    admin: {},
    user: { id: "user-1", email: "op@test.dev" },
    membership: { tenant_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", role: "operator", suspended: false },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("preview PDF manuale (Inbox) — review_warnings visibili come nell'import IMAP", () => {
  it("pax AI incoerente col PDF (AI 1, PDF 6) -> n_pax 6 + warning restituito e mostrato nel banner", async () => {
    scenario(SAMORI_LIKE, haikuJson({ n_pax: 1 }));
    const body = await callPreviewPdf();
    expect(body.ok).toBe(true);
    expect(body.claude_extracted.form.n_pax).toBe("6");
    expect(body.review_warnings).toEqual([expect.stringMatching(/n_pax corretto da 1 a 6/)]);
    // Stesso dato anche dentro claude_extracted (è ciò che la Inbox conserva in preview).
    expect(body.claude_extracted.review_warnings).toEqual(body.review_warnings);

    const html = bannerHtml(body.claude_extracted.review_warnings);
    expect(html).toContain("Verifica manuale richiesta");
    expect(html).toContain("n_pax corretto da 1 a 6");
    expect(html).toContain('role="alert"');
  });

  it("treno ritorno ambiguo per le 17:45 -> campo vuoto + warning visibile", async () => {
    scenario(BELOTTI_AMBIGUOUS, haikuJson({ n_pax: 3, totale_pratica: 168, orario_partenza: "17:45", numero_mezzo_ritorno: "ITA 8524", data_partenza: "2026-10-11" }));
    const body = await callPreviewPdf();
    expect(body.claude_extracted.form.treno_ritorno).toBe("");
    expect(body.review_warnings).toEqual([expect.stringMatching(/Più treni candidati per la partenza delle 17:45/)]);
    expect(bannerHtml(body.review_warnings)).toContain("Più treni candidati per la partenza delle 17:45");
  });

  it("caso corretto -> nessun warning, nessun banner", async () => {
    scenario(BELOTTI_LIKE, haikuJson({ n_pax: 3, totale_pratica: 168, orario_partenza: "17:45", numero_mezzo_ritorno: "ITA 8524", data_partenza: "2026-10-11" }));
    const body = await callPreviewPdf();
    expect(body.claude_extracted.form.n_pax).toBe("3");
    expect(body.claude_extracted.form.treno_ritorno).toBe("ITA 8524");
    expect(body.review_warnings).toEqual([]);
    expect(bannerHtml(body.review_warnings)).toBe("");
  });
});

describe("claude-extract (PdfClaudeUploader) — stesso comportamento", () => {
  it("pax AI incoerente col PDF -> form corretto + warning", async () => {
    scenario(SAMORI_LIKE, haikuJson({ n_pax: 1 }));
    const body = await callClaudeExtract();
    expect(body.ok).toBe(true);
    expect(body.form.n_pax).toBe("6");
    expect(body.review_warnings).toEqual([expect.stringMatching(/n_pax corretto da 1 a 6/)]);
  });

  it("treno ritorno ambiguo -> campo vuoto + warning", async () => {
    scenario(BELOTTI_AMBIGUOUS, haikuJson({ n_pax: 3, totale_pratica: 168, orario_partenza: "17:45", numero_mezzo_ritorno: "ITA 8524", data_partenza: "2026-10-11" }));
    const body = await callClaudeExtract();
    expect(body.form.treno_ritorno).toBe("");
    expect(body.review_warnings).toEqual([expect.stringMatching(/Più treni candidati per la partenza delle 17:45/)]);
  });

  it("caso corretto -> nessun warning", async () => {
    scenario(SAMORI_LIKE, haikuJson({ n_pax: 6 }));
    const body = await callClaudeExtract();
    expect(body.form.n_pax).toBe("6");
    expect(body.review_warnings).toEqual([]);
  });
});

describe("ReviewWarningsBanner — input non fidato", () => {
  it("ignora valori non stringa / vuoti e non rende nulla senza avvisi", () => {
    expect(bannerHtml(undefined)).toBe("");
    expect(bannerHtml(["", 42, null])).toBe("");
    expect(bannerHtml("non un array")).toBe("");
  });
});
