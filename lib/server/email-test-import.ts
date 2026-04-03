import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { isPdfAttachment } from "@/lib/server/pdf-text";
import { claudeEmailExtract } from "@/lib/server/claude-email-extract";

type OperationalImportAuth = {
  admin: any;
  user: { id?: string | null };
  membership: { tenant_id: string; role: string };
};

type EmailImportConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  mailbox: string;
  maxMessages: number;
  markSeen: boolean;
};

export type EmailOperationalImportResult = {
  ok: boolean;
  mailbox: string;
  unreadFound: number;
  emailsProcessed: number;
  pdfFound: number;
  draftsCreated: number;
  duplicateWarnings: number;
  skippedNoPdf: number;
};

function parseBoolean(value: string | undefined, fallback: boolean) {
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parsePositiveInt(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return parsed;
}

function getConfig(): EmailImportConfig {
  const host = process.env.IMAP_HOST?.trim() || process.env.EMAIL_HOST?.trim() || "";
  const user = process.env.IMAP_USER?.trim() || process.env.EMAIL_USER?.trim() || "";
  const password = process.env.IMAP_PASS || process.env.EMAIL_PASSWORD || "";
  if (!host || !user || !password) {
    throw new Error("Missing IMAP_HOST/IMAP_USER/IMAP_PASS env vars");
  }

  return {
    host,
    port: parsePositiveInt(process.env.IMAP_PORT || process.env.EMAIL_PORT, 993),
    secure: parseBoolean(process.env.IMAP_TLS || process.env.EMAIL_IMAP_TLS, true),
    user,
    password,
    mailbox: process.env.IMAP_MAILBOX?.trim() || process.env.EMAIL_IMAP_MAILBOX?.trim() || "INBOX",
    maxMessages: parsePositiveInt(process.env.EMAIL_IMAP_MAX_MESSAGES, 20),
    markSeen: parseBoolean(process.env.EMAIL_IMAP_MARK_SEEN, true)
  };
}

function normalizeSender(parsedFrom?: { value?: Array<{ address?: string | null }> } | null) {
  const address = parsedFrom?.value?.[0]?.address;
  return String(address ?? "").trim().toLowerCase();
}

function normalizeText(value: string | null | undefined) {
  return String(value ?? "").trim();
}

function isPdfMailAttachment(filename?: string | null, mimeType?: string | null) {
  return isPdfAttachment(filename ?? "", mimeType);
}

export async function runEmailOperationalImport(auth: OperationalImportAuth): Promise<EmailOperationalImportResult> {
  const config = getConfig();
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: {
      user: config.user,
      pass: config.password
    },
    tls: { rejectUnauthorized: false },
    logger: false
  });

  let unreadFound = 0;
  let emailsProcessed = 0;
  let pdfFound = 0;
  let draftsCreated = 0;
  let duplicateWarnings = 0;
  let skippedNoPdf = 0;

  try {
    console.log(`[email-import] Connessione IMAP a ${config.host}:${config.port} user=${config.user}`);
    await client.connect();
    console.log(`[email-import] IMAP connesso OK`);
    const lock = await client.getMailboxLock(config.mailbox);
    try {
      const unreadUids = await client.search({ seen: false });
      const uidList = Array.isArray(unreadUids) ? unreadUids : [];
      const targetUids = uidList.slice(-config.maxMessages);
      unreadFound = targetUids.length;

      for (const uid of targetUids) {
        const message = await client.fetchOne(uid, {
          uid: true,
          source: true,
          internalDate: true
        });
        if (!message || !message.source) continue;

        const parsed = await simpleParser(message.source);
        const sender = normalizeSender(parsed.from) || config.user;
        const subject = normalizeText(parsed.subject) || "Email con PDF";
        const bodyText = normalizeText(parsed.text || parsed.html || "");
        emailsProcessed += 1;

        console.log(`[email-import] Elaborazione email: "${subject}" da ${sender}`);

        // ── Trova allegato PDF ──────────────────────────────────────────────
        let messagePdfCount = 0;
        let firstPdfBase64: string | null = null;
        let firstPdfFilename = "allegato.pdf";
        for (const attachment of parsed.attachments ?? []) {
          const filename = normalizeText(attachment.filename);
          const contentType = normalizeText(attachment.contentType);
          if (!isPdfMailAttachment(filename, contentType)) continue;
          if (!Buffer.isBuffer(attachment.content)) continue;
          if (!firstPdfBase64) {
            firstPdfBase64 = attachment.content.toString("base64");
            firstPdfFilename = filename || "allegato.pdf";
          }
          pdfFound += 1;
          messagePdfCount += 1;
        }

        if (messagePdfCount === 0) {
          console.log(`[email-import] Nessun PDF trovato in: "${subject}"`);
          skippedNoPdf += 1;
        } else {
          console.log(`[email-import] PDF trovato: ${firstPdfFilename}, avvio Claude...`);
          // ── Estrazione Claude AI ──────────────────────────────────────────
          let claudeResult: Awaited<ReturnType<typeof claudeEmailExtract>> | null = null;
          try {
            claudeResult = await claudeEmailExtract(firstPdfBase64, bodyText, subject);
            console.log(`[email-import] Claude OK — agenzia: ${claudeResult.agency}, cliente: ${claudeResult.form.cliente_nome}`);
          } catch (err) {
            console.error(`[email-import] Claude errore:`, err);
            // Claude non disponibile — salva email senza estrazione
          }

          // ── Controlla duplicati (numero_pratica nelle inbound_emails) ────
          const practiceNumber = claudeResult?.form.numero_pratica || null;
          if (practiceNumber) {
            const { data: existingEmail } = await auth.admin
              .from("inbound_emails")
              .select("id")
              .eq("tenant_id", auth.membership.tenant_id)
              .ilike("extracted_text", `%${practiceNumber}%`)
              .limit(1)
              .maybeSingle();
            if (existingEmail?.id) {
              duplicateWarnings += 1;
              console.log(`[email-import] Duplicato pratica ${practiceNumber} — skip`);
              if (config.markSeen) {
                await client.messageFlagsAdd(uid, ["\\Seen"]);
              }
              continue;
            }
          }

          // ── Controlla duplicati (nome+telefono nei servizi già confermati) ─
          const customerName = claudeResult?.form.cliente_nome || null;
          const customerPhone = claudeResult?.form.cliente_cellulare || null;
          const dataArrivo = claudeResult?.form.data_arrivo || null;
          let duplicateServiceAlert = false;
          if (customerName && dataArrivo) {
            let dupQuery = auth.admin
              .from("services")
              .select("id, customer_name, date")
              .eq("tenant_id", auth.membership.tenant_id)
              .eq("is_draft", false)
              .ilike("customer_name", `%${customerName.split(" ")[0]}%`)
              .eq("date", dataArrivo)
              .limit(1);
            if (customerPhone) {
              dupQuery = dupQuery.ilike("phone", `%${customerPhone}%`);
            }
            const { data: dupService } = await dupQuery.maybeSingle();
            if (dupService?.id) {
              duplicateServiceAlert = true;
              console.log(`[email-import] Possibile duplicato servizio: ${customerName} il ${dataArrivo}`);
            }
          }

          // ── Salva inbound_email con dati Claude ───────────────────────────
          const parsedJson = {
            source: "imap-claude",
            from_email: sender,
            subject,
            received_at: new Date().toISOString(),
            review_status: "needs_operator_review",
            duplicate_alert: duplicateServiceAlert,
            attachments: [{ filename: firstPdfFilename, mime_type: "application/pdf", has_content: true }],
            claude_extracted: claudeResult
              ? {
                  agency: claudeResult.agency,
                  form: claudeResult.form,
                  raw_json: claudeResult.rawJson,
                  extracted_at: new Date().toISOString()
                }
              : null,
            linked_service_id: null
          };

          const { data: inboundData } = await auth.admin
            .from("inbound_emails")
            .insert({
              tenant_id: auth.membership.tenant_id,
              from_email: sender,
              subject,
              raw_text: bodyText || subject,
              body_text: bodyText || subject,
              extracted_text: claudeResult ? JSON.stringify(claudeResult.form, null, 2) : null,
              parsed_json: parsedJson
            })
            .select("id")
            .single();

          if (inboundData?.id) {
            console.log(`[email-import] Email salvata con ID: ${inboundData.id}`);
            draftsCreated += 1;
          } else {
            console.error(`[email-import] Errore salvataggio inbound_email`);
          }
        }

        if (config.markSeen) {
          await client.messageFlagsAdd(uid, ["\\Seen"]);
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    try {
      await client.logout();
    } catch {
      // ignore logout failures
    }
  }

  return {
    ok: true,
    mailbox: config.mailbox,
    unreadFound,
    emailsProcessed,
    pdfFound,
    draftsCreated,
    duplicateWarnings,
    skippedNoPdf
  };
}
