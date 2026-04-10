const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const prisma = require('./prisma');

const DEFAULT_SERVICE = String(process.env.IMAP_DEFAULT_SERVICE || 'transfer').toLowerCase();

let schedulerTimer = null;
let isRunning = false;

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return parsed;
}

function normalizeService(text) {
  const source = String(text || '').toLowerCase();
  if (/\bbus\b/.test(source)) return 'bus';
  if (/\b(transfer|navetta|shuttle|taxi|auto privata)\b/.test(source)) return 'transfer';
  return DEFAULT_SERVICE;
}

function normalizeTravelMode(text) {
  const source = String(text || '').toLowerCase();
  if (/\b(train|treno|trenitalia|italo|intercity)\b/.test(source)) return 'TRAIN';
  if (/\b(ship|ferry|nave|aliscafo|caremar|snav|alilauro|medmar)\b/.test(source)) return 'SHIP';
  return null;
}

function parsePassengers(text) {
  const source = String(text || '');
  const withLabel = source.match(/(?:passengers?|pax|persone|people|adulti)\s*[:\-]?\s*(\d{1,2})/i);
  if (withLabel) return Number(withLabel[1]);
  const inverse = source.match(/\b(\d{1,2})\s*(?:pax|persone|people)\b/i);
  if (inverse) return Number(inverse[1]);
  return null;
}

function parsePrice(text) {
  const source = String(text || '').replace(',', '.');
  const withLabel = source.match(/(?:totale|price|prezzo)\s*[:\-]?\s*(\d+(?:\.\d{1,2})?)/i);
  if (withLabel) return Number(withLabel[1]);
  const withCurrency = source.match(/(?:€|eur|euro)\s*(\d+(?:\.\d{1,2})?)/i);
  if (withCurrency) return Number(withCurrency[1]);
  return null;
}

function parseHotelName(text) {
  const source = String(text || '');
  const match = source.match(/(?:hotel|struttura|destinazione)\s*[:\-]\s*([^\n\r,;]+)/i);
  if (!match) return null;
  const name = String(match[1] || '').trim();
  return name || null;
}

function parseTravelRef(text) {
  const source = String(text || '');
  const companyRef = source.match(/\b(?:SNAV|CAREMAR|ALILAURO|MEDMAR|TRENITALIA|ITALO|INTERCITY)\b[^\n\r]{0,40}/i);
  if (companyRef) return String(companyRef[0]).trim();
  const genericRef = source.match(/(?:rif\.?|reference|ref)\s*[:\-]\s*([^\n\r,;]+)/i);
  if (genericRef) return String(genericRef[1] || '').trim() || null;
  return null;
}

function parseArrivalAt(text) {
  const source = String(text || '');
  const iso = source.match(/\b\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}(?::\d{2})?(?:Z)?\b/);
  if (iso) {
    const value = iso[0].includes('T') ? iso[0] : iso[0].replace(' ', 'T');
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  const european = source.match(/\b(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})\b/);
  if (european) {
    const [, day, month, year, hour, minute] = european;
    const parsed = new Date(`${year}-${month}-${day}T${hour}:${minute}:00`);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  return null;
}

async function resolveHotelIdByName(hotelName) {
  if (!hotelName) return null;
  const hotel = await prisma.hotel.findFirst({
    where: {
      name: {
        equals: hotelName,
        mode: 'insensitive',
      },
    },
  });
  return hotel?.id || null;
}

function getImapConfig() {
  const enabled = parseBoolean(process.env.IMAP_INGEST_ENABLED, false);
  const host = process.env.IMAP_HOST;
  const port = parsePositiveInt(process.env.IMAP_PORT, 993);
  const secure = parseBoolean(process.env.IMAP_SECURE, true);
  const user = process.env.IMAP_USER;
  const pass = process.env.IMAP_PASS;
  const mailbox = process.env.IMAP_MAILBOX || 'INBOX';
  const markSeen = parseBoolean(process.env.IMAP_MARK_SEEN, true);
  const pollMinutes = parsePositiveInt(process.env.IMAP_POLL_MINUTES, 5);
  const maxMessages = parsePositiveInt(process.env.IMAP_MAX_MESSAGES, 25);
  const tlsRejectUnauthorized = parseBoolean(process.env.IMAP_TLS_REJECT_UNAUTHORIZED, true);

  return {
    enabled,
    host,
    port,
    secure,
    auth: { user, pass },
    mailbox,
    markSeen,
    pollMinutes,
    maxMessages,
    tlsRejectUnauthorized,
  };
}

function hasImapCredentials(config) {
  return Boolean(config.host && config.auth.user && config.auth.pass);
}

async function runImapIngestOnce(options = {}) {
  const config = getImapConfig();
  if (!config.enabled) {
    return { ok: true, skipped: true, reason: 'IMAP_INGEST_ENABLED=false' };
  }
  if (!hasImapCredentials(config)) {
    return { ok: false, skipped: true, reason: 'Missing IMAP credentials' };
  }

  const limit = parsePositiveInt(options.limit, config.maxMessages);
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.auth,
    tls: {
      rejectUnauthorized: config.tlsRejectUnauthorized,
    },
    logger: false,
  });

  const stats = {
    ok: true,
    mailbox: config.mailbox,
    scanned: 0,
    created: 0,
    duplicates: 0,
    skippedUnknownAgency: 0,
    skippedInvalid: 0,
    errors: [],
  };

  try {
    await client.connect();
    const lock = await client.getMailboxLock(config.mailbox);
    try {
      const searchResult = await client.search({ seen: false });
      const selected = searchResult.slice(-limit);
      stats.scanned = selected.length;

      for (const uid of selected) {
        try {
          const message = await client.fetchOne(uid, {
            uid: true,
            source: true,
            envelope: true,
            internalDate: true,
          });
          if (!message?.source) continue;

          const parsed = await simpleParser(message.source);
          const sender = parsed.from?.value?.[0]?.address
            ? String(parsed.from.value[0].address).toLowerCase().trim()
            : null;
          const subject = String(parsed.subject || '').trim();
          const text = [subject, parsed.text || '', parsed.html ? String(parsed.html) : '']
            .filter(Boolean)
            .join('\n');

          const sourceMessageId = String(
            parsed.messageId || message.envelope?.messageId || `imap-${uid}-${Date.now()}`,
          ).trim();

          const existing = await prisma.booking.findUnique({ where: { sourceMessageId } });
          if (existing) {
            stats.duplicates += 1;
            if (config.markSeen) await client.messageFlagsAdd(uid, ['\\Seen']);
            continue;
          }

          if (!sender) {
            stats.skippedInvalid += 1;
            if (config.markSeen) await client.messageFlagsAdd(uid, ['\\Seen']);
            continue;
          }

          const agency = await prisma.user.findUnique({ where: { email: sender } });
          if (!agency || agency.role !== 'AGENCY') {
            stats.skippedUnknownAgency += 1;
            if (config.markSeen) await client.messageFlagsAdd(uid, ['\\Seen']);
            continue;
          }

          const service = normalizeService(text);
          const passengers = parsePassengers(text);
          const travelMode = normalizeTravelMode(text);
          const travelRef = parseTravelRef(text);
          const arrivalAt = parseArrivalAt(text);
          const priceTotal = parsePrice(text);
          const hotelName = parseHotelName(text);
          const hotelId = await resolveHotelIdByName(hotelName);

          if (!service || !passengers || passengers < 1) {
            stats.skippedInvalid += 1;
            if (config.markSeen) await client.messageFlagsAdd(uid, ['\\Seen']);
            continue;
          }

          await prisma.booking.create({
            data: {
              agencyId: agency.id,
              service,
              passengers,
              travelMode,
              travelRef,
              arrivalAt,
              priceTotal: Number.isFinite(priceTotal) && priceTotal > 0 ? priceTotal : null,
              hotelId,
              status: 'PENDING',
              source: 'EMAIL_IMAP',
              sourceMessageId,
              sourceSender: sender,
              sourceSubject: subject || null,
            },
          });

          stats.created += 1;
          if (config.markSeen) await client.messageFlagsAdd(uid, ['\\Seen']);
        } catch (error) {
          stats.errors.push(`uid ${uid}: ${error.message}`);
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    try {
      await client.logout();
    } catch (error) {
      // no-op
    }
  }

  return stats;
}

async function runImapIngestSafe() {
  if (isRunning) return;
  isRunning = true;
  try {
    const result = await runImapIngestOnce();
    if (!result.ok && !result.skipped) {
      console.error('[imap-ingest] sync failed', result);
    }
  } catch (error) {
    console.error('[imap-ingest] unexpected error', error.message);
  } finally {
    isRunning = false;
  }
}

function startImapIngestScheduler() {
  const config = getImapConfig();
  if (!config.enabled) {
    console.log('[imap-ingest] scheduler disabled');
    return;
  }
  if (!hasImapCredentials(config)) {
    console.warn('[imap-ingest] scheduler not started: missing IMAP credentials');
    return;
  }

  const periodMs = config.pollMinutes * 60 * 1000;
  if (schedulerTimer) clearInterval(schedulerTimer);

  runImapIngestSafe();
  schedulerTimer = setInterval(runImapIngestSafe, periodMs);
  console.log(`[imap-ingest] scheduler started every ${config.pollMinutes} minute(s)`);
}

module.exports = {
  runImapIngestOnce,
  startImapIngestScheduler,
};
