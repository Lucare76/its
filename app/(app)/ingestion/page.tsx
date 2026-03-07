"use client";

import { useMemo, useState } from "react";
import { useDemoStore } from "@/lib/use-demo-store";
import { inboundWebhookSchema } from "@/lib/validation";

export default function IngestionPage() {
  const { addInboundEmail } = useDemoStore();
  const [token, setToken] = useState("");
  const [mailbox, setMailbox] = useState("test-mailbox@demo.local");
  const [templateKey, setTemplateKey] = useState("agency-default");
  const [fromEmail, setFromEmail] = useState("agency@demo.com");
  const [subject, setSubject] = useState("Nuovo transfer - arrivo");
  const [rawEmail, setRawEmail] = useState(
    "DATA 2026-03-02 ORA 15:30 NAVE Medmar HOTEL Hotel Forio 2 PAX 3 NOME Anna Bianchi TEL +39 333 5558899"
  );
  const [attachmentsRaw, setAttachmentsRaw] = useState('[{"filename":"voucher.pdf","mime_type":"application/pdf","size_bytes":128400}]');
  const [pdfAttachmentBase64, setPdfAttachmentBase64] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("Compila il test mailbox flow e invia all'endpoint inbound.");

  const curlPreview = useMemo(() => {
    return [
      "curl -X POST http://localhost:3010/api/inbound/email \\",
      `  -H "x-inbound-token: ${token || "<EMAIL_INBOUND_TOKEN>"}" \\`,
      '  -H "content-type: application/json" \\',
      '  -d \'{"subject":"Nuovo transfer","from":"agency@example.com","body_text":"...","attachments":[] }\''
    ].join("\n");
  }, [token]);

  const submit = async () => {
    setLoading(true);
    setMessage("");

    let attachments: Array<{ filename: string; mime_type?: string; size_bytes?: number }> = [];
    try {
      const parsed = JSON.parse(attachmentsRaw) as Array<{ filename: string; mime_type?: string; size_bytes?: number }>;
      attachments = Array.isArray(parsed) ? parsed : [];
    } catch {
      setLoading(false);
      setMessage("JSON allegati non valido.");
      return;
    }

    if (!token.trim()) {
      setLoading(false);
      setMessage("Inserisci EMAIL_INBOUND_TOKEN.");
      return;
    }

    const payload = {
      subject,
      from: fromEmail,
      body_text: rawEmail,
      body_html: "",
      attachments: attachments
        .map((item, index) => {
          const mime = item.mime_type ?? "application/octet-stream";
          const base64 = index === 0 ? pdfAttachmentBase64 : null;
          if (!base64) return null;
          return {
            filename: item.filename,
            mimetype: mime,
            base64
          };
        })
        .filter((item): item is { filename: string; mimetype: string; base64: string } => Boolean(item))
    };

    const validated = inboundWebhookSchema.safeParse({
      tenant_id: "00000000-0000-0000-0000-000000000000",
      raw_text: payload.body_text,
      source: "test-mailbox-flow",
      template_key: templateKey,
      mailbox,
      from_email: fromEmail,
      subject,
      received_at: new Date().toISOString(),
      attachments: attachments.map((item, index) => ({
        filename: item.filename,
        mime_type: item.mime_type,
        size_bytes: item.size_bytes,
        content_base64: index === 0 ? pdfAttachmentBase64 ?? undefined : undefined
      }))
    });
    if (!validated.success) {
      setLoading(false);
      setMessage(validated.error.errors[0]?.message ?? "Payload non valido.");
      return;
    }

    const response = await fetch("/api/inbound/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-inbound-token": token
      },
      body: JSON.stringify(payload)
    });

    const body = (await response.json().catch(() => null)) as
      | {
          ok?: boolean;
          id?: string;
          draft_service_id?: string;
          error?: string;
        }
      | null;

    if (!response.ok || !body?.ok || !body.id) {
      setLoading(false);
      setMessage(body?.error ?? `Errore inbound: HTTP ${response.status}`);
      return;
    }

    addInboundEmail({
      tenant_id: "00000000-0000-0000-0000-000000000000",
      raw_text: rawEmail,
      parsed_json: {
        source: "test-mailbox-flow",
        mailbox,
        from_email: fromEmail,
        subject,
        received_at: new Date().toISOString(),
        attachments: attachments.map((item) => ({
          filename: item.filename,
          mime_type: item.mime_type,
          size_bytes: item.size_bytes
        }))
      }
    });

    setLoading(false);
    setMessage(`Email inbound salvata con id ${body.id}. Draft service: ${body.draft_service_id ?? "n/a"}. Vai su Inbox.`);
  };

  return (
    <section className="mx-auto max-w-4xl space-y-4">
      <h1 className="text-2xl font-semibold">Inbound Email Ingestion (MVP)</h1>
      <article className="card space-y-3 p-4">
        <h2 className="text-sm font-semibold uppercase tracking-[0.12em] text-slate-600">Dedicated test mailbox flow</h2>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="text-sm">
            EMAIL_INBOUND_TOKEN
            <input value={token} onChange={(event) => setToken(event.target.value)} placeholder="Inserisci token" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" />
          </label>
          <label className="text-sm">
            Mailbox
            <input value={mailbox} onChange={(event) => setMailbox(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" />
          </label>
          <label className="text-sm">
            Template key
            <select value={templateKey} onChange={(event) => setTemplateKey(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2">
              <option value="agency-default">agency-default</option>
              <option value="agency-compact">agency-compact</option>
            </select>
          </label>
          <label className="text-sm">
            From
            <input value={fromEmail} onChange={(event) => setFromEmail(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" />
          </label>
          <label className="text-sm md:col-span-2">
            Subject
            <input value={subject} onChange={(event) => setSubject(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" />
          </label>
          <label className="text-sm md:col-span-2">
            Raw email body
            <textarea rows={5} value={rawEmail} onChange={(event) => setRawEmail(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          </label>
          <label className="text-sm md:col-span-2">
            Attachments metadata (JSON array)
            <textarea rows={4} value={attachmentsRaw} onChange={(event) => setAttachmentsRaw(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          </label>
          <label className="text-sm md:col-span-2">
            PDF upload (optional, first attachment receives content_base64)
            <input
              type="file"
              accept="application/pdf,.pdf"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) {
                  setPdfAttachmentBase64(null);
                  return;
                }
                const reader = new FileReader();
                reader.onload = () => {
                  const result = typeof reader.result === "string" ? reader.result : "";
                  const base64 = result.includes(",") ? result.split(",")[1] : result;
                  setPdfAttachmentBase64(base64 || null);
                };
                reader.readAsDataURL(file);
              }}
            />
            <p className="mt-1 text-xs text-slate-500">
              {pdfAttachmentBase64 ? "PDF content attached (base64)." : "No PDF attached."}
            </p>
          </label>
        </div>
        <button type="button" onClick={() => void submit()} disabled={loading} className="rounded-lg bg-brand-600 px-4 py-2 text-white disabled:opacity-50">
          {loading ? "Invio..." : "Send test inbound email"}
        </button>
        <p className="text-sm text-slate-600">{message}</p>
      </article>

      <article className="card space-y-2 p-4">
        <h2 className="text-sm font-semibold uppercase tracking-[0.12em] text-slate-600">Endpoint contract</h2>
        <p className="text-sm text-slate-600">
          Endpoint: <code>POST /api/inbound/email</code> protetto da header <code>x-inbound-token</code> ={" "}
          <code>EMAIL_INBOUND_TOKEN</code>.
        </p>
        <pre className="overflow-x-auto rounded-lg bg-slate-900 p-3 text-xs text-slate-100">{curlPreview}</pre>
      </article>
    </section>
  );
}
