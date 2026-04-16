const axios = require('axios');
const NodeCache = require('node-cache');

// Cache weather responses for 15–20 minutes to avoid burning API quota
const weatherCache = new NodeCache({
  stdTTL: parseInt(process.env.WEATHER_CACHE_TTL_SECONDS) || 1200,
  checkperiod: 60,
});

/**
 * Fetches predicted rainfall (mm) for the next N hours at given coordinates.
 * Results are cached by rounded lat/lon to benefit nearby nodes.
 *
 * @param {number} lat  Latitude
 * @param {number} lon  Longitude
 * @param {number} hours  Forecast window in hours (default: 2)
 * @returns {Promise<number>} Total predicted rainfall in mm
 */
const getPredictedRainfall = async (lat, lon, hours = 2) => {
  // Round to 2 decimal places so nearby nodes share cache entries
  const cacheKey = `rain_${lat.toFixed(2)}_${lon.toFixed(2)}_${hours}h`;
  const cached = weatherCache.get(cacheKey);
  if (cached !== undefined) {
    console.log(`🌦  Weather cache HIT for key: ${cacheKey}`);
    return cached;
  }

  const apiKey = process.env.WEATHER_API_KEY;
  if (!apiKey) {
    console.warn('⚠️  WEATHER_API_KEY not set. Defaulting rainfall to 0mm.');
    return 0;
  }

  try {
    const url = `${process.env.WEATHER_API_URL}/forecast`;
    const { data } = await axios.get(url, {
      params: { lat, lon, appid: apiKey, units: 'metric', cnt: hours },
      timeout: 5000,
    });

    // OpenWeatherMap returns rain.3h (mm per 3h window) per forecast entry
    const totalRainMm = (data.list || []).reduce((sum, entry) => {
      return sum + (entry.rain?.['3h'] || 0);
    }, 0);

    console.log(`🌦  Weather API MISS — ${lat},${lon}: ${totalRainMm.toFixed(2)}mm predicted`);
    weatherCache.set(cacheKey, totalRainMm);
    return totalRainMm;
  } catch (err) {
    console.error(`❌ Weather API error: ${err.message}. Defaulting to 0mm.`);
    return 0; // Fail safe: irrigate if weather data unavailable
  }
};

const getCacheStats = () => weatherCache.getStats();

module.exports = { getPredictedRainfall, getCacheStats };
