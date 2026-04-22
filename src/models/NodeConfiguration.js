const mongoose = require('mongoose');



const nodeConfigSchema = new mongoose.Schema(
  {
    node_id: { type: String, required: true, unique: true, trim: true },
    location_name: { type: String, required: true, trim: true },
    crop_type: { type: String, required: true, trim: true },
     coordinates: {
      lat: { type: Number, required: true, min: -90, max: 90 },
      lon: { type: Number, required: true, min: -180, max: 180 },
    },
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

nodeConfigSchema.pre('save', function() {
  // If the document is being modified, and is_active is specifically being changed
  if (this.isModified('is_active')) {
    console.log("\n🚨 TRIPWIRE TRIGGERED: Node ${this.node_id} is_active changed to ${this.is_active}!");
    console.trace("Stack trace showing what called this update:"); // This prints the exact file/function that did it
  }

});

nodeConfigSchema.pre('findOneAndUpdate', function() {
  const update = this.getUpdate();
  if (update.is_active !== undefined || (update.$set && update.$set.is_active !== undefined)) {
    console.log("\n🚨 TRIPWIRE TRIGGERED: findOneAndUpdate changing is_active!");
  }
 
});

module.exports = mongoose.model('NodeConfiguration', nodeConfigSchema);