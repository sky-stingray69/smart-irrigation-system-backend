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
    api_key_hash: { type: String, required: true },
    is_active: { type: Boolean, default: true },
    
    // ─── Slave Configuration ─────────────────────────────────────
    // Array of embedded slave devices under this master node
    slaves: [
      {
        slave_id: { 
          type: String, 
          required: true, 
          trim: true 
        },
        angle: { 
          type: Number, 
          required: true, 
          min: 0, 
          max: 180 
        },
      },
    ],
  },
  { timestamps: true }
);

module.exports = mongoose.model('NodeConfiguration', nodeConfigSchema);