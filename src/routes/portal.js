const express = require('express');
const router = express.Router();
const SensorData = require('../models/SensorData');
const NodeConfiguration = require('../models/NodeConfiguration');
const { authenticateJWT, requireRole } = require('../middleware/auth');
const { portalRateLimiter } = require('../middleware/rateLimiter');
const { getCacheStats } = require('../services/weatherService');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

router.use(portalRateLimiter);
router.use(authenticateJWT);

// ─── Sensor Data ──────────────────────────────────────────────────────────────

/**
 * GET /api/v1/portal/sensors
 * Fetch historical sensor data for a node within a time range.
 * Query params: node_id (required), start_time, end_time, limit
 */
router.get('/sensors', async (req, res) => {
  const { node_id, start_time, end_time, limit = 500 } = req.query;

  if (!node_id) {
    return res.status(400).json({ error: 'Query parameter "node_id" is required.' });
  }

  const filter = { 'metadata.node_id': node_id };

  if (start_time || end_time) {
    filter.timestamp = {};
    if (start_time) filter.timestamp.$gte = new Date(start_time);
    if (end_time) filter.timestamp.$lte = new Date(end_time);
    if (isNaN(filter.timestamp.$gte) || isNaN(filter.timestamp.$lte)) {
      return res.status(400).json({ error: 'Invalid date format for start_time or end_time.' });
    }
  }

  try {
    const data = await SensorData.find(filter)
      .sort({ timestamp: -1 })
      .limit(Math.min(parseInt(limit), 2000))
      .lean();

    return res.status(200).json({ count: data.length, data });
  } catch (err) {
    console.error('Sensor data fetch error:', err);
    return res.status(500).json({ error: 'Failed to retrieve sensor data.' });
  }
});

// ─── Node Configuration ───────────────────────────────────────────────────────

/**
 * GET /api/v1/portal/nodes
 * List all registered ESP32 nodes and their configurations.
 */
router.get('/nodes', async (req, res) => {
  try {
    const nodes = await NodeConfiguration.find({}, { api_key_hash: 0 }).lean();
    return res.status(200).json({ count: nodes.length, nodes });
  } catch (err) {
    console.error('Node list fetch error:', err);
    return res.status(500).json({ error: 'Failed to retrieve node configurations.' });
  }
});

/**
 * GET /api/v1/portal/nodes/:node_id
 * Get a single node's configuration.
 */
router.get('/nodes/:node_id', async (req, res) => {
  try {
    const node = await NodeConfiguration.findOne(
      { node_id: req.params.node_id },
      { api_key_hash: 0 }
    ).lean();
    if (!node) return res.status(404).json({ error: 'Node not found.' });
    return res.status(200).json(node);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to retrieve node.' });
  }
});

/**
 * POST /api/v1/portal/nodes
 * Register a new ESP32 node. Admin only.
 * Returns a one-time API key — store it securely, it won't be shown again.
 */
router.post('/nodes', requireRole('admin'), async (req, res) => {
  const { node_id, location_name, crop_type, moisture_threshold_percent,
          irrigation_rate_liters_per_min, coordinates } = req.body;

  if (!node_id || !location_name || !crop_type || !coordinates?.lat || !coordinates?.lon) {
    return res.status(400).json({
      error: 'Required fields: node_id, location_name, crop_type, coordinates.lat, coordinates.lon',
    });
  }

  // Generate a secure random API key for the device
  const rawApiKey = crypto.randomBytes(32).toString('hex');
  const api_key_hash = await bcrypt.hash(rawApiKey, 10);

  try {
    const node = await NodeConfiguration.create({
      node_id,
      location_name,
      crop_type,
      moisture_threshold_percent: moisture_threshold_percent ?? 40,
      irrigation_rate_liters_per_min: irrigation_rate_liters_per_min ?? 5.0,
      coordinates,
      api_key_hash,
    });

    return res.status(201).json({
      message: 'Node registered successfully. Save the API key — it will not be shown again.',
      node_id: node.node_id,
      api_key: rawApiKey, // Shown once only
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: `Node '${node_id}' already exists.` });
    }
    console.error('Node creation error:', err);
    return res.status(500).json({ error: 'Failed to register node.' });
  }
});

/**
 * PUT /api/v1/portal/nodes/:node_id
 * Update a node's crop and irrigation configuration. Admin only.
 */
router.put('/nodes/:node_id', requireRole('admin'), async (req, res) => {
  const allowedUpdates = [
    'crop_type', 'moisture_threshold_percent', 'irrigation_rate_liters_per_min',
    'location_name', 'coordinates', 'is_active',
  ];

  const updates = {};
  for (const key of allowedUpdates) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No valid fields provided for update.' });
  }

  try {
    const node = await NodeConfiguration.findOneAndUpdate(
      { node_id: req.params.node_id },
      { $set: updates },
      { new: true, runValidators: true, projection: { api_key_hash: 0 } }
    );
    if (!node) return res.status(404).json({ error: 'Node not found.' });
    return res.status(200).json({ message: 'Node updated.', node });
  } catch (err) {
    console.error('Node update error:', err);
    return res.status(500).json({ error: 'Failed to update node configuration.' });
  }
});

/**
 * DELETE /api/v1/portal/nodes/:node_id
 * Deactivate (soft-delete) a node. Admin only.
 */
router.delete('/nodes/:node_id', requireRole('admin'), async (req, res) => {
  try {
    const node = await NodeConfiguration.findOneAndUpdate(
      { node_id: req.params.node_id },
      { $set: { is_active: false } },
      { new: true, projection: { api_key_hash: 0 } }
    );
    if (!node) return res.status(404).json({ error: 'Node not found.' });
    return res.status(200).json({ message: `Node '${req.params.node_id}' deactivated.` });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to deactivate node.' });
  }
});

/**
 * GET /api/v1/portal/system/status
 * System health overview for the dashboard.
 */
router.get('/system/status', async (req, res) => {
  try {
    const [totalNodes, activeNodes, totalReadings] = await Promise.all([
      NodeConfiguration.countDocuments(),
      NodeConfiguration.countDocuments({ is_active: true }),
      SensorData.countDocuments(),
    ]);

    return res.status(200).json({
      status: 'operational',
      nodes: { total: totalNodes, active: activeNodes },
      sensor_readings_stored: totalReadings,
      weather_cache: getCacheStats(),
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch system status.' });
  }
});

module.exports = router;
