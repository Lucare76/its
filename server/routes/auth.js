const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const prisma = require('../lib/prisma');
const { sendPasswordResetEmail, sendPasswordChangedEmail } = require('../lib/mailer');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const ACCESS_TOKEN_TTL = process.env.ACCESS_TOKEN_TTL || '2h';
const REFRESH_TOKEN_TTL_DAYS = Number(process.env.REFRESH_TOKEN_TTL_DAYS || 30);
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

function getClientInfo(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const ip = Array.isArray(forwarded)
    ? forwarded[0]
    : (forwarded ? String(forwarded).split(',')[0].trim() : req.ip || 'unknown');
  const userAgent = req.headers['user-agent'] || null;
  return { ip, userAgent };
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function issueAccessToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role, name: user.name },
    JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_TTL }
  );
}

async function issueRefreshToken(userId, req) {
  if (!prisma.refreshToken) return null;
  const refreshToken = crypto.randomBytes(48).toString('hex');
  const tokenHash = hashToken(refreshToken);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
  const { ip, userAgent } = getClientInfo(req);
  await prisma.refreshToken.create({
    data: {
      tokenHash,
      userId,
      expiresAt,
      createdByIp: ip,
      userAgent,
    },
  });
  return refreshToken;
}

router.post('/register', async (req, res) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'name, email and password are required' });
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return res.status(409).json({ error: 'Email already registered' });

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: { name, email, passwordHash, role: 'AGENCY' },
    select: { id: true, name: true, email: true, role: true },
  });

  return res.status(201).json(user);
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const token = issueAccessToken(user);
  const refreshToken = await issueRefreshToken(user.id, req);

  return res.json({
    token,
    refreshToken,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      lastPasswordChangeAt: user.lastPasswordChangeAt,
      lastPasswordChangeIp: user.lastPasswordChangeIp,
    },
  });
});

router.post('/refresh', async (req, res) => {
  if (!prisma.refreshToken) {
    return res.status(503).json({ error: 'Refresh tokens not available (schema not synced)' });
  }
  const { refreshToken } = req.body || {};
  if (!refreshToken) return res.status(400).json({ error: 'refreshToken is required' });

  const tokenHash = hashToken(refreshToken);
  const existing = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    include: { user: true },
  });

  if (!existing || existing.revokedAt || existing.expiresAt < new Date()) {
    return res.status(401).json({ error: 'Invalid refresh token' });
  }

  await prisma.refreshToken.update({
    where: { id: existing.id },
    data: { revokedAt: new Date(), lastUsedAt: new Date() },
  });

  const token = issueAccessToken(existing.user);
  const nextRefreshToken = await issueRefreshToken(existing.userId, req);

  return res.json({
    token,
    refreshToken: nextRefreshToken,
  });
});

router.post('/logout', async (req, res) => {
  const { refreshToken } = req.body || {};

  if (refreshToken && prisma.refreshToken) {
    const tokenHash = hashToken(refreshToken);
    await prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (token && prisma.refreshToken) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      if (payload?.sub) {
        await prisma.refreshToken.updateMany({
          where: { userId: payload.sub, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
    } catch {
      // ignore invalid access token on logout
    }
  }

  return res.json({ ok: true });
});

router.get('/me', requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.sub },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      createdAt: true,
      lastPasswordChangeAt: true,
      lastPasswordChangeIp: true,
    },
  });

  if (!user) return res.status(404).json({ error: 'User not found' });
  return res.json(user);
});

router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email is required' });

  const user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + 1000 * 60 * 30);
    await prisma.passwordResetToken.create({
      data: {
        token,
        userId: user.id,
        expiresAt,
      },
    });

    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const resetUrl = `${baseUrl}/?resetToken=${token}`;
    await sendPasswordResetEmail({ to: email, resetUrl });
  }

  return res.json({
    message: 'Se l\'email esiste, il link di recupero è stato generato.',
    supportEmail: process.env.SUPPORT_EMAIL || 'lucarenna76@gmail.com',
  });
});

router.post('/reset-password', async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) {
    return res.status(400).json({ error: 'token and newPassword are required' });
  }

  const resetToken = await prisma.passwordResetToken.findUnique({ where: { token } });
  if (!resetToken || resetToken.usedAt || resetToken.expiresAt < new Date()) {
    return res.status(400).json({ error: 'Invalid or expired token' });
  }

  const user = await prisma.user.findUnique({
    where: { id: resetToken.userId },
    select: { id: true, email: true, name: true },
  });
  if (!user) return res.status(404).json({ error: 'User not found' });

  const passwordHash = await bcrypt.hash(newPassword, 10);
  const forwarded = req.headers['x-forwarded-for'];
  const clientIp = Array.isArray(forwarded)
    ? forwarded[0]
    : (forwarded ? String(forwarded).split(',')[0].trim() : req.ip || 'unknown');
  const changedAt = new Date();

  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        lastPasswordChangeAt: changedAt,
        lastPasswordChangeIp: clientIp,
      },
    }),
    ...(prisma.refreshToken ? [prisma.refreshToken.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    })] : []),
    prisma.passwordResetToken.update({
      where: { id: resetToken.id },
      data: { usedAt: new Date() },
    }),
  ]);

  await sendPasswordChangedEmail({ to: user.email, userName: user.name });

  return res.json({ message: 'Password aggiornata con successo' });
});

module.exports = router;
