const express = require('express');
const router = express.Router();
const multer = require('multer');
const pdfParse = require('pdf-parse');
const prisma = require('../lib/prisma');
const { logActivity } = require('../lib/audit');
const { sendNotification } = require('../lib/notifications');
const { runImapIngestOnce } = require('../lib/imapIngest');
const { requireAuth, requireRole } = require('../middleware/auth');

router.use(requireAuth);
const upload = multer({ storage: multer.memoryStorage() });

function normalizeTravelMode(value) {
  if (!value) return null;
  const mode = String(value).trim().toUpperCase();
  if (mode === 'SHIP') return 'SHIP';
  if (mode === 'TRAIN') return 'TRAIN';
  return null;
}

function toCsvValue(value) {
  if (value === null || value === undefined) return '';
  const text = String(value).replace(/"/g, '""');
  return `"${text}"`;
}

function buildBookingWhere(req) {
  const where = req.user.role === 'OPERATOR' ? {} : { agencyId: req.user.sub };
  const { status, service, dateFrom, dateTo } = req.query;

  if (status) where.status = String(status).toUpperCase();
  if (service) where.service = String(service);

  if (dateFrom || dateTo) {
    where.createdAt = {};
    if (dateFrom) {
      const from = new Date(`${dateFrom}T00:00:00.000Z`);
      if (!Number.isNaN(from.getTime())) where.createdAt.gte = from;
    }
    if (dateTo) {
      const to = new Date(`${dateTo}T23:59:59.999Z`);
      if (!Number.isNaN(to.getTime())) where.createdAt.lte = to;
    }
  }

  return where;
}

function buildOrderBy(req) {
  const allowedSortBy = new Set(['createdAt', 'service', 'status', 'passengers']);
  const sortBy = allowedSortBy.has(String(req.query.sortBy || ''))
    ? String(req.query.sortBy)
    : 'createdAt';
  const sortDir = String(req.query.sortDir || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';
  return { [sortBy]: sortDir };
}

function buildPagination(req) {
  const page = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10) || 1);
  const pageSizeRaw = Number.parseInt(String(req.query.pageSize || '10'), 10) || 10;
  const pageSize = Math.min(100, Math.max(1, pageSizeRaw));
  const skip = (page - 1) * pageSize;
  return { page, pageSize, skip };
}

function splitCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  result.push(current.trim());
  return result;
}

function parseRowsFromCsvText(content) {
  const lines = content.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length === 0) return [];

  const header = splitCsvLine(lines[0]).map(value => value.toLowerCase());
  const hasHeader = header.includes('agencyemail') && header.includes('service') && header.includes('passengers');
  const dataLines = hasHeader ? lines.slice(1) : lines;

  const hotelNameIndex = header.indexOf('hotelname');
  const hotelIdIndex = header.indexOf('hotelid');
  const travelModeIndex = header.indexOf('travelmode');
  const travelRefIndex = header.indexOf('travelref');
  const arrivalAtIndex = header.indexOf('arrivalat');
  const priceTotalIndex = header.indexOf('pricetotal');

  return dataLines.map(line => {
    const cells = splitCsvLine(line);
    if (hasHeader) {
      const agencyEmail = cells[header.indexOf('agencyemail')] || '';
      const service = cells[header.indexOf('service')] || '';
      const passengers = Number(cells[header.indexOf('passengers')] || 0);
      const hotelName = hotelNameIndex >= 0 ? (cells[hotelNameIndex] || '') : '';
      const hotelId = hotelIdIndex >= 0 ? Number(cells[hotelIdIndex] || 0) : 0;
      const travelMode = travelModeIndex >= 0 ? (cells[travelModeIndex] || '') : '';
      const travelRef = travelRefIndex >= 0 ? (cells[travelRefIndex] || '') : '';
      const arrivalAt = arrivalAtIndex >= 0 ? (cells[arrivalAtIndex] || '') : '';
      const priceTotal = priceTotalIndex >= 0 ? Number(cells[priceTotalIndex] || 0) : 0;
      return { agencyEmail, service, passengers, hotelName, hotelId, travelMode, travelRef, arrivalAt, priceTotal };
    }

    return {
      agencyEmail: cells[0] || '',
      service: cells[1] || '',
      passengers: Number(cells[2] || 0),
      hotelName: cells[3] || '',
      hotelId: Number(cells[4] || 0),
      travelMode: cells[5] || '',
      travelRef: cells[6] || '',
      arrivalAt: cells[7] || '',
      priceTotal: Number(cells[8] || 0),
    };
  });
}

router.get('/', async (req, res) => {
  const where = buildBookingWhere(req);
  const orderBy = buildOrderBy(req);
  const { page, pageSize, skip } = buildPagination(req);

  const [items, total] = await prisma.$transaction([
    prisma.booking.findMany({
      where,
      orderBy,
      skip,
      take: pageSize,
      include: {
        agency: {
          select: { id: true, name: true, email: true },
        },
        dispatch: {
          select: {
            id: true,
            scheduledAt: true,
            vehicle: true,
            driverName: true,
          },
        },
        hotel: true,
      },
    }),
    prisma.booking.count({ where }),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return res.json({
    items,
    total,
    page,
    pageSize,
    totalPages,
  });
});

router.get('/export.csv', async (req, res) => {
  const where = buildBookingWhere(req);
  const orderBy = buildOrderBy(req);
  const bookings = await prisma.booking.findMany({
    where,
    orderBy,
    include: {
      agency: {
        select: { name: true, email: true },
      },
      dispatch: {
        select: {
          scheduledAt: true,
          vehicle: true,
          driverName: true,
        },
      },
      hotel: true,
    },
  });

  const headers = [
    'id',
    'agencyName',
    'agencyEmail',
    'service',
    'passengers',
    'travelMode',
    'travelRef',
    'arrivalAt',
    'priceTotal',
    'status',
    'hotelName',
    'hotelAddress',
    'dispatchScheduledAt',
    'dispatchVehicle',
    'dispatchDriver',
    'createdAt',
    'approvedAt',
    'approvedBy',
    'rejectedAt',
    'rejectedBy',
    'rejectionReason',
  ];

  const lines = [headers.map(toCsvValue).join(',')];
  for (const booking of bookings) {
    const row = [
      booking.id,
      booking.agency?.name || '',
      booking.agency?.email || '',
      booking.service,
      booking.passengers,
      booking.travelMode || '',
      booking.travelRef || '',
      booking.arrivalAt?.toISOString?.() || '',
      booking.priceTotal ?? '',
      booking.status,
      booking.hotel?.name || '',
      booking.hotel?.address || '',
      booking.dispatch?.scheduledAt?.toISOString?.() || '',
      booking.dispatch?.vehicle || '',
      booking.dispatch?.driverName || '',
      booking.createdAt?.toISOString?.() || booking.createdAt,
      booking.approvedAt?.toISOString?.() || '',
      booking.approvedBy || '',
      booking.rejectedAt?.toISOString?.() || '',
      booking.rejectedBy || '',
      booking.rejectionReason || '',
    ];
    lines.push(row.map(toCsvValue).join(','));
  }

  const csv = lines.join('\n');
  const fileName = `bookings-${new Date().toISOString().slice(0, 10)}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  return res.status(200).send(csv);
});

router.get('/kpi', async (req, res) => {
  const where = req.user.role === 'OPERATOR' ? {} : { agencyId: req.user.sub };
  const now = new Date();
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(now);
  endOfDay.setHours(23, 59, 59, 999);

  const [total, pending, confirmed, rejected, today] = await prisma.$transaction([
    prisma.booking.count({ where }),
    prisma.booking.count({ where: { ...where, status: 'PENDING' } }),
    prisma.booking.count({ where: { ...where, status: 'CONFIRMED' } }),
    prisma.booking.count({ where: { ...where, status: 'REJECTED' } }),
    prisma.booking.count({
      where: {
        ...where,
        createdAt: {
          gte: startOfDay,
          lte: endOfDay,
        },
      },
    }),
  ]);

  return res.json({ total, pending, confirmed, rejected, today });
});

router.get('/kpi/trend', async (req, res) => {
  const daysRaw = Number(req.query.days || 14);
  const days = Math.min(60, Math.max(1, Number.isFinite(daysRaw) ? daysRaw : 14));
  const now = new Date();
  const endOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));
  const startDate = new Date(endOfToday);
  startDate.setUTCDate(startDate.getUTCDate() - (days - 1));
  startDate.setUTCHours(0, 0, 0, 0);

  const where = buildBookingWhere(req);
  where.createdAt = {
    gte: startDate,
    lte: endOfToday,
  };

  const bookings = await prisma.booking.findMany({
    where,
    select: {
      createdAt: true,
      status: true,
    },
  });

  const buckets = {};
  for (let i = 0; i < days; i += 1) {
    const d = new Date(startDate);
    d.setUTCDate(startDate.getUTCDate() + i);
    const key = d.toISOString().slice(0, 10);
    buckets[key] = { date: key, total: 0, pending: 0, confirmed: 0, rejected: 0 };
  }

  for (const booking of bookings) {
    const key = new Date(booking.createdAt).toISOString().slice(0, 10);
    if (!buckets[key]) continue;
    buckets[key].total += 1;
    if (booking.status === 'PENDING') buckets[key].pending += 1;
    if (booking.status === 'CONFIRMED') buckets[key].confirmed += 1;
    if (booking.status === 'REJECTED') buckets[key].rejected += 1;
  }

  return res.json({ days, items: Object.values(buckets) });
});

router.get('/kpi/trend.csv', async (req, res) => {
  const daysRaw = Number(req.query.days || 14);
  const days = Math.min(60, Math.max(1, Number.isFinite(daysRaw) ? daysRaw : 14));
  const now = new Date();
  const endOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));
  const startDate = new Date(endOfToday);
  startDate.setUTCDate(startDate.getUTCDate() - (days - 1));
  startDate.setUTCHours(0, 0, 0, 0);

  const where = buildBookingWhere(req);
  where.createdAt = {
    gte: startDate,
    lte: endOfToday,
  };

  const bookings = await prisma.booking.findMany({
    where,
    select: { createdAt: true, status: true },
  });

  const buckets = {};
  for (let i = 0; i < days; i += 1) {
    const d = new Date(startDate);
    d.setUTCDate(startDate.getUTCDate() + i);
    const key = d.toISOString().slice(0, 10);
    buckets[key] = { date: key, total: 0, pending: 0, confirmed: 0, rejected: 0 };
  }

  for (const booking of bookings) {
    const key = new Date(booking.createdAt).toISOString().slice(0, 10);
    if (!buckets[key]) continue;
    buckets[key].total += 1;
    if (booking.status === 'PENDING') buckets[key].pending += 1;
    if (booking.status === 'CONFIRMED') buckets[key].confirmed += 1;
    if (booking.status === 'REJECTED') buckets[key].rejected += 1;
  }

  const headers = ['date', 'total', 'pending', 'confirmed', 'rejected'];
  const lines = [headers.join(',')];
  Object.values(buckets).forEach(row => {
    lines.push([row.date, row.total, row.pending, row.confirmed, row.rejected].join(','));
  });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="kpi-trend-${days}d.csv"`);
  return res.send(lines.join('\n'));
});

router.post('/inbox/sync', requireRole('OPERATOR'), async (req, res) => {
  try {
    const limit = Number.parseInt(String(req.body?.limit || ''), 10);
    const result = await runImapIngestOnce({
      limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
    });

    if (!result.ok && !result.skipped) {
      return res.status(500).json(result);
    }
    return res.json(result);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || 'IMAP sync failed',
    });
  }
});

router.post('/import/preview', requireRole('OPERATOR'), upload.single('file'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'file is required' });

  let rows = [];
  const fileName = String(file.originalname || '').toLowerCase();

  if (fileName.endsWith('.csv')) {
    const content = file.buffer.toString('utf-8');
    rows = parseRowsFromCsvText(content);
  } else if (fileName.endsWith('.pdf')) {
    const parsed = await pdfParse(file.buffer);
    rows = parseRowsFromCsvText(parsed.text || '');
  } else {
    return res.status(400).json({ error: 'Only .csv and .pdf files are supported' });
  }

  if (rows.length === 0) return res.status(400).json({ error: 'No rows found in file' });

  const previewLimit = Math.min(50, rows.length);
  const skipDuplicates = String(req.body?.skipDuplicates ?? 'true') !== 'false';
  const preview = [];
  const issues = [];

  for (let index = 0; index < previewLimit; index += 1) {
    const row = rows[index];
    const rowNumber = index + 1;
    const agencyEmail = String(row.agencyEmail || '').trim().toLowerCase();
    const service = String(row.service || '').trim().toLowerCase();
    const passengers = Number(row.passengers || 0);
    const arrivalAtRaw = String(row.arrivalAt || '').trim();
    const parsedArrivalAt = arrivalAtRaw ? new Date(arrivalAtRaw) : null;
    const priceTotal = Number(row.priceTotal || 0);

    const rowIssues = [];
    if (!agencyEmail || !service || !passengers || passengers < 1) {
      rowIssues.push('agencyEmail/service/passengers non validi');
    }
    if (arrivalAtRaw && Number.isNaN(parsedArrivalAt?.getTime?.())) {
      rowIssues.push('arrivalAt non valido');
    }
    if (row.priceTotal !== undefined && row.priceTotal !== '' && (!Number.isFinite(priceTotal) || priceTotal < 0)) {
      rowIssues.push('priceTotal non valido');
    }

    let duplicate = false;
    if (skipDuplicates && agencyEmail && service && passengers > 0) {
      const parsedArrivalAt = arrivalAtRaw ? new Date(arrivalAtRaw) : null;
      const existing = await prisma.booking.findFirst({
        where: {
          agency: { email: agencyEmail },
          service,
          travelRef: travelRef || null,
          arrivalAt: parsedArrivalAt,
        },
      });
      if (existing) duplicate = true;
    }

    if (duplicate) {
      rowIssues.push('possibile duplicato');
    }

    if (rowIssues.length > 0) {
      issues.push({ row: rowNumber, issues: rowIssues });
    }

    preview.push({
      row: rowNumber,
      agencyEmail,
      service,
      passengers,
      hotelName: row.hotelName || '',
      hotelId: row.hotelId || '',
      travelMode: row.travelMode || '',
      travelRef: row.travelRef || '',
      arrivalAt: arrivalAtRaw || '',
      priceTotal: row.priceTotal || '',
      duplicate,
    });
  }

  return res.json({
    totalRows: rows.length,
    previewRows: preview,
    issues,
  });
});

router.post('/import', requireRole('OPERATOR'), upload.single('file'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'file is required' });
  const skipDuplicates = String(req.body?.skipDuplicates ?? 'true') !== 'false';

  let rows = [];
  const fileName = String(file.originalname || '').toLowerCase();

  if (fileName.endsWith('.csv')) {
    const content = file.buffer.toString('utf-8');
    rows = parseRowsFromCsvText(content);
  } else if (fileName.endsWith('.pdf')) {
    const parsed = await pdfParse(file.buffer);
    rows = parseRowsFromCsvText(parsed.text || '');
  } else {
    return res.status(400).json({ error: 'Only .csv and .pdf files are supported' });
  }

  if (rows.length === 0) return res.status(400).json({ error: 'No rows found in file' });

  const errors = [];
  let created = 0;
  let skipped = 0;

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const rowNumber = index + 1;
    const agencyEmail = String(row.agencyEmail || '').trim().toLowerCase();
    const service = String(row.service || '').trim().toLowerCase();
    const passengers = Number(row.passengers || 0);
    const hotelName = String(row.hotelName || '').trim();
    const hotelId = Number(row.hotelId || 0);
    const travelMode = normalizeTravelMode(row.travelMode);
    const travelRef = String(row.travelRef || '').trim();
    const arrivalAtRaw = String(row.arrivalAt || '').trim();
    const parsedArrivalAt = arrivalAtRaw ? new Date(arrivalAtRaw) : null;
    const priceTotal = Number(row.priceTotal || 0);

    if (!agencyEmail || !service || !passengers || passengers < 1) {
      errors.push(`Row ${rowNumber}: invalid agencyEmail/service/passengers`);
      continue;
    }

    if (arrivalAtRaw && Number.isNaN(parsedArrivalAt?.getTime?.())) {
      errors.push(`Row ${rowNumber}: invalid arrivalAt format`);
      continue;
    }

    if (row.priceTotal !== undefined && row.priceTotal !== '' && (!Number.isFinite(priceTotal) || priceTotal < 0)) {
      errors.push(`Row ${rowNumber}: invalid priceTotal`);
      continue;
    }

    const agency = await prisma.user.findUnique({ where: { email: agencyEmail } });
    if (!agency || agency.role !== 'AGENCY') {
      errors.push(`Row ${rowNumber}: agency not found for email ${agencyEmail}`);
      continue;
    }

    let resolvedHotelId = null;
    if (hotelId > 0) {
      const existingHotel = await prisma.hotel.findUnique({ where: { id: hotelId } });
      if (!existingHotel) {
        errors.push(`Row ${rowNumber}: hotel not found for id ${hotelId}`);
        continue;
      }
      resolvedHotelId = existingHotel.id;
    } else if (hotelName) {
      const existingHotel = await prisma.hotel.findFirst({
        where: {
          name: {
            equals: hotelName,
            mode: 'insensitive',
          },
        },
      });
      if (!existingHotel) {
        errors.push(`Row ${rowNumber}: hotel not found for name ${hotelName}`);
        continue;
      }
      resolvedHotelId = existingHotel.id;
    }

    if (skipDuplicates) {
      const existingBooking = await prisma.booking.findFirst({
        where: {
          agencyId: agency.id,
          service,
          travelRef: travelRef || null,
          arrivalAt: parsedArrivalAt,
        },
      });

      if (existingBooking) {
        skipped += 1;
        continue;
      }
    }

    await prisma.booking.create({
      data: {
        agencyId: agency.id,
        service,
        passengers,
        hotelId: resolvedHotelId,
        travelMode,
        travelRef: travelRef || null,
        arrivalAt: parsedArrivalAt,
        priceTotal: Number.isFinite(priceTotal) && priceTotal > 0 ? priceTotal : null,
      },
    });
    created += 1;
  }

  return res.json({
    importedRows: rows.length,
    created,
    skipped,
    failed: errors.length,
    errors,
  });
});

router.post('/', requireRole('AGENCY'), async (req, res) => {
  const { service, passengers, hotelId, travelMode, travelRef, arrivalAt, priceTotal } = req.body;
  if (!service || !passengers) return res.status(400).json({ error: 'service and passengers are required' });

  let resolvedHotelId = null;
  if (hotelId !== undefined && hotelId !== null && Number(hotelId) > 0) {
    const hotel = await prisma.hotel.findUnique({ where: { id: Number(hotelId) } });
    if (!hotel) return res.status(400).json({ error: 'Invalid hotelId' });
    resolvedHotelId = hotel.id;
  }

  const normalizedTravelMode = normalizeTravelMode(travelMode);
  if (travelMode && !normalizedTravelMode) {
    return res.status(400).json({ error: 'travelMode must be SHIP or TRAIN' });
  }

  let parsedArrivalAt = null;
  if (arrivalAt) {
    parsedArrivalAt = new Date(arrivalAt);
    if (Number.isNaN(parsedArrivalAt.getTime())) {
      return res.status(400).json({ error: 'Invalid arrivalAt' });
    }
  }

  let parsedPriceTotal = null;
  if (priceTotal !== undefined && priceTotal !== null && priceTotal !== '') {
    parsedPriceTotal = Number(priceTotal);
    if (!Number.isFinite(parsedPriceTotal) || parsedPriceTotal < 0) {
      return res.status(400).json({ error: 'Invalid priceTotal' });
    }
  }

  const booking = await prisma.booking.create({
    data: {
      service,
      passengers: Number(passengers),
      agencyId: req.user.sub,
      hotelId: resolvedHotelId,
      travelMode: normalizedTravelMode,
      travelRef: travelRef ? String(travelRef) : null,
      arrivalAt: parsedArrivalAt,
      priceTotal: parsedPriceTotal,
    },
    include: {
      agency: {
        select: { id: true, name: true, email: true },
      },
      hotel: true,
    },
  });

  await logActivity({
    req,
    user: req.user,
    action: 'BOOKING_CREATE',
    entityType: 'Booking',
    entityId: booking.id,
    meta: { service: booking.service, passengers: booking.passengers },
  });

  sendNotification({
    type: 'BOOKING_CREATE',
    bookingId: booking.id,
    agencyName: booking.agency?.name || null,
    agencyId: booking.agencyId,
    audience: 'OPERATOR',
    message: `Nuova prenotazione #${booking.id} (${booking.agency?.name || 'Agenzia'})`,
  });

  return res.status(201).json(booking);
});

router.put('/:id/approve', requireRole('OPERATOR', 'AGENCY'), async (req, res) => {
  const id = Number(req.params.id);

  const existing = await prisma.booking.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (req.user.role === 'AGENCY' && existing.agencyId !== req.user.sub) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (existing.status !== 'PENDING') {
    return res.status(409).json({ error: 'Only pending bookings can be approved' });
  }

  const booking = await prisma.booking.update({
    where: { id },
    data: {
      status: 'CONFIRMED',
      approvedAt: new Date(),
      approvedBy: req.user.sub,
      rejectedAt: null,
      rejectedBy: null,
      rejectionReason: null,
    },
    include: {
      agency: {
        select: { id: true, name: true, email: true },
      },
    },
  });

  await logActivity({
    req,
    user: req.user,
    action: 'BOOKING_APPROVE',
    entityType: 'Booking',
    entityId: booking.id,
    meta: { status: booking.status },
  });

  sendNotification({
    type: 'BOOKING_APPROVE',
    bookingId: booking.id,
    agencyName: booking.agency?.name || null,
    agencyId: booking.agency?.id || null,
    audience: 'OPERATOR',
    message: `Prenotazione #${booking.id} approvata`,
  });
  sendNotification({
    type: 'BOOKING_APPROVE',
    bookingId: booking.id,
    agencyName: booking.agency?.name || null,
    agencyId: booking.agency?.id || null,
    audience: 'AGENCY',
    message: `La tua prenotazione #${booking.id} è stata approvata`,
  });

  return res.json(booking);
});

router.put('/:id/reject', requireRole('OPERATOR', 'AGENCY'), async (req, res) => {
  const id = Number(req.params.id);
  const { reason } = req.body;

  const existing = await prisma.booking.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (req.user.role === 'AGENCY' && existing.agencyId !== req.user.sub) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (existing.status !== 'PENDING') {
    return res.status(409).json({ error: 'Only pending bookings can be rejected' });
  }

  const booking = await prisma.booking.update({
    where: { id },
    data: {
      status: 'REJECTED',
      rejectedAt: new Date(),
      rejectedBy: req.user.sub,
      rejectionReason: reason ? String(reason) : null,
      approvedAt: null,
      approvedBy: null,
    },
    include: {
      agency: {
        select: { id: true, name: true, email: true },
      },
    },
  });

  await logActivity({
    req,
    user: req.user,
    action: 'BOOKING_REJECT',
    entityType: 'Booking',
    entityId: booking.id,
    meta: { status: booking.status, reason: booking.rejectionReason || null },
  });

  sendNotification({
    type: 'BOOKING_REJECT',
    bookingId: booking.id,
    agencyName: booking.agency?.name || null,
    agencyId: booking.agency?.id || null,
    audience: 'OPERATOR',
    reason: booking.rejectionReason || null,
    message: `Prenotazione #${booking.id} rifiutata`,
  });
  sendNotification({
    type: 'BOOKING_REJECT',
    bookingId: booking.id,
    agencyName: booking.agency?.name || null,
    agencyId: booking.agency?.id || null,
    audience: 'AGENCY',
    reason: booking.rejectionReason || null,
    message: `La tua prenotazione #${booking.id} è stata rifiutata`,
  });

  return res.json(booking);
});

router.put('/:id/reset', requireRole('OPERATOR', 'AGENCY'), async (req, res) => {
  const id = Number(req.params.id);

  const existing = await prisma.booking.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (req.user.role === 'AGENCY' && existing.agencyId !== req.user.sub) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (existing.status !== 'REJECTED') {
    return res.status(409).json({ error: 'Only rejected bookings can be reset' });
  }

  const booking = await prisma.booking.update({
    where: { id },
    data: {
      status: 'PENDING',
      rejectedAt: null,
      rejectedBy: null,
      rejectionReason: null,
    },
    include: {
      agency: {
        select: { id: true, name: true, email: true },
      },
    },
  });

  await logActivity({
    req,
    user: req.user,
    action: 'BOOKING_RESET',
    entityType: 'Booking',
    entityId: booking.id,
    meta: { status: booking.status },
  });

  sendNotification({
    type: 'BOOKING_RESET',
    bookingId: booking.id,
    agencyName: booking.agency?.name || null,
    agencyId: booking.agency?.id || null,
    audience: 'OPERATOR',
    message: `Prenotazione #${booking.id} ripristinata`,
  });
  sendNotification({
    type: 'BOOKING_RESET',
    bookingId: booking.id,
    agencyName: booking.agency?.name || null,
    agencyId: booking.agency?.id || null,
    audience: 'AGENCY',
    message: `La tua prenotazione #${booking.id} è stata ripristinata`,
  });

  return res.json(booking);
});

router.put('/:id/hotel', requireRole('OPERATOR'), async (req, res) => {
  const id = Number(req.params.id);
  const { hotelId } = req.body;

  const existing = await prisma.booking.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: 'Not found' });

  let nextHotelId = null;
  if (hotelId !== null && hotelId !== undefined && Number(hotelId) > 0) {
    const hotel = await prisma.hotel.findUnique({ where: { id: Number(hotelId) } });
    if (!hotel) return res.status(400).json({ error: 'Invalid hotelId' });
    nextHotelId = hotel.id;
  }

  const booking = await prisma.booking.update({
    where: { id },
    data: { hotelId: nextHotelId },
    include: {
      agency: {
        select: { id: true, name: true, email: true },
      },
      hotel: true,
      dispatch: {
        select: {
          id: true,
          scheduledAt: true,
          vehicle: true,
          driverName: true,
        },
      },
    },
  });

  return res.json(booking);
});

router.delete('/:id', requireRole('OPERATOR'), async (req, res) => {
  const id = Number(req.params.id);
  const existing = await prisma.booking.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const dispatch = await prisma.dispatchPlan.findUnique({ where: { bookingId: id } });
  if (dispatch) {
    return res.status(409).json({ error: 'Booking has dispatch plan; delete dispatch first' });
  }

  await prisma.booking.delete({ where: { id } });
  return res.status(204).send();
});

module.exports = router;
