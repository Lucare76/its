require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bookingsRouter = require('./routes/bookings');
const authRouter = require('./routes/auth');
const dispatchRouter = require('./routes/dispatch');
const hotelsRouter = require('./routes/hotels');
const vehiclesRouter = require('./routes/vehicles');
const accountingRouter = require('./routes/accounting');
const auditRouter = require('./routes/audit');
const notificationsRouter = require('./routes/notifications');
const { scheduleDailyBackup } = require('./lib/backup');
const { startImapIngestScheduler } = require('./lib/imapIngest');

const prisma = require('./lib/prisma');
const app = express();
app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  const schemaReady = Boolean(
    // RefreshToken and ActivityLog depend on schema changes
    // If they are missing in Prisma Client, schema was not pushed.
    prisma.refreshToken && prisma.activityLog
  );
  res.setHeader('X-Schema-Ready', schemaReady ? 'true' : 'false');
  next();
});
app.use('/api/auth', authRouter);
app.use('/api/bookings', bookingsRouter);
app.use('/api/dispatch', dispatchRouter);
app.use('/api/hotels', hotelsRouter);
app.use('/api/vehicles', vehiclesRouter);
app.use('/api/accounting', accountingRouter);
app.use('/api/audit', auditRouter);
app.use('/api/notifications', notificationsRouter);
app.get('/api/health', (req, res) => res.json({ ok: true }));
app.get('/api/status', (req, res) => {
  const schemaReady = Boolean(prisma.refreshToken && prisma.activityLog);
  res.json({
    ok: true,
    schemaReady,
    uptimeSeconds: Math.round(process.uptime()),
    node: process.version,
  });
});

const port = process.env.PORT || 4000;
app.listen(port, () => {
	console.log(`ITS Server listening on ${port}`);
	scheduleDailyBackup();
	startImapIngestScheduler();
});
