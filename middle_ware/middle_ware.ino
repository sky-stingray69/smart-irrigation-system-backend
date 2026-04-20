#include <esp_now.h>
#include <WiFi.h>
#include <ESP32Servo.h>
#include <Preferences.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <queue>

// ---------------------------------------------------------------------------
// Configuration
// node_id and api_key come from POST /api/v1/portal/nodes (admin, one-time).
// Fill in one entry per slave below, then flash.
// ---------------------------------------------------------------------------
const char* WIFI_SSID = "Your_SSID";
const char* WIFI_PASS = "Your_Password";
const char* API_BASE  = "http://your-api-endpoint.com/api/v1/devices";

#define PUMP_PIN        12
#define SERVO_PIN       13
#define MAX_SLAVES      10
#define MAX_QUEUE_SIZE  20
#define SYNC_INTERVAL   3600000UL   // Re-fetch config from cloud every 1 hour
#define FORCE_WATER_MS  86400000UL  // 24 h safety override

Servo       waterDirector;
Preferences prefs;

// ---------------------------------------------------------------------------
// Data Structures
// ---------------------------------------------------------------------------

// Received over ESP-NOW from slave nodes.
struct SlaveTelemetry {
    int   slaveID;
    float humidity;
    float temperature;
    float soilMoisture;   // maps to "soil_moisture" in the cloud API
};

// All decision-critical fields live here and are persisted in NVS.
// The cloud only *updates* these values — it never replaces local authority.
struct ZoneConfig {
    int   slaveID              = -1;
    int   servoAngle           = 90;
    float moistureThreshold    = 40.0;  // Default until first cloud sync
    char  cloudNodeId[48]      = "";    // Registered node_id in the portal
    char  apiKey[80]           = "";    // Device API key (shown once at registration)
} zones[MAX_SLAVES];

std::queue<SlaveTelemetry> telemetryQueue;
unsigned long lastShowerTime = 0;
unsigned long lastCloudSync  = 0;

// ---------------------------------------------------------------------------
// 1. NVS Persistence — zones (thresholds + keys) and last-water timestamp
// ---------------------------------------------------------------------------
void saveCache() {
    prefs.begin("irrigate", false);
    prefs.putBytes("zones",     zones,         sizeof(zones));
    prefs.putULong("lastWater", lastShowerTime);
    prefs.end();
    Serial.println(">> NVS cache saved.");
}

void loadCache() {
    prefs.begin("irrigate", true);
    prefs.getBytes("zones",     zones,         sizeof(zones));
    lastShowerTime = prefs.getULong("lastWater", 0);
    prefs.end();
    Serial.println(">> NVS cache loaded.");
}

// ---------------------------------------------------------------------------
// 2. Helper — find zone index by slaveID
// ---------------------------------------------------------------------------
int findZoneIndex(int slaveID) {
    for (int i = 0; i < MAX_SLAVES; i++) {
        if (zones[i].slaveID == slaveID) return i;
    }
    return -1;
}

// ---------------------------------------------------------------------------
// 3. Cloud — POST telemetry (fire-and-forget, non-critical)
//    POST /api/v1/devices/:node_id/telemetry
//    Body : { temperature, humidity, soil_moisture }
//    Auth : Bearer <api_key>
//
//    A failure here is logged but never blocks irrigation.
// ---------------------------------------------------------------------------
void postTelemetryToCloud(const SlaveTelemetry& data, int zoneIdx) {
    if (WiFi.status() != WL_CONNECTED) return;

    char url[160];
    snprintf(url, sizeof(url), "%s/%s/telemetry", API_BASE, zones[zoneIdx].cloudNodeId);

    StaticJsonDocument<128> doc;
    doc["temperature"]   = data.temperature;
    doc["humidity"]      = data.humidity;
    doc["soil_moisture"] = data.soilMoisture;

    String body;
    serializeJson(doc, body);

    HTTPClient http;
    http.begin(url);
    http.addHeader("Content-Type",  "application/json");
    http.addHeader("Authorization", String("Bearer ") + zones[zoneIdx].apiKey);
    http.setTimeout(4000);

    int code = http.POST(body);
    if (code >= 200 && code < 300)
        Serial.printf("Telemetry uploaded  [%s | HTTP %d]\n", zones[zoneIdx].cloudNodeId, code);
    else
        Serial.printf("Telemetry upload failed [%s]: %s\n",
                      zones[zoneIdx].cloudNodeId, http.errorToString(code).c_str());

    http.end();
}

// ---------------------------------------------------------------------------
// 4. Cloud — GET config (periodic, updates local thresholds)
//    GET /api/v1/devices/:node_id/config
//    Auth: Bearer <api_key>
//
//    Response: { node_id, soil_moisture_threshold, servo_angle }
//
//    If the cloud is unreachable the existing NVS values are kept —
//    the device continues operating on its last known good config.
// ---------------------------------------------------------------------------
void syncConfigFromCloud(int zoneIdx) {
    if (WiFi.status() != WL_CONNECTED) return;

    char url[160];
    snprintf(url, sizeof(url), "%s/%s/config", API_BASE, zones[zoneIdx].cloudNodeId);

    HTTPClient http;
    http.begin(url);
    http.addHeader("Authorization", String("Bearer ") + zones[zoneIdx].apiKey);
    http.setTimeout(4000);

    int code = http.GET();
    if (code == HTTP_CODE_OK) {
        String payload = http.getString();
        StaticJsonDocument<128> doc;

        if (!deserializeJson(doc, payload)) {
            float newThreshold = doc["soil_moisture_threshold"] | zones[zoneIdx].moistureThreshold;
            int   newAngle     = doc["servo_angle"]             | zones[zoneIdx].servoAngle;

            zones[zoneIdx].moistureThreshold = newThreshold;
            zones[zoneIdx].servoAngle        = newAngle;

            Serial.printf("Config synced [%s]: threshold=%.1f%% angle=%d°\n",
                          zones[zoneIdx].cloudNodeId, newThreshold, newAngle);
        }
    } else {
        Serial.printf("Config sync failed [%s]: %s — using cached values.\n",
                      zones[zoneIdx].cloudNodeId, http.errorToString(code).c_str());
    }
    http.end();
}

void syncAllZoneConfigs() {
    for (int i = 0; i < MAX_SLAVES; i++) {
        if (zones[i].slaveID != -1 && strlen(zones[i].cloudNodeId) > 0) {
            syncConfigFromCloud(i);
        }
    }
    saveCache();   // Persist any updated thresholds to NVS
}

// ---------------------------------------------------------------------------
// 5. Local Decision & Actuation
//
//    Decision is made entirely on-device using the cached threshold.
//    Cloud telemetry upload happens after actuation — a cloud failure
//    never blocks watering.
//
//    Override rules (in priority order):
//      1. soil_moisture < threshold          → water (normal path)
//      2. 24 h elapsed since last watering   → force water regardless (safety)
//      3. soil_moisture >= threshold         → standby
// ---------------------------------------------------------------------------
void executeIrrigation(const SlaveTelemetry& data) {
    int idx = findZoneIndex(data.slaveID);
    if (idx == -1) {
        Serial.printf("Slave %d has no zone config — ignoring.\n", data.slaveID);
        return;
    }

    float threshold  = zones[idx].moistureThreshold;
    int   angle      = zones[idx].servoAngle;
    bool  dryEnough  = (data.soilMoisture < threshold);
    bool  override24 = (millis() - lastShowerTime > FORCE_WATER_MS);

    Serial.printf("Slave %d | moisture=%.1f%% | threshold=%.1f%% | 24h_override=%s\n",
                  data.slaveID, data.soilMoisture, threshold, override24 ? "YES" : "no");

    if (!dryEnough && !override24) {
        Serial.println("STANDBY — soil adequately moist.");
        // Still upload telemetry so the portal sees current readings
        postTelemetryToCloud(data, idx);
        return;
    }

    if (override24 && !dryEnough)
        Serial.println("ACTION  — 24 h safety override triggered.");
    else
        Serial.println("ACTION  — soil moisture below threshold.");

    // --- Actuate ---
    waterDirector.write(angle);
    delay(500);                        // Servo settle

    digitalWrite(PUMP_PIN, HIGH);
    delay(5000);                       // 5-second burst (fixed local duration)
    digitalWrite(PUMP_PIN, LOW);

    lastShowerTime = millis();
    saveCache();

    // Upload telemetry after watering (non-blocking on failure)
    postTelemetryToCloud(data, idx);
}

// ---------------------------------------------------------------------------
// 6. ESP-NOW callback — ISR context, enqueue only
// ---------------------------------------------------------------------------
void OnDataRecv(const uint8_t* mac, const uint8_t* inData, int len) {
    SlaveTelemetry incoming;
    if (len == sizeof(incoming)) {
        memcpy(&incoming, inData, sizeof(incoming));
        if (telemetryQueue.size() < MAX_QUEUE_SIZE)
            telemetryQueue.push(incoming);
    }
}

// ---------------------------------------------------------------------------
// 7. Setup & Loop
// ---------------------------------------------------------------------------
void setup() {
    Serial.begin(115200);

    pinMode(PUMP_PIN, OUTPUT);
    digitalWrite(PUMP_PIN, LOW);
    waterDirector.attach(SERVO_PIN);

    // Load last known config from NVS — device is operational immediately
    // even before Wi-Fi connects
    loadCache();

    WiFi.mode(WIFI_AP_STA);   // AP keeps ESP-NOW slaves reachable; STA for internet
    WiFi.begin(WIFI_SSID, WIFI_PASS);
    Serial.println("Wi-Fi connecting (non-blocking)...");

    if (esp_now_init() == ESP_OK) {
        Serial.println("ESP-NOW ready.");
        esp_now_register_recv_cb(OnDataRecv);
    } else {
        Serial.println("ESP-NOW init failed — restarting.");
        ESP.restart();
    }

    // Attempt first config sync; if Wi-Fi isn't up yet, NVS values are used
    if (WiFi.waitForConnectResult(5000) == WL_CONNECTED) {
        Serial.println("Wi-Fi connected — performing initial config sync.");
        syncAllZoneConfigs();
        lastCloudSync = millis();
    } else {
        Serial.println("Wi-Fi not ready — using cached config.");
    }
}

void loop() {
    // A. Process one queued telemetry packet per iteration
    if (!telemetryQueue.empty()) {
        SlaveTelemetry pkt = telemetryQueue.front();
        telemetryQueue.pop();
        executeIrrigation(pkt);   // Decide locally, upload opportunistically
    }

    // B. Periodic config pull from cloud (updates thresholds + servo angles)
    if (millis() - lastCloudSync >= SYNC_INTERVAL) {
        syncAllZoneConfigs();
        lastCloudSync = millis();
    }

    delay(1);
}