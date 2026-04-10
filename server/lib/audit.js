const prisma = require('./prisma');

function getClientIp(req) {
  const forwarded = req?.headers?.['x-forwarded-for'];
  if (Array.isArray(forwarded)) return forwarded[0];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return req?.ip || 'unknown';
}

async function logActivity({ req, user, action, entityType, entityId = null, meta = null }) {
  try {
    if (!prisma.activityLog) return;
    await prisma.activityLog.create({
      data: {
        userId: user?.sub || null,
        action,
        entityType,
        entityId,
        meta,
        ip: getClientIp(req),
      },
    });
  } catch (err) {
    // best-effort logging; do not fail main flow
    console.error('[audit] failed to log activity', err?.message || err);
  }
}

module.exports = {
  logActivity,
};
