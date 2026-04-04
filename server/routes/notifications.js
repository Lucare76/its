const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { createSseHandler } = require('../lib/notifications');

const router = express.Router();

router.get('/stream', (req, res, next) => {
  if (!req.headers.authorization && req.query.token) {
    req.headers.authorization = `Bearer ${String(req.query.token)}`;
  }
  return requireAuth(req, res, next);
}, createSseHandler());

module.exports = router;
