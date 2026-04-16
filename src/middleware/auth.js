const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const NodeConfiguration = require('../models/NodeConfiguration');

/**
 * JWT middleware for Web Portal users.
 */
const authenticateJWT = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing or malformed token.' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select('-password');
    if (!user) return res.status(401).json({ error: 'Unauthorized: User not found.' });
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized: Invalid or expired token.' });
  }
};

/**
 * API Key middleware for ESP32 devices.
 * Validates the key against the hashed key stored in NodeConfiguration.
 */
const authenticateDevice = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing device API key.' });
  }

  const apiKey = authHeader.split(' ')[1];
  const { node_id } = req.params;

  try {
    const node = await NodeConfiguration.findOne({ node_id, is_active: true });
    if (!node) {
      return res.status(404).json({ error: `Device '${node_id}' not found or inactive.` });
    }

    const isValid = await bcrypt.compare(apiKey, node.api_key_hash);
    if (!isValid) {
      return res.status(403).json({ error: 'Forbidden: Invalid device API key.' });
    }

    req.node = node;
    next();
  } catch (err) {
    console.error('Device auth error:', err);
    return res.status(500).json({ error: 'Internal server error during authentication.' });
  }
};

/**
 * Role guard — use after authenticateJWT.
 */
const requireRole = (role) => (req, res, next) => {
  if (req.user?.role !== role) {
    return res.status(403).json({ error: 'Forbidden: Insufficient permissions.' });
  }
  next();
};

module.exports = { authenticateJWT, authenticateDevice, requireRole };
