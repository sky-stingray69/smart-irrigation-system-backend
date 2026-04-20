const express = require('express');
const router = express.Router();
const SensorData = require('../models/SensorData');
const { getIrrigationDecision } = require('../services/decisionEngine');
const { authenticateDevice } = require('../middleware/auth');
const { deviceRateLimiter } = require('../middleware/rateLimiter');

// Apply rate limiter to all device routes
router.use(deviceRateLimiter);

/**
 * POST /api/v1/devices/:node_id/telemetry
 * ESP32 pushes sensor readings to the cloud.
 */
router.post('/:node_id/telemetry', authenticateDevice, async (req, res) => {
  const { node_id } = req.params;
  const { temperature, humidity, soil_moisture } = req.body;

  // Validate payload
  if (temperature == null || humidity == null || soil_moisture == null) {
    return res.status(400).json({
      error: 'Missing required fields: temperature, humidity, soil_moisture.',
    });
  }

  if (
    typeof temperature !== 'number' ||
    typeof humidity !== 'number' ||
    typeof soil_moisture !== 'number'
  ) {
    return res.status(400).json({ error: 'All sensor values must be numbers.' });
  }

  if (humidity < 0 || humidity > 100 || soil_moisture < 0 || soil_moisture > 100) {
    return res.status(400).json({ error: 'humidity and soil_moisture must be between 0 and 100.' });
  }

  try {
    await SensorData.create({
      timestamp: new Date(),
      metadata: { node_id },
      temperature_c: temperature,
      humidity_percent: humidity,
      soil_moisture_percent: soil_moisture,
    });

    return res.status(201).json({ message: 'Telemetry recorded.' });
  } catch (err) {
    console.error('Telemetry write error:', err);
    return res.status(500).json({ error: 'Failed to store telemetry data.' });
  }
});

/**
 * GET /api/v1/devices/:node_id/action
 * ESP32 polls for irrigation command.
 */
router.get('/:node_id/action', authenticateDevice, async (req, res) => {
  try {
    const decision = await getIrrigationDecision(req.node);
    return res.status(200).json(decision);
  } catch (err) {
    console.error('Decision engine error:', err);
    return res.status(500).json({ error: 'Failed to compute irrigation decision.' });
  }
});

router.get('/:node_id/config', authenticateDevice, async (req, res) => {
  try {
    // req.node is attached by authenticateDevice after validating the API key.
    // We re-fetch only if somehow the middleware didn't populate it (defensive).
    const node = req.node
      ?? (await NodeConfiguration.findOne({
           node_id: req.params.node_id,
           is_active: true,
         }).lean());

    if (!node) {
      return res.status(404).json({ error: 'Node configuration not found.' });
    }

    return res.status(200).json({
      node_id:                 node.node_id,
      soil_moisture_threshold: node.soil_moisture_threshold,
      servo_angle:             node.servo_angle,
    });
  } catch (err) {
    console.error('Config fetch error:', err);
    return res.status(500).json({ error: 'Failed to retrieve node configuration.' });
  }
});

module.exports = router;