const mongoose = require('mongoose');

const sensorDataSchema = new mongoose.Schema(
  {
    timestamp: { type: Date, default: Date.now, required: true },
    metadata: {
      node_id: { type: String, required: true, index: true },
    },
    temperature_c: { type: Number, required: true },
    humidity_percent: { type: Number, required: true, min: 0, max: 100 },
    soil_moisture_percent: { type: Number, required: true, min: 0, max: 100 },
  },
  {
    timeseries: {
      timeField: 'timestamp',
      metaField: 'metadata',
      granularity: 'minutes',
    },
    autoCreate: false,
    versionKey: false,
  }
);

// Fallback index for non-time-series MongoDB versions
sensorDataSchema.index({ 'metadata.node_id': 1, timestamp: -1 });

module.exports = mongoose.model('SensorData', sensorDataSchema);
