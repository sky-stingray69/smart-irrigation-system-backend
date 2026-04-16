const SensorData = require('../models/SensorData');
const { getPredictedRainfall } = require('./weatherService');

const MIN_EFFECTIVE_RAINFALL_MM = parseFloat(process.env.MIN_EFFECTIVE_RAINFALL_MM) || 5;
const WEATHER_FORECAST_HOURS = parseInt(process.env.WEATHER_FORECAST_HOURS) || 2;

/**
 * Water deficit lookup table by crop type (liters per m² per percentage point deficit).
 * Extend this table as more crop profiles are added.
 */
const CROP_WATER_DEFICIT_RATE = {
  Tomatoes:  0.8,
  Wheat:     0.5,
  Rice:      1.2,
  Corn:      0.7,
  Cotton:    0.6,
  Default:   0.6,
};

/**
 * Core Decision Engine.
 *
 * Step 1: Is soil adequately moist? → STANDBY
 * Step 2: Is significant rain coming? → STANDBY
 * Step 3: Calculate water deficit and return a SPRINKLE command.
 *
 * @param {Object} node  NodeConfiguration document
 * @returns {Promise<{action: string, duration_seconds: number, water_volume_liters: number, reason: string}>}
 */
const getIrrigationDecision = async (node) => {
  const { node_id, moisture_threshold_percent, irrigation_rate_liters_per_min, coordinates, crop_type } = node;

  // ── Step 1: Get latest soil moisture reading ──────────────────────────────
  const latestReading = await SensorData.findOne(
    { 'metadata.node_id': node_id },
    { soil_moisture_percent: 1, timestamp: 1 },
    { sort: { timestamp: -1 } }
  );

  if (!latestReading) {
    return {
      action: 'STANDBY',
      duration_seconds: 0,
      water_volume_liters: 0,
      reason: 'No sensor data available. Cannot make a decision.',
    };
  }

  const currentMoisture = latestReading.soil_moisture_percent;

  // ── Step 2: Soil is wet enough — no irrigation needed ────────────────────
  if (currentMoisture >= moisture_threshold_percent) {
    return {
      action: 'STANDBY',
      duration_seconds: 0,
      water_volume_liters: 0,
      reason: `Soil moisture (${currentMoisture}%) meets threshold (${moisture_threshold_percent}%).`,
    };
  }

  // ── Step 3: Soil is dry — check weather before triggering pump ────────────
  const predictedRainMm = await getPredictedRainfall(
    coordinates.lat,
    coordinates.lon,
    WEATHER_FORECAST_HOURS
  );

  if (predictedRainMm >= MIN_EFFECTIVE_RAINFALL_MM) {
    return {
      action: 'STANDBY',
      duration_seconds: 0,
      water_volume_liters: 0,
      reason: `Rain expected: ${predictedRainMm.toFixed(1)}mm in next ${WEATHER_FORECAST_HOURS}h. Skipping irrigation.`,
    };
  }

  // ── Step 4: Calculate water needed and return SPRINKLE command ────────────
  const moistureDeficit = moisture_threshold_percent - currentMoisture;
  const deficitRate = CROP_WATER_DEFICIT_RATE[crop_type] || CROP_WATER_DEFICIT_RATE.Default;

  // Simple linear model: liters needed = deficit% × rate_per_percent
  const waterVolumeLiters = Math.round(moistureDeficit * deficitRate * 10) / 10;
  const durationSeconds = Math.round((waterVolumeLiters / irrigation_rate_liters_per_min) * 60);

  return {
    action: 'SPRINKLE',
    duration_seconds: durationSeconds,
    water_volume_liters: waterVolumeLiters,
    reason: `Soil at ${currentMoisture}% (threshold: ${moisture_threshold_percent}%). Rain: ${predictedRainMm.toFixed(1)}mm predicted.`,
  };
};

module.exports = { getIrrigationDecision };
