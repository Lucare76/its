const express = require('express');
const PDFDocument = require('pdfkit');
const prisma = require('../lib/prisma');
const { logActivity } = require('../lib/audit');
const { requireAuth, requireRole } = require('../middleware/auth');
const { sendStatementEmail, hasSmtpConfig } = require('../lib/mailer');

const router = express.Router();

router.use(requireAuth);
router.use(requireRole('OPERATOR'));

const SERVICE_RATES = {
  transfer: 25,
  bus: 18,
  ferry: 35,
  excursion: 40,
};

function toCsvValue(value) {
  if (value === null || value === undefined) return '';
  const text = String(value).replace(/"/g, '""');
  return `"${text}"`;
}

async function getStatementById(statementId) {
  return prisma.accountStatement.findUnique({
    where: { id: statementId },
    include: {
      agency: {
        select: { id: true, name: true, email: true },
      },
    },
  });
}

function buildStatementPdf(doc, statement) {
  doc.fontSize(18).text('Ischia Transfer Service - Estratto Conto', { align: 'left' });
  doc.moveDown(1);
  doc.fontSize(12).text(`ID estratto: ${statement.id}`);
  doc.text(`Agenzia: ${statement.agency?.name || '-'}`);
  doc.text(`Email: ${statement.agency?.email || '-'}`);
  doc.text(`Periodo: ${new Date(statement.periodStart).toLocaleDateString('it-IT')} - ${new Date(statement.periodEnd).toLocaleDateString('it-IT')}`);
  doc.moveDown(0.5);
  doc.text(`Servizi confermati: ${statement.bookingsCount}`);
  doc.text(`Passeggeri totali: ${statement.passengersSum}`);
  doc.text(`Totale lordo: ${Number(statement.grossTotal || 0).toFixed(2)} EUR`);
  doc.moveDown(0.5);
  doc.text(`Generato il: ${new Date(statement.generatedAt).toLocaleString('it-IT')}`);
}

function createStatementPdfBuffer(statement) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];

    doc.on('data', chunk => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    buildStatementPdf(doc, statement);
    doc.end();
  });
}

function toUtcStartOfDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0));
}

function toUtcEndOfDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59, 999));
}

function getPreviousWeekRange(referenceDate = new Date()) {
  const ref = new Date(referenceDate);
  const day = ref.getUTCDay();
  const mondayOffset = (day + 6) % 7;
  const currentWeekStart = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate(), 0, 0, 0, 0));
  currentWeekStart.setUTCDate(currentWeekStart.getUTCDate() - mondayOffset);

  const periodEnd = new Date(currentWeekStart.getTime() - 1);
  const periodStart = new Date(currentWeekStart);
  periodStart.setUTCDate(periodStart.getUTCDate() - 7);

  return {
    periodStart,
    periodEnd,
  };
}

function estimateBookingAmount(booking) {
  if (typeof booking.priceTotal === 'number' && Number.isFinite(booking.priceTotal)) {
    return booking.priceTotal;
  }

  const serviceKey = String(booking.service || '').toLowerCase();
  const rate = SERVICE_RATES[serviceKey] || 20;
  const passengers = Number(booking.passengers || 0);
  return rate * passengers;
}

router.get('/statements', async (req, res) => {
  const dateFrom = String(req.query.dateFrom || '').trim();
  const dateTo = String(req.query.dateTo || '').trim();

  const where = {};
  if (dateFrom || dateTo) {
    where.periodStart = {};
    if (dateFrom) {
      const from = toUtcStartOfDay(new Date(`${dateFrom}T00:00:00.000Z`));
      if (!Number.isNaN(from.getTime())) where.periodStart.gte = from;
    }
    if (dateTo) {
      const to = toUtcEndOfDay(new Date(`${dateTo}T23:59:59.999Z`));
      if (!Number.isNaN(to.getTime())) where.periodStart.lte = to;
    }
  }

  const statements = await prisma.accountStatement.findMany({
    where,
    orderBy: [
      { periodStart: 'desc' },
      { grossTotal: 'desc' },
    ],
    include: {
      agency: {
        select: { id: true, name: true, email: true },
      },
    },
  });

  return res.json(statements);
});

router.post('/statements/generate-weekly', async (req, res) => {
  const referenceDateRaw = String(req.body?.referenceDate || '').trim();
  const referenceDate = referenceDateRaw ? new Date(referenceDateRaw) : new Date();
  if (Number.isNaN(referenceDate.getTime())) {
    return res.status(400).json({ error: 'Invalid referenceDate' });
  }

  const { periodStart, periodEnd } = getPreviousWeekRange(referenceDate);

  const bookings = await prisma.booking.findMany({
    where: {
      status: 'CONFIRMED',
      createdAt: {
        gte: periodStart,
        lte: periodEnd,
      },
    },
    include: {
      agency: {
        select: { id: true, name: true, email: true, role: true },
      },
    },
  });

  const grouped = new Map();
  for (const booking of bookings) {
    if (!booking.agency || booking.agency.role !== 'AGENCY') continue;

    const key = String(booking.agencyId);
    if (!grouped.has(key)) {
      grouped.set(key, {
        agencyId: booking.agencyId,
        bookingsCount: 0,
        passengersSum: 0,
        grossTotal: 0,
      });
    }

    const row = grouped.get(key);
    row.bookingsCount += 1;
    row.passengersSum += Number(booking.passengers || 0);
    row.grossTotal += estimateBookingAmount(booking);
  }

  let created = 0;
  let updated = 0;
  const items = [];

  for (const row of grouped.values()) {
    const payload = {
      bookingsCount: row.bookingsCount,
      passengersSum: row.passengersSum,
      grossTotal: Number(row.grossTotal.toFixed(2)),
      generatedBy: req.user.sub,
    };

    const existing = await prisma.accountStatement.findUnique({
      where: {
        agencyId_periodStart_periodEnd: {
          agencyId: row.agencyId,
          periodStart,
          periodEnd,
        },
      },
    });

    if (existing) {
      const statement = await prisma.accountStatement.update({
        where: { id: existing.id },
        data: payload,
        include: {
          agency: {
            select: { id: true, name: true, email: true },
          },
        },
      });
      updated += 1;
      items.push(statement);
      continue;
    }

    const statement = await prisma.accountStatement.create({
      data: {
        agencyId: row.agencyId,
        periodStart,
        periodEnd,
        ...payload,
      },
      include: {
        agency: {
          select: { id: true, name: true, email: true },
        },
      },
    });
    created += 1;
    items.push(statement);
  }

  await logActivity({
    req,
    user: req.user,
    action: 'STATEMENT_GENERATE_WEEKLY',
    entityType: 'AccountStatement',
    entityId: null,
    meta: { periodStart, periodEnd, created, updated, agencies: grouped.size },
  });

  return res.json({
    periodStart,
    periodEnd,
    agencies: grouped.size,
    created,
    updated,
    statements: items,
  });
});

router.get('/statements/:id/export.csv', async (req, res) => {
  const id = Number(req.params.id);
  const statement = await getStatementById(id);
  if (!statement) return res.status(404).json({ error: 'Statement not found' });

  const headers = [
    'statementId',
    'agencyName',
    'agencyEmail',
    'periodStart',
    'periodEnd',
    'bookingsCount',
    'passengersSum',
    'grossTotal',
    'generatedAt',
  ];

  const row = [
    statement.id,
    statement.agency?.name || '',
    statement.agency?.email || '',
    statement.periodStart?.toISOString?.() || '',
    statement.periodEnd?.toISOString?.() || '',
    statement.bookingsCount,
    statement.passengersSum,
    Number(statement.grossTotal || 0).toFixed(2),
    statement.generatedAt?.toISOString?.() || '',
  ];

  const csv = [headers.map(toCsvValue).join(','), row.map(toCsvValue).join(',')].join('\n');
  const fileName = `statement-${statement.id}.csv`;

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  return res.status(200).send(csv);
});

router.get('/statements/:id/export.pdf', async (req, res) => {
  const id = Number(req.params.id);
  const statement = await getStatementById(id);
  if (!statement) return res.status(404).json({ error: 'Statement not found' });

  const fileName = `statement-${statement.id}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

  const doc = new PDFDocument({ margin: 50 });
  doc.pipe(res);
  buildStatementPdf(doc, statement);
  doc.end();
});

router.post('/statements/:id/send-email', async (req, res) => {
  const id = Number(req.params.id);
  const statement = await getStatementById(id);
  if (!statement) return res.status(404).json({ error: 'Statement not found' });
  if (!statement.agency?.email) return res.status(400).json({ error: 'Agency email not available' });

  if (!hasSmtpConfig()) {
    return res.status(503).json({ error: 'SMTP not configured' });
  }

  const pdfBuffer = await createStatementPdfBuffer(statement);
  const result = await sendStatementEmail({
    to: statement.agency.email,
    statement,
    pdfBuffer,
  });

  if (result?.delivered) {
    await logActivity({
      req,
      user: req.user,
      action: 'STATEMENT_EMAIL',
      entityType: 'AccountStatement',
      entityId: statement.id,
      meta: { agencyId: statement.agencyId, periodStart: statement.periodStart, periodEnd: statement.periodEnd },
    });
  }

  return res.json({ delivered: result.delivered });
});

module.exports = router;
