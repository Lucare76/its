import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { isPdfAttachment } from "@/lib/server/pdf-text";
import { createDraftFromPdfUpload } from "@/lib/server/agency-pdf-import";

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
    logger: false
  });

  let unreadFound = 0;
  let emailsProcessed = 0;
  let pdfFound = 0;
  let draftsCreated = 0;
  let duplicateWarnings = 0;
  let skippedNoPdf = 0;

  try {
    await client.connect();
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

        let messagePdfCount = 0;
        for (const attachment of parsed.attachments ?? []) {
          const filename = normalizeText(attachment.filename);
          const contentType = normalizeText(attachment.contentType);
          if (!isPdfMailAttachment(filename, contentType)) continue;
          if (!Buffer.isBuffer(attachment.content)) continue;

          pdfFound += 1;
          messagePdfCount += 1;

          const result = await createDraftFromPdfUpload(auth, {
            senderEmail: sender,
            subject,
            filename: filename || "allegato.pdf",
            bodyText,
            fileBytes: attachment.content,
            fileSize: attachment.content.byteLength
          });

          if (result.duplicate) {
            duplicateWarnings += 1;
            continue;
          }
          if ("draft_service_id" in result && result.draft_service_id) {
            draftsCreated += 1;
          }
        }

        if (messagePdfCount === 0) {
          skippedNoPdf += 1;
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
