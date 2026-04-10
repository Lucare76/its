const express = require('express');
const fetch = require('node-fetch');
const prisma = require('../lib/prisma');
const { logActivity } = require('../lib/audit');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

router.get('/', async (req, res) => {
  const hotels = await prisma.hotel.findMany({
    orderBy: { name: 'asc' },
  });

  return res.json(hotels);
});

router.post('/', requireRole('OPERATOR'), async (req, res) => {
  const { name, address, latitude, longitude } = req.body;

  if (!name || !address || latitude === undefined || longitude === undefined) {
    return res.status(400).json({ error: 'name, address, latitude and longitude are required' });
  }

  const lat = Number(latitude);
  const lng = Number(longitude);
  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    return res.status(400).json({ error: 'latitude and longitude must be numbers' });
  }

  const hotel = await prisma.hotel.create({
    data: {
      name: String(name),
      address: String(address),
      latitude: lat,
      longitude: lng,
    },
  });

  await logActivity({
    req,
    user: req.user,
    action: 'HOTEL_CREATE',
    entityType: 'Hotel',
    entityId: hotel.id,
    meta: { name: hotel.name },
  });

  return res.status(201).json(hotel);
});

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function buildAddress(tags = {}) {
  const street = [tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join(' ');
  const locality = tags['addr:place'] || tags['addr:city'] || tags['addr:town'] || tags['addr:village'];
  const postcode = tags['addr:postcode'];
  const parts = [street, locality, postcode].filter(Boolean);
  if (parts.length > 0) return parts.join(', ');
  return tags['addr:full'] || 'Ischia';
}

router.post('/import-osm', requireRole('OPERATOR'), async (req, res) => {
  const limitRaw = req.body?.limit;
  const limit = limitRaw === undefined || limitRaw === '' ? null : Number(limitRaw);
  if (limit !== null && (Number.isNaN(limit) || limit <= 0)) {
    return res.status(400).json({ error: 'limit must be a positive number' });
  }

  const tourismFilter = '["tourism"~"hotel|hostel|guest_house|apartment|motel|resort|chalet|camp_site|caravan_site|alpine_hut|bed_and_breakfast"]';
  const amenityFilter = '["amenity"~"hotel|guest_house|hostel"]';
  const buildingFilter = '["building"~"hotel|guest_house"]';

  const query = [
    '[out:json][timeout:60];',
    'area["name"="Ischia"]["place"="island"]->.searchArea;',
    '(',
    `node${tourismFilter}(area.searchArea);`,
    `way${tourismFilter}(area.searchArea);`,
    `relation${tourismFilter}(area.searchArea);`,
    `node${amenityFilter}(area.searchArea);`,
    `way${amenityFilter}(area.searchArea);`,
    `relation${amenityFilter}(area.searchArea);`,
    `node${buildingFilter}(area.searchArea);`,
    `way${buildingFilter}(area.searchArea);`,
    `relation${buildingFilter}(area.searchArea);`,
    ');',
    'out center tags;',
  ].join('\n');

  let overpassData;
  try {
    const response = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: query,
    });
    if (!response.ok) {
      return res.status(502).json({ error: 'Overpass API error' });
    }
    overpassData = await response.json();
  } catch (error) {
    return res.status(502).json({ error: 'Overpass API not reachable' });
  }

  const elements = Array.isArray(overpassData?.elements) ? overpassData.elements : [];
  const existing = await prisma.hotel.findMany({ select: { name: true, address: true } });
  const existingKeys = new Set(
    existing.map(hotel => `${normalizeText(hotel.name)}|${normalizeText(hotel.address)}`)
  );

  const toCreate = [];
  let skipped = 0;

  for (const element of elements) {
    const tags = element.tags || {};
    const name = tags.name ? String(tags.name) : '';
    const latitude = element.lat ?? element.center?.lat;
    const longitude = element.lon ?? element.center?.lon;
    if (!name || latitude === undefined || longitude === undefined) {
      skipped += 1;
      continue;
    }
    const address = buildAddress(tags);
    const key = `${normalizeText(name)}|${normalizeText(address)}`;
    if (existingKeys.has(key)) {
      skipped += 1;
      continue;
    }
    existingKeys.add(key);
    toCreate.push({
      name,
      address,
      latitude: Number(latitude),
      longitude: Number(longitude),
    });
    if (limit && toCreate.length >= limit) break;
  }

  if (toCreate.length > 0) {
    await prisma.hotel.createMany({ data: toCreate });
  }

  await logActivity({
    req,
    user: req.user,
    action: 'HOTEL_IMPORT_OSM',
    entityType: 'Hotel',
    entityId: null,
    meta: { created: toCreate.length, skipped, found: elements.length },
  });

  return res.json({
    found: elements.length,
    created: toCreate.length,
    skipped,
    source: 'OSM Overpass',
  });
});

router.put('/:id', requireRole('OPERATOR'), async (req, res) => {
  const id = Number(req.params.id);
  const { name, address, latitude, longitude } = req.body;

  const existing = await prisma.hotel.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: 'Hotel not found' });

  const data = {};
  if (name !== undefined) data.name = String(name);
  if (address !== undefined) data.address = String(address);
  if (latitude !== undefined) {
    const lat = Number(latitude);
    if (Number.isNaN(lat)) return res.status(400).json({ error: 'latitude must be a number' });
    data.latitude = lat;
  }
  if (longitude !== undefined) {
    const lng = Number(longitude);
    if (Number.isNaN(lng)) return res.status(400).json({ error: 'longitude must be a number' });
    data.longitude = lng;
  }

  const hotel = await prisma.hotel.update({ where: { id }, data });
  return res.json(hotel);
});

module.exports = router;
