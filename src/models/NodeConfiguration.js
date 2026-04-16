const mongoose = require('mongoose');

const nodeConfigSchema = new mongoose.Schema(
  {
    node_id: { type: String, required: true, unique: true, trim: true },
    location_name: { type: String, required: true, trim: true },
    crop_type: { type: String, required: true, trim: true },
    moisture_threshold_percent: {
      type: Number,
      required: true,
      min: 0,
      max: 100,
      default: 40,
    },
    irrigation_rate_liters_per_min: {
      type: Number,
      required: true,
      min: 0,
      default: 5.0,
    },
    coordinates: {
      lat: { type: Number, required: true, min: -90, max: 90 },
      lon: { type: Number, required: true, min: -180, max: 180 },
    },
    api_key_hash: { type: String, required: true },
    is_active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('NodeConfiguration', nodeConfigSchema);
