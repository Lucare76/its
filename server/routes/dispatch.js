const express = require('express');
const prisma = require('../lib/prisma');
const { logActivity } = require('../lib/audit');
const { sendNotification } = require('../lib/notifications');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);
router.use(requireRole('OPERATOR'));

const PORTS = [
  { id: 'ISCHIA_PORTO', name: 'Ischia Porto', latitude: 40.7395, longitude: 13.9493 },
  { id: 'CASAMICCIOLA', name: 'Casamicciola', latitude: 40.7467, longitude: 13.9131 },
  { id: 'FORIO', name: 'Forio', latitude: 40.7374, longitude: 13.8649 },
  { id: 'LACCO_AMENO', name: 'Lacco Ameno', latitude: 40.7492, longitude: 13.8875 },
  { id: 'SANT_ANGELO', name: "Sant'Angelo", latitude: 40.6994, longitude: 13.8909 },
];

const DEFAULT_PORT = PORTS[0];

function getDispatchBufferMinutes() {
  const parsed = Number(process.env.DISPATCH_BUFFER_MINUTES || 30);
  if (!Number.isFinite(parsed)) return 30;
  return Math.max(0, Math.min(180, Math.floor(parsed)));
}

function buildBufferRange(scheduledAt) {
  const bufferMinutes = getDispatchBufferMinutes();
  const bufferMs = bufferMinutes * 60 * 1000;
  const targetMs = scheduledAt.getTime();
  return {
    bufferMinutes,
    start: new Date(targetMs - bufferMs),
    end: new Date(targetMs + bufferMs),
  };
}

function toRadians(value) {
  return (value * Math.PI) / 180;
}

function distanceKm(pointA, pointB) {
  const earthRadiusKm = 6371;
  const dLat = toRadians(pointB.latitude - pointA.latitude);
  const dLon = toRadians(pointB.longitude - pointA.longitude);
  const lat1 = toRadians(pointA.latitude);
  const lat2 = toRadians(pointB.latitude);

  const haversine =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);

  const arc = 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
  return earthRadiusKm * arc;
}

function orderStopsByNearest(stops, startPoint = DEFAULT_PORT) {
  if (stops.length <= 1) return stops;

  const remaining = [...stops];
  const ordered = [];
  let currentPoint = { latitude: startPoint.latitude, longitude: startPoint.longitude };

  while (remaining.length > 0) {
    let nearestIndex = 0;
    let nearestDistance = Number.POSITIVE_INFINITY;

    for (let index = 0; index < remaining.length; index += 1) {
      const stop = remaining[index];
      const km = distanceKm(currentPoint, {
        latitude: stop.hotel.latitude,
        longitude: stop.hotel.longitude,
      });

      if (km < nearestDistance) {
        nearestDistance = km;
        nearestIndex = index;
      }
    }

    const [next] = remaining.splice(nearestIndex, 1);
    ordered.push({ ...next, distanceFromPreviousKm: Number(nearestDistance.toFixed(2)) });
    currentPoint = {
      latitude: next.hotel.latitude,
      longitude: next.hotel.longitude,
    };
  }

  return ordered;
}

function resolvePort(portRaw) {
  if (!portRaw) return DEFAULT_PORT;
  const normalized = String(portRaw).trim().toLowerCase();
  return PORTS.find(port =>
    port.id.toLowerCase() === normalized || port.name.toLowerCase() === normalized
  );
}

function fallbackVehicleSuggestion(totalPassengers) {
  if (totalPassengers <= 4) return 'Auto privata (4 posti)';
  if (totalPassengers <= 8) return 'Van (8 posti)';
  if (totalPassengers <= 16) return 'Minibus (16 posti)';
  return 'Bus turistico (30+ posti)';
}

async function suggestVehicleFromFleet(totalPassengers, scheduledAt) {
  const activeVehicles = await prisma.vehicle.findMany({
    where: { isActive: true },
    orderBy: [
      { capacity: 'asc' },
      { name: 'asc' },
    ],
  });

  if (activeVehicles.length === 0) return fallbackVehicleSuggestion(totalPassengers);

  let busyVehicleNames = new Set();
  let unavailableVehicleIds = new Set();
  if (scheduledAt) {
    const { start, end } = buildBufferRange(scheduledAt);
    const busyDispatches = await prisma.dispatchPlan.findMany({
      where: {
        scheduledAt: {
          gte: start,
          lte: end,
        },
      },
      select: { vehicle: true, scheduledAt: true },
    });
    busyVehicleNames = new Set(
      busyDispatches
        .filter(dispatch => dispatch.scheduledAt.getTime() !== scheduledAt.getTime())
        .map(dispatch => dispatch.vehicle)
    );

    const unavailability = await prisma.vehicleUnavailability.findMany({
      where: {
        startAt: { lte: scheduledAt },
        endAt: { gt: scheduledAt },
      },
      select: { vehicleId: true },
    });
    unavailableVehicleIds = new Set(unavailability.map(item => item.vehicleId));
  }

  const withCapacity = activeVehicles.filter(vehicle => vehicle.capacity >= totalPassengers);
  const availableWithCapacity = withCapacity.filter(
    vehicle => !busyVehicleNames.has(vehicle.name) && !unavailableVehicleIds.has(vehicle.id)
  );

  const selected = availableWithCapacity[0] || withCapacity[0] || activeVehicles[0];
  return `${selected.name} (${selected.capacity} posti)`;
}

async function ensureVehicleAvailableAtDate({ vehicleName, scheduledAt, excludeDispatchId = null }) {
  const fleetVehicle = await prisma.vehicle.findFirst({
    where: {
      name: String(vehicleName),
      isActive: true,
    },
  });
  if (!fleetVehicle) {
    return { ok: false, error: 'Selected vehicle is not available in active fleet' };
  }

  const { start, end, bufferMinutes } = buildBufferRange(scheduledAt);
  const nearDispatch = await prisma.dispatchPlan.findFirst({
    where: {
      vehicle: String(vehicleName),
      scheduledAt: {
        gte: start,
        lte: end,
      },
      ...(excludeDispatchId ? { id: { not: excludeDispatchId } } : {}),
    },
    select: {
      id: true,
      scheduledAt: true,
    },
  });

  if (nearDispatch && nearDispatch.scheduledAt.getTime() !== scheduledAt.getTime()) {
    return {
      ok: false,
      error: `Selected vehicle has another dispatch within ${bufferMinutes} minutes`,
    };
  }

  const unavailability = await prisma.vehicleUnavailability.findFirst({
    where: {
      vehicleId: fleetVehicle.id,
      startAt: { lte: scheduledAt },
      endAt: { gt: scheduledAt },
    },
  });
  if (unavailability) {
    return { ok: false, error: 'Selected vehicle is unavailable in this time slot' };
  }

  return { ok: true, vehicleId: fleetVehicle.id, bufferMinutes };
}

async function selectAvailableVehicle({ preferredName, scheduledAt, totalPassengers }) {
  const vehicles = await prisma.vehicle.findMany({
    where: { isActive: true },
    orderBy: [
      { capacity: 'asc' },
      { name: 'asc' },
    ],
  });

  if (vehicles.length === 0) {
    return { vehicle: null, error: 'No active vehicles available' };
  }

  let candidates = vehicles;
  if (Number.isFinite(totalPassengers) && totalPassengers > 0) {
    const withCapacity = vehicles.filter(vehicle => vehicle.capacity >= totalPassengers);
    if (withCapacity.length > 0) candidates = withCapacity;
  }

  if (preferredName) {
    const preferredIndex = candidates.findIndex(vehicle => vehicle.name === preferredName);
    if (preferredIndex > 0) {
      candidates = [
        candidates[preferredIndex],
        ...candidates.slice(0, preferredIndex),
        ...candidates.slice(preferredIndex + 1),
      ];
    }
  }

  for (const vehicle of candidates) {
    const availability = await ensureVehicleAvailableAtDate({
      vehicleName: vehicle.name,
      scheduledAt,
    });
    if (availability.ok) {
      return { vehicle, bufferMinutes: availability.bufferMinutes };
    }
  }

  return {
    vehicle: null,
    error: 'No vehicles available in the requested time slot',
  };
}

function buildDispatchWhere(req) {
  const where = {};
  const { service, dateFrom, dateTo, vehicle, driverName } = req.query;

  if (vehicle) where.vehicle = { contains: String(vehicle), mode: 'insensitive' };
  if (driverName) where.driverName = { contains: String(driverName), mode: 'insensitive' };

  if (dateFrom || dateTo) {
    where.scheduledAt = {};
    if (dateFrom) {
      const from = new Date(`${dateFrom}T00:00:00.000Z`);
      if (!Number.isNaN(from.getTime())) where.scheduledAt.gte = from;
    }
    if (dateTo) {
      const to = new Date(`${dateTo}T23:59:59.999Z`);
      if (!Number.isNaN(to.getTime())) where.scheduledAt.lte = to;
    }
  }

  if (service) {
    where.booking = {
      service: String(service),
    };
  }

  return where;
}

router.get('/', async (req, res) => {
  const where = buildDispatchWhere(req);

  const plans = await prisma.dispatchPlan.findMany({
    where,
    orderBy: { scheduledAt: 'asc' },
    include: {
      booking: {
        include: {
          agency: {
            select: { id: true, name: true, email: true },
          },
          hotel: true,
        },
      },
    },
  });

  return res.json(plans);
});

router.get('/unplanned', async (req, res) => {
  const bookings = await prisma.booking.findMany({
    where: {
      status: 'CONFIRMED',
      dispatch: null,
    },
    orderBy: { approvedAt: 'asc' },
    include: {
      agency: {
        select: { id: true, name: true, email: true },
      },
      hotel: true,
    },
  });

  return res.json(bookings);
});

router.get('/vehicle-availability', async (req, res) => {
  const vehicle = String(req.query.vehicle || '').trim();
  const scheduledAtRaw = String(req.query.scheduledAt || '').trim();
  const excludeDispatchId = Number(req.query.excludeDispatchId || 0) || null;

  if (!vehicle || !scheduledAtRaw) {
    return res.status(400).json({ error: 'vehicle and scheduledAt query params are required' });
  }

  const scheduledAt = new Date(scheduledAtRaw);
  if (Number.isNaN(scheduledAt.getTime())) {
    return res.status(400).json({ error: 'Invalid scheduledAt' });
  }

  const availability = await ensureVehicleAvailableAtDate({
    vehicleName: vehicle,
    scheduledAt,
    excludeDispatchId,
  });

  if (!availability.ok) {
    return res.json({
      ok: false,
      message: availability.error,
      bufferMinutes: getDispatchBufferMinutes(),
    });
  }

  return res.json({
    ok: true,
    message: 'Veicolo disponibile per lo slot selezionato',
    bufferMinutes: availability.bufferMinutes || getDispatchBufferMinutes(),
  });
});

router.post('/', async (req, res) => {
  const { bookingId, scheduledAt, vehicle, driverName, notes } = req.body;

  if (!bookingId || !scheduledAt || !vehicle || !driverName) {
    return res.status(400).json({ error: 'bookingId, scheduledAt, vehicle and driverName are required' });
  }

  const booking = await prisma.booking.findUnique({ where: { id: Number(bookingId) } });
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.status !== 'CONFIRMED') {
    return res.status(400).json({ error: 'Only confirmed bookings can be dispatched' });
  }

  const existingPlan = await prisma.dispatchPlan.findUnique({ where: { bookingId: Number(bookingId) } });
  if (existingPlan) {
    return res.status(409).json({ error: 'Dispatch already planned for this booking' });
  }

  const scheduleDate = new Date(scheduledAt);
  if (Number.isNaN(scheduleDate.getTime())) {
    return res.status(400).json({ error: 'Invalid scheduledAt' });
  }

  const availability = await ensureVehicleAvailableAtDate({
    vehicleName: String(vehicle),
    scheduledAt: scheduleDate,
  });
  if (!availability.ok) return res.status(400).json({ error: availability.error });

  const plan = await prisma.dispatchPlan.create({
    data: {
      bookingId: Number(bookingId),
      scheduledAt: scheduleDate,
      vehicle: String(vehicle),
      driverName: String(driverName),
      notes: notes ? String(notes) : null,
      createdBy: req.user.sub,
    },
    include: {
      booking: {
        include: {
          agency: {
            select: { id: true, name: true, email: true },
          },
          hotel: true,
        },
      },
    },
  });

  await logActivity({
    req,
    user: req.user,
    action: 'DISPATCH_CREATE',
    entityType: 'DispatchPlan',
    entityId: plan.id,
    meta: { bookingId: plan.bookingId, vehicle: plan.vehicle },
  });

  sendNotification({
    type: 'DISPATCH_CREATE',
    dispatchId: plan.id,
    bookingId: plan.bookingId,
    vehicle: plan.vehicle,
    audience: 'OPERATOR',
    message: `Dispatch creato #${plan.id} (mezzo ${plan.vehicle})`,
  });
  if (plan.booking?.agency?.id) {
    sendNotification({
      type: 'DISPATCH_CREATE',
      dispatchId: plan.id,
      bookingId: plan.bookingId,
      vehicle: plan.vehicle,
      agencyId: plan.booking.agency.id,
      audience: 'AGENCY',
      message: `Dispatch assegnato per la prenotazione #${plan.bookingId}`,
    });
  }

  return res.status(201).json(plan);
});

router.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { scheduledAt, vehicle, driverName, notes } = req.body;

  const existing = await prisma.dispatchPlan.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: 'Dispatch plan not found' });

  const data = {};

  if (scheduledAt !== undefined) {
    const parsed = new Date(scheduledAt);
    if (Number.isNaN(parsed.getTime())) return res.status(400).json({ error: 'Invalid scheduledAt' });
    data.scheduledAt = parsed;
  }

  const nextScheduledAt = data.scheduledAt || existing.scheduledAt;
  const nextVehicle = vehicle !== undefined ? String(vehicle) : existing.vehicle;
  const availability = await ensureVehicleAvailableAtDate({
    vehicleName: nextVehicle,
    scheduledAt: nextScheduledAt,
    excludeDispatchId: id,
  });
  if (!availability.ok) return res.status(400).json({ error: availability.error });

  if (vehicle !== undefined) data.vehicle = String(vehicle);
  if (driverName !== undefined) data.driverName = String(driverName);
  if (notes !== undefined) data.notes = notes ? String(notes) : null;

  const updated = await prisma.dispatchPlan.update({
    where: { id },
    data,
    include: {
      booking: {
        include: {
          agency: {
            select: { id: true, name: true, email: true },
          },
          hotel: true,
        },
      },
    },
  });

  await logActivity({
    req,
    user: req.user,
    action: 'DISPATCH_UPDATE',
    entityType: 'DispatchPlan',
    entityId: updated.id,
    meta: { vehicle: updated.vehicle },
  });

  sendNotification({
    type: 'DISPATCH_UPDATE',
    dispatchId: updated.id,
    bookingId: updated.bookingId,
    vehicle: updated.vehicle,
    audience: 'OPERATOR',
    message: `Dispatch aggiornato #${updated.id} (mezzo ${updated.vehicle})`,
  });
  if (updated.booking?.agency?.id) {
    sendNotification({
      type: 'DISPATCH_UPDATE',
      dispatchId: updated.id,
      bookingId: updated.bookingId,
      vehicle: updated.vehicle,
      agencyId: updated.booking.agency.id,
      audience: 'AGENCY',
      message: `Dispatch aggiornato per la prenotazione #${updated.bookingId}`,
    });
  }

  return res.json(updated);
});

router.get('/bus/ordered-stops', async (req, res) => {
  const date = String(req.query.date || '').trim();
  const vehicle = String(req.query.vehicle || '').trim();

  if (!date) {
    return res.status(400).json({ error: 'date query param is required (YYYY-MM-DD)' });
  }

  const dateStart = new Date(date);
  dateStart.setHours(0, 0, 0, 0);
  const dateEnd = new Date(date);
  dateEnd.setHours(23, 59, 59, 999);
  if (Number.isNaN(dateStart.getTime()) || Number.isNaN(dateEnd.getTime())) {
    return res.status(400).json({ error: 'Invalid date format, expected YYYY-MM-DD' });
  }

  const plans = await prisma.dispatchPlan.findMany({
    where: {
      scheduledAt: {
        gte: dateStart,
        lte: dateEnd,
      },
      ...(vehicle ? { vehicle } : {}),
      booking: {
        service: 'bus',
        status: 'CONFIRMED',
        hotelId: { not: null },
      },
    },
    orderBy: { scheduledAt: 'asc' },
    include: {
      booking: {
        include: {
          agency: {
            select: { id: true, name: true, email: true },
          },
          hotel: true,
        },
      },
    },
  });

  const stops = plans
    .map(plan => ({
      dispatchId: plan.id,
      bookingId: plan.bookingId,
      scheduledAt: plan.scheduledAt,
      vehicle: plan.vehicle,
      passengers: plan.booking.passengers,
      agency: plan.booking.agency,
      hotel: plan.booking.hotel,
    }))
    .filter(stop => stop.hotel);

  const orderedStops = orderStopsByNearest(stops, DEFAULT_PORT);

  return res.json({
    date,
    vehicle: vehicle || null,
    count: orderedStops.length,
    orderedStops,
  });
});

router.get('/port-shuttle', async (req, res) => {
  const date = String(req.query.date || '').trim();
  const portRaw = String(req.query.port || '').trim();
  const service = String(req.query.service || 'transfer').trim().toLowerCase();

  if (!date) {
    return res.status(400).json({ error: 'date query param is required (YYYY-MM-DD)' });
  }

  const dateStart = new Date(`${date}T00:00:00.000Z`);
  const dateEnd = new Date(`${date}T23:59:59.999Z`);
  if (Number.isNaN(dateStart.getTime()) || Number.isNaN(dateEnd.getTime())) {
    return res.status(400).json({ error: 'Invalid date format, expected YYYY-MM-DD' });
  }

  const port = resolvePort(portRaw);
  if (!port) {
    return res.status(400).json({
      error: 'Invalid port, use a known port name or id',
      availablePorts: PORTS,
    });
  }

  if (!['transfer', 'bus', 'all'].includes(service)) {
    return res.status(400).json({ error: 'service must be transfer, bus, or all' });
  }

  const portRefFilter = portRaw
    ? {
        OR: [
          { travelRef: { contains: port.name, mode: 'insensitive' } },
          { travelRef: null },
          { travelRef: '' },
        ],
      }
    : {};

  const bookings = await prisma.booking.findMany({
    where: {
      status: 'CONFIRMED',
      travelMode: 'SHIP',
      arrivalAt: {
        gte: dateStart,
        lte: dateEnd,
      },
      ...(service === 'all' ? {} : { service }),
      hotelId: { not: null },
      ...portRefFilter,
    },
    orderBy: { arrivalAt: 'asc' },
    include: {
      agency: {
        select: { id: true, name: true, email: true },
      },
      hotel: true,
    },
  });

  const stops = bookings
    .map(booking => ({
      bookingId: booking.id,
      arrivalAt: booking.arrivalAt,
      passengers: booking.passengers,
      service: booking.service,
      travelRef: booking.travelRef,
      agency: booking.agency,
      hotel: booking.hotel,
    }))
    .filter(stop => stop.hotel);

  const orderedStops = orderStopsByNearest(stops, port);

  return res.json({
    date,
    port,
    service,
    count: orderedStops.length,
    orderedStops,
  });
});

router.get('/grouped-arrivals', async (req, res) => {
  const date = String(req.query.date || '').trim();
  const mode = String(req.query.mode || '').trim().toUpperCase();
  const windowMinutes = Math.max(5, Math.min(120, Number(req.query.windowMinutes || 30)));

  if (!date) return res.status(400).json({ error: 'date query param is required (YYYY-MM-DD)' });
  if (!mode || !['SHIP', 'TRAIN'].includes(mode)) {
    return res.status(400).json({ error: 'mode query param must be SHIP or TRAIN' });
  }

  const dateStart = new Date(`${date}T00:00:00.000Z`);
  const dateEnd = new Date(`${date}T23:59:59.999Z`);
  if (Number.isNaN(dateStart.getTime()) || Number.isNaN(dateEnd.getTime())) {
    return res.status(400).json({ error: 'Invalid date format, expected YYYY-MM-DD' });
  }

  const bookings = await prisma.booking.findMany({
    where: {
      status: 'CONFIRMED',
      travelMode: mode,
      arrivalAt: {
        gte: dateStart,
        lte: dateEnd,
      },
    },
    orderBy: { arrivalAt: 'asc' },
    include: {
      agency: {
        select: { id: true, name: true, email: true },
      },
      hotel: true,
      dispatch: {
        select: {
          id: true,
          vehicle: true,
          scheduledAt: true,
        },
      },
    },
  });

  const activeGroupByRef = new Map();
  const groups = [];

  for (const booking of bookings) {
    if (!booking.arrivalAt) continue;

    const arrival = new Date(booking.arrivalAt);
    const travelRef = booking.travelRef || 'SENZA-RIFERIMENTO';
    const key = `${mode}::${travelRef}`;

    let group = activeGroupByRef.get(key);
    const groupStartTime = group ? group.groupStart.getTime() : null;
    const diffMinutes = groupStartTime === null
      ? null
      : (arrival.getTime() - groupStartTime) / (60 * 1000);

    if (!group || diffMinutes === null || diffMinutes > windowMinutes) {
      group = {
        mode,
        travelRef,
        windowMinutes,
        groupStart: new Date(arrival.getTime()),
        bucketStart: new Date(arrival.getTime()),
        bucketEnd: new Date(arrival.getTime() + windowMinutes * 60 * 1000),
        totalPassengers: 0,
        bookingCount: 0,
        bookings: [],
      };
      activeGroupByRef.set(key, group);
      groups.push(group);
    }

    group.totalPassengers += Number(booking.passengers || 0);
    group.bookingCount += 1;
    group.bookings.push({
      id: booking.id,
      service: booking.service,
      passengers: booking.passengers,
      arrivalAt: booking.arrivalAt,
      agency: booking.agency,
      hotel: booking.hotel,
      dispatch: booking.dispatch,
    });
  }

  const items = groups.sort((a, b) => a.bucketStart.getTime() - b.bucketStart.getTime());

  const enriched = [];
  for (const group of items) {
    const suggestedVehicle = await suggestVehicleFromFleet(group.totalPassengers, group.bucketStart);
    enriched.push({
      ...group,
      suggestedVehicle,
    });
  }

  return res.json({
    date,
    mode,
    windowMinutes,
    groups: enriched,
  });
});

router.post('/grouped-arrivals/create-dispatch', async (req, res) => {
  const { bookingIds, scheduledAt, vehicle, driverName, notes } = req.body;

  if (!Array.isArray(bookingIds) || bookingIds.length === 0 || !scheduledAt || !vehicle || !driverName) {
    return res.status(400).json({
      error: 'bookingIds (array), scheduledAt, vehicle and driverName are required',
    });
  }

  const parsedScheduledAt = new Date(scheduledAt);
  if (Number.isNaN(parsedScheduledAt.getTime())) {
    return res.status(400).json({ error: 'Invalid scheduledAt' });
  }

  const normalizedIds = Array.from(new Set(
    bookingIds
      .map(id => Number(id))
      .filter(id => Number.isInteger(id) && id > 0)
  ));

  if (normalizedIds.length === 0) {
    return res.status(400).json({ error: 'bookingIds does not contain valid numeric ids' });
  }

  const bookings = await prisma.booking.findMany({
    where: { id: { in: normalizedIds } },
    include: {
      dispatch: {
        select: { id: true },
      },
    },
  });

  const foundIds = new Set(bookings.map(booking => booking.id));
  const notFoundBookingIds = normalizedIds.filter(id => !foundIds.has(id));

  const createdBookingIds = [];
  const skippedAlreadyPlanned = [];
  const skippedNotConfirmed = [];
  const plannedBookings = [];

  for (const booking of bookings) {
    if (booking.dispatch) {
      skippedAlreadyPlanned.push(booking.id);
      continue;
    }

    if (booking.status !== 'CONFIRMED') {
      skippedNotConfirmed.push(booking.id);
      continue;
    }

    plannedBookings.push(booking);
  }

  let resolvedVehicleName = String(vehicle);
  if (plannedBookings.length > 0) {
    const totalPassengers = plannedBookings.reduce(
      (sum, booking) => sum + Number(booking.passengers || 0),
      0
    );
    const selection = await selectAvailableVehicle({
      preferredName: resolvedVehicleName,
      scheduledAt: parsedScheduledAt,
      totalPassengers,
    });
    if (!selection.vehicle) {
      return res.status(400).json({ error: selection.error });
    }
    resolvedVehicleName = selection.vehicle.name;
  }

  for (const booking of plannedBookings) {
    await prisma.dispatchPlan.create({
      data: {
        bookingId: booking.id,
        scheduledAt: parsedScheduledAt,
        vehicle: resolvedVehicleName,
        driverName: String(driverName),
        notes: notes ? String(notes) : null,
        createdBy: req.user.sub,
      },
    });

    createdBookingIds.push(booking.id);
  }

  return res.status(201).json({
    requested: normalizedIds.length,
    created: createdBookingIds.length,
    skippedAlreadyPlanned: skippedAlreadyPlanned.length,
    skippedNotConfirmed: skippedNotConfirmed.length,
    notFound: notFoundBookingIds.length,
    vehicleRequested: String(vehicle),
    vehicleUsed: resolvedVehicleName,
    createdBookingIds,
    skippedAlreadyPlannedIds: skippedAlreadyPlanned,
    skippedNotConfirmedIds: skippedNotConfirmed,
    notFoundBookingIds,
  });
});

router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const existing = await prisma.dispatchPlan.findUnique({
    where: { id },
    include: {
      booking: {
        include: {
          agency: { select: { id: true, name: true, email: true } },
        },
      },
    },
  });
  if (!existing) return res.status(404).json({ error: 'Dispatch plan not found' });

  await prisma.dispatchPlan.delete({ where: { id } });
  await logActivity({
    req,
    user: req.user,
    action: 'DISPATCH_DELETE',
    entityType: 'DispatchPlan',
    entityId: id,
    meta: { bookingId: existing.bookingId, vehicle: existing.vehicle },
  });
  sendNotification({
    type: 'DISPATCH_DELETE',
    dispatchId: id,
    bookingId: existing.bookingId,
    vehicle: existing.vehicle,
    audience: 'OPERATOR',
    message: `Dispatch eliminato #${id}`,
  });
  if (existing.booking?.agency?.id) {
    sendNotification({
      type: 'DISPATCH_DELETE',
      dispatchId: id,
      bookingId: existing.bookingId,
      vehicle: existing.vehicle,
      agencyId: existing.booking.agency.id,
      audience: 'AGENCY',
      message: `Dispatch eliminato per la prenotazione #${existing.bookingId}`,
    });
  }
  return res.status(204).send();
});

module.exports = router;
