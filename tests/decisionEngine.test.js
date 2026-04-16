// tests/decisionEngine.test.js
// Run with: npm test

const { getIrrigationDecision } = require('../src/services/decisionEngine');

// ─── Mocks ────────────────────────────────────────────────────────────────────
jest.mock('../src/models/SensorData');
jest.mock('../src/services/weatherService');

const SensorData = require('../src/models/SensorData');
const { getPredictedRainfall } = require('../src/services/weatherService');

const mockNode = {
  node_id: 'esp32_test_1',
  crop_type: 'Tomatoes',
  moisture_threshold_percent: 40,
  irrigation_rate_liters_per_min: 5.0,
  coordinates: { lat: 17.44, lon: 78.35 },
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Decision Engine', () => {

  beforeEach(() => jest.clearAllMocks());

  test('returns STANDBY when no sensor data is available', async () => {
    SensorData.findOne = jest.fn().mockResolvedValue(null);
    const result = await getIrrigationDecision(mockNode);
    expect(result.action).toBe('STANDBY');
    expect(result.reason).toMatch(/No sensor data/i);
  });

  test('returns STANDBY when soil moisture meets threshold', async () => {
    SensorData.findOne = jest.fn().mockResolvedValue({ soil_moisture_percent: 50, timestamp: new Date() });
    const result = await getIrrigationDecision(mockNode);
    expect(result.action).toBe('STANDBY');
    expect(result.duration_seconds).toBe(0);
    expect(result.reason).toMatch(/meets threshold/i);
  });

  test('returns STANDBY when rain is predicted above threshold', async () => {
    SensorData.findOne = jest.fn().mockResolvedValue({ soil_moisture_percent: 20, timestamp: new Date() });
    getPredictedRainfall.mockResolvedValue(8); // 8mm > 5mm threshold
    const result = await getIrrigationDecision(mockNode);
    expect(result.action).toBe('STANDBY');
    expect(result.reason).toMatch(/Rain expected/i);
  });

  test('returns SPRINKLE with correct duration when soil is dry and no rain', async () => {
    SensorData.findOne = jest.fn().mockResolvedValue({ soil_moisture_percent: 20, timestamp: new Date() });
    getPredictedRainfall.mockResolvedValue(1); // 1mm < 5mm threshold
    const result = await getIrrigationDecision(mockNode);

    expect(result.action).toBe('SPRINKLE');
    expect(result.duration_seconds).toBeGreaterThan(0);
    expect(result.water_volume_liters).toBeGreaterThan(0);

    // Tomatoes: deficit = 40-20 = 20%, rate=0.8 → volume = 20*0.8 = 16L
    expect(result.water_volume_liters).toBe(16.0);
    // duration = (16L / 5 L/min) * 60s = 192s
    expect(result.duration_seconds).toBe(192);
  });

  test('returns STANDBY when rain exactly equals threshold', async () => {
    SensorData.findOne = jest.fn().mockResolvedValue({ soil_moisture_percent: 10, timestamp: new Date() });
    getPredictedRainfall.mockResolvedValue(5); // exactly 5mm
    const result = await getIrrigationDecision(mockNode);
    expect(result.action).toBe('STANDBY');
  });

  test('uses Default crop rate for unknown crop types', async () => {
    const unknownCropNode = { ...mockNode, crop_type: 'Lavender' };
    SensorData.findOne = jest.fn().mockResolvedValue({ soil_moisture_percent: 30, timestamp: new Date() });
    getPredictedRainfall.mockResolvedValue(0);
    const result = await getIrrigationDecision(unknownCropNode);
    // Default rate = 0.6, deficit = 10%, volume = 10 * 0.6 = 6L
    expect(result.action).toBe('SPRINKLE');
    expect(result.water_volume_liters).toBe(6.0);
  });

});
