const express = require('express');
const prisma = require('../lib/prisma');
const { logActivity } = require('../lib/audit');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

router.get('/unavailability', async (req, res) => {
  const vehicleId = Number(req.query.vehicleId || 0);

  const entries = await prisma.vehicleUnavailability.findMany({
    where: vehicleId > 0 ? { vehicleId } : {},
    orderBy: { startAt: 'asc' },
    include: {
      vehicle: {
        select: { id: true, name: true, capacity: true, type: true },
      },
    },
  });

  return res.json(entries);
});

router.get('/', async (req, res) => {
  const includeInactive = String(req.query.includeInactive || '').toLowerCase() === 'true';

  const vehicles = await prisma.vehicle.findMany({
    where: includeInactive ? {} : { isActive: true },
    orderBy: [
      { capacity: 'asc' },
      { name: 'asc' },
    ],
  });

  return res.json(vehicles);
});

router.post('/', requireRole('OPERATOR'), async (req, res) => {
  const { name, capacity, type, isActive, notes } = req.body;

  if (!name || !capacity || !type) {
    return res.status(400).json({ error: 'name, capacity and type are required' });
  }

  const normalizedType = String(type).toUpperCase();
  if (!['CAR', 'VAN', 'MINIBUS', 'BUS'].includes(normalizedType)) {
    return res.status(400).json({ error: 'type must be CAR, VAN, MINIBUS or BUS' });
  }

  const parsedCapacity = Number(capacity);
  if (!Number.isInteger(parsedCapacity) || parsedCapacity < 1) {
    return res.status(400).json({ error: 'capacity must be a positive integer' });
  }

  const vehicle = await prisma.vehicle.create({
    data: {
      name: String(name),
      capacity: parsedCapacity,
      type: normalizedType,
      isActive: isActive === undefined ? true : Boolean(isActive),
      notes: notes ? String(notes) : null,
    },
  });

  return res.status(201).json(vehicle);
});

router.put('/:id', requireRole('OPERATOR'), async (req, res) => {
  const id = Number(req.params.id);
  const { name, capacity, type, isActive, notes } = req.body;

  const existing = await prisma.vehicle.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: 'Vehicle not found' });

  const data = {};

  if (name !== undefined) data.name = String(name);
  if (capacity !== undefined) {
    const parsedCapacity = Number(capacity);
    if (!Number.isInteger(parsedCapacity) || parsedCapacity < 1) {
      return res.status(400).json({ error: 'capacity must be a positive integer' });
    }
    data.capacity = parsedCapacity;
  }

  if (type !== undefined) {
    const normalizedType = String(type).toUpperCase();
    if (!['CAR', 'VAN', 'MINIBUS', 'BUS'].includes(normalizedType)) {
      return res.status(400).json({ error: 'type must be CAR, VAN, MINIBUS or BUS' });
    }
    data.type = normalizedType;
  }

  if (isActive !== undefined) data.isActive = Boolean(isActive);
  if (notes !== undefined) data.notes = notes ? String(notes) : null;

  const vehicle = await prisma.vehicle.update({ where: { id }, data });
  return res.json(vehicle);
});

router.post('/:id/unavailability', requireRole('OPERATOR'), async (req, res) => {
  const vehicleId = Number(req.params.id);
  const { startAt, endAt, reason } = req.body;

  const vehicle = await prisma.vehicle.findUnique({ where: { id: vehicleId } });
  if (!vehicle) return res.status(404).json({ error: 'Vehicle not found' });

  if (!startAt || !endAt) {
    return res.status(400).json({ error: 'startAt and endAt are required' });
  }

  const parsedStartAt = new Date(startAt);
  const parsedEndAt = new Date(endAt);
  if (Number.isNaN(parsedStartAt.getTime()) || Number.isNaN(parsedEndAt.getTime())) {
    return res.status(400).json({ error: 'Invalid startAt/endAt' });
  }
  if (parsedEndAt <= parsedStartAt) {
    return res.status(400).json({ error: 'endAt must be greater than startAt' });
  }

  const overlap = await prisma.vehicleUnavailability.findFirst({
    where: {
      vehicleId,
      startAt: { lt: parsedEndAt },
      endAt: { gt: parsedStartAt },
    },
  });
  if (overlap) {
    const nextStart = overlap.startAt < parsedStartAt ? overlap.startAt : parsedStartAt;
    const nextEnd = overlap.endAt > parsedEndAt ? overlap.endAt : parsedEndAt;
    const nextReason = reason ? String(reason) : overlap.reason;

    const merged = await prisma.vehicleUnavailability.update({
      where: { id: overlap.id },
      data: {
        startAt: nextStart,
        endAt: nextEnd,
        reason: nextReason,
      },
      include: {
        vehicle: {
          select: { id: true, name: true, capacity: true, type: true },
        },
      },
    });

    await logActivity({
      req,
      user: req.user,
      action: 'VEHICLE_BLOCK_UPDATE',
      entityType: 'VehicleUnavailability',
      entityId: merged.id,
      meta: { vehicleId, startAt: merged.startAt, endAt: merged.endAt },
    });

    return res.status(200).json(merged);
  }

  const entry = await prisma.vehicleUnavailability.create({
    data: {
      vehicleId,
      startAt: parsedStartAt,
      endAt: parsedEndAt,
      reason: reason ? String(reason) : null,
    },
    include: {
      vehicle: {
        select: { id: true, name: true, capacity: true, type: true },
      },
    },
  });

  await logActivity({
    req,
    user: req.user,
    action: 'VEHICLE_BLOCK_CREATE',
    entityType: 'VehicleUnavailability',
    entityId: entry.id,
    meta: { vehicleId, startAt: entry.startAt, endAt: entry.endAt },
  });

  return res.status(201).json(entry);
});

router.delete('/unavailability/:entryId', requireRole('OPERATOR'), async (req, res) => {
  const entryId = Number(req.params.entryId);
  const existing = await prisma.vehicleUnavailability.findUnique({ where: { id: entryId } });
  if (!existing) return res.status(404).json({ error: 'Unavailability entry not found' });

  await prisma.vehicleUnavailability.delete({ where: { id: entryId } });
  await logActivity({
    req,
    user: req.user,
    action: 'VEHICLE_BLOCK_DELETE',
    entityType: 'VehicleUnavailability',
    entityId: entryId,
    meta: { vehicleId: existing.vehicleId, startAt: existing.startAt, endAt: existing.endAt },
  });
  return res.status(204).send();
});

module.exports = router;
