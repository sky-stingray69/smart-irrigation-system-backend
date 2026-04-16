const rateLimit = require('express-rate-limit');

/**
 * Strict rate limiter for ESP32 device endpoints.
 * Prevents runaway nodes from flooding the DB or weather API.
 */
const deviceRateLimiter = rateLimit({
  windowMs: parseInt(process.env.DEVICE_RATE_LIMIT_WINDOW_MS) || 60_000, // 1 minute
  max: parseInt(process.env.DEVICE_RATE_LIMIT_MAX) || 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.params.node_id || req.ip,
  message: {
    error: 'Too many requests from this device. Please slow down polling frequency.',
  },
});

/**
 * Lighter rate limiter for web portal endpoints.
 */
const portalRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
});

module.exports = { deviceRateLimiter, portalRateLimiter };
