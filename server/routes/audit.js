const express = require('express');
const prisma = require('../lib/prisma');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, requireRole('OPERATOR'), async (req, res) => {
  const {
    action,
    entityType,
    dateFrom,
    dateTo,
    page = '1',
    pageSize = '20',
  } = req.query;

  const where = {};
  if (action) where.action = String(action);
  if (entityType) where.entityType = String(entityType);
  if (dateFrom || dateTo) {
    where.createdAt = {};
    if (dateFrom) where.createdAt.gte = new Date(String(dateFrom));
    if (dateTo) where.createdAt.lte = new Date(String(dateTo));
  }

  const take = Math.min(100, Math.max(1, Number(pageSize) || 20));
  const skip = (Math.max(1, Number(page) || 1) - 1) * take;

  const [items, total] = await Promise.all([
    prisma.activityLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take,
      skip,
      include: {
        user: { select: { id: true, name: true, email: true, role: true } },
      },
    }),
    prisma.activityLog.count({ where }),
  ]);

  return res.json({
    items,
    page: Number(page) || 1,
    pageSize: take,
    total,
    totalPages: Math.max(1, Math.ceil(total / take)),
  });
});

router.get('/export.csv', requireAuth, requireRole('OPERATOR'), async (req, res) => {
  const { action, entityType, dateFrom, dateTo } = req.query;
  const where = {};
  if (action) where.action = String(action);
  if (entityType) where.entityType = String(entityType);
  if (dateFrom || dateTo) {
    where.createdAt = {};
    if (dateFrom) where.createdAt.gte = new Date(String(dateFrom));
    if (dateTo) where.createdAt.lte = new Date(String(dateTo));
  }

  const items = await prisma.activityLog.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: {
      user: { select: { id: true, name: true, email: true, role: true } },
    },
    take: 5000,
  });

  const headers = ['id', 'createdAt', 'userId', 'userEmail', 'action', 'entityType', 'entityId', 'ip', 'meta'];
  const lines = [headers.join(',')];
  items.forEach(item => {
    const row = [
      item.id,
      item.createdAt?.toISOString?.() || '',
      item.userId || '',
      item.user?.email || '',
      item.action || '',
      item.entityType || '',
      item.entityId || '',
      item.ip || '',
      item.meta ? JSON.stringify(item.meta).replace(/"/g, '""') : '',
    ].map(value => `"${String(value)}"`).join(',');
    lines.push(row);
  });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="audit-export.csv"');
  return res.send(lines.join('\n'));
});

module.exports = router;
