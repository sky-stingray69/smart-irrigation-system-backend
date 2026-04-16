# Smart Cloud Irrigation API

A cloud-side RESTful API for an IoT-based smart irrigation system. Receives telemetry from ESP32 field nodes, integrates with weather forecasting, and uses a decision engine to determine optimal irrigation schedules.

## Tech Stack

- **Runtime:** Node.js (Express)
- **Database:** MongoDB (Time Series collections)
- **Auth:** JWT (web portal) + bcrypt-hashed API keys (ESP32 devices)
- **Weather:** OpenWeatherMap API (with in-memory cache)

## Project Structure

```
src/
├── app.js                   # Entry point
├── config/
│   └── database.js          # MongoDB connection
├── middleware/
│   ├── auth.js              # JWT & device API key authentication
│   └── rateLimiter.js       # Rate limiting for device & portal routes
├── models/
│   ├── SensorData.js        # Time series telemetry model
│   ├── NodeConfiguration.js # ESP32 node config model
│   └── User.js              # Web portal user model
├── routes/
│   ├── auth.js              # /api/v1/auth — Login, register
│   ├── devices.js           # /api/v1/devices — ESP32 endpoints
│   └── portal.js            # /api/v1/portal — Web portal endpoints
└── services/
    ├── decisionEngine.js    # Core irrigation decision logic
    └── weatherService.js    # Weather API + caching
tests/
└── decisionEngine.test.js   # Unit tests for the decision engine
```

## Setup

### 1. Prerequisites

- Node.js 18+
- MongoDB 6.0+ (for Time Series collection support)

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your settings:

| Variable | Description |
|---|---|
| `MONGO_URI` | MongoDB connection string |
| `JWT_SECRET` | Strong secret for signing JWTs |
| `WEATHER_API_KEY` | OpenWeatherMap API key |
| `PORT` | Server port (default: 3000) |

### 4. Run

```bash
# Development (auto-reload)
npm run dev

# Production
npm start
```

### 5. Run Tests

```bash
npm test
```

---

## API Reference

### Auth Endpoints

| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| POST | `/api/v1/auth/register` | Register new portal user | None |
| POST | `/api/v1/auth/login` | Login, receive JWT | None |
| GET  | `/api/v1/auth/me` | Get current user | JWT |

### Device Endpoints (ESP32)

All device endpoints require `Authorization: Bearer <device_api_key>`.

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/devices/:node_id/telemetry` | Push sensor readings |
| GET  | `/api/v1/devices/:node_id/action`    | Poll for irrigation command |

**Telemetry Payload:**
```json
{ "temperature": 32.5, "humidity": 45.0, "soil_moisture": 30.0 }
```

**Action Response:**
```json
{ "action": "SPRINKLE", "duration_seconds": 192, "water_volume_liters": 16.0, "reason": "..." }
```
or
```json
{ "action": "STANDBY", "duration_seconds": 0, "water_volume_liters": 0, "reason": "..." }
```

### Web Portal Endpoints

All portal endpoints require `Authorization: Bearer <jwt_token>`. Write operations (POST, PUT, DELETE) require `admin` role.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET    | `/api/v1/portal/sensors` | Fetch historical sensor data (`?node_id=&start_time=&end_time=`) |
| GET    | `/api/v1/portal/nodes` | List all nodes |
| GET    | `/api/v1/portal/nodes/:node_id` | Get single node config |
| POST   | `/api/v1/portal/nodes` | Register new node (returns one-time API key) |
| PUT    | `/api/v1/portal/nodes/:node_id` | Update node config |
| DELETE | `/api/v1/portal/nodes/:node_id` | Deactivate a node |
| GET    | `/api/v1/portal/system/status` | System health overview |

---

## Decision Engine Logic

When an ESP32 calls `/action`, the cloud runs this sequence:

1. Fetch the latest `soil_moisture` reading for the node.
2. If moisture **≥ threshold** → `STANDBY` (soil is adequately wet).
3. If moisture **< threshold**, call weather API for next 2-hour rainfall forecast.
4. If predicted rain **≥ 5mm** → `STANDBY` (nature will water the crop).
5. Otherwise, calculate water deficit → return `SPRINKLE` with pump duration.

## Security Notes

- **Device API keys** are generated at node registration, shown once, and stored as bcrypt hashes.
- **Passwords** are bcrypt-hashed (cost factor 12).
- Rate limiting protects device endpoints from malfunctioning nodes (30 req/min per node).
- Weather API responses are cached for 20 minutes to prevent quota exhaustion.