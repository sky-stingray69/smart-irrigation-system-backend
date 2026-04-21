#include <esp_now.h>
#include <WiFi.h>
#include <ESP32Servo.h>
#include <Preferences.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const char* WIFI_SSID = "Your_SSID";
const char* WIFI_PASS = "Your_Password";
const char* API_BASE  = "http://your-api-endpoint.com/api/v1/devices";

// Master Credentials from Portal
const char* MASTER_NODE_ID = "master_01";
const char* MASTER_API_KEY = "your_secure_api_key_here";

#define PUMP_PIN        12
#define SERVO_PIN       13
#define MAX_SLAVES      10
#define MAX_QUEUE_SIZE  20
#define SYNC_INTERVAL   3600000UL   // 1 hour
#define FORCE_WATER_MS  86400000UL  // 24 h safety override

Servo       waterDirector;
Preferences prefs;

// ---------------------------------------------------------------------------
// Data Structures
// ---------------------------------------------------------------------------

struct SlaveTelemetry {
    int   slaveID;
    float humidity;
    float temperature;
    float soilMoisture;
};

struct ZoneConfig {
    int   slaveID              = -1;
    int   servoAngle           = 90;
    float moistureThreshold    = 40.0; 
} zones[MAX_SLAVES];

// CRITICAL FIX: Replaced std::queue with a thread-safe FreeRTOS queue
QueueHandle_t telemetryQueue; 

unsigned long lastShowerTime = 0;
unsigned long lastCloudSync  = 0;

// ---------------------------------------------------------------------------
// 1. NVS Persistence
// 1. NVS Persistence
// ---------------------------------------------------------------------------
void saveCache() {
    prefs.begin("irrigate", false);
    prefs.putBytes("zones",     zones,         sizeof(zones));
    prefs.putULong("lastWater", lastShowerTime);
    prefs.end();
    Serial.println(">> NVS cache saved.");
}

void loadCache() {
    prefs.begin("irrigate", false); // Open in Read/Write mode
    
    // CRITICAL FIX: Check if memory exists before reading
    if (!prefs.isKey("zones")) {
        Serial.println(">> First boot detected. Initializing NVS cache.");
        prefs.putBytes("zones", zones, sizeof(zones));
        prefs.putULong("lastWater", 0);
    } else {
        prefs.getBytes("zones", zones, sizeof(zones));
        lastShowerTime = prefs.getULong("lastWater", 0);
        Serial.println(">> NVS cache loaded.");
    }
    prefs.begin("irrigate", true);
    if (prefs.getBytes("zones", zones, sizeof(zones)) == 0) {
        Serial.println(">> No NVS cache found, using defaults.");
    }
    lastShowerTime = prefs.getULong("lastWater", 0);
    prefs.end();
}

// ---------------------------------------------------------------------------
// 2. Helper
// ---------------------------------------------------------------------------
int findZoneIndex(int slaveID) {
    for (int i = 0; i < MAX_SLAVES; i++) {
        if (zones[i].slaveID == slaveID) return i;
    }
    return -1;
}

// ---------------------------------------------------------------------------
// 3. Cloud — POST telemetry (Unified Master Auth)
// ---------------------------------------------------------------------------
void postTelemetryToCloud(const SlaveTelemetry& data) {
    if (WiFi.status() != WL_CONNECTED) return;
    char url[160];
    snprintf(url, sizeof(url), "%s/%s/telemetry", API_BASE, MASTER_NODE_ID);

    StaticJsonDocument<256> doc;
    doc["slave_id"]      = data.slaveID; // Critical for backend multi-slave support
    doc["temperature"]   = data.temperature;
    doc["humidity"]      = data.humidity;
    doc["soil_moisture"] = data.soilMoisture;
    String body;
    serializeJson(doc, body);
    HTTPClient http;
    http.begin(url);
    http.addHeader("Content-Type",  "application/json");
    http.addHeader("Authorization", String("Bearer ") + MASTER_API_KEY);
    http.setTimeout(4000);
    int code = http.POST(body);
    if (code >= 200 && code < 300)
        Serial.printf("Telemetry uploaded [Slave %d | HTTP %d]\n", data.slaveID, code);
    else
        Serial.printf("Telemetry upload failed: %s\n", http.errorToString(code).c_str());

    http.end();
}

// ---------------------------------------------------------------------------
// 4. Cloud — GET config (Parses Slaves Array)
// ---------------------------------------------------------------------------
void syncConfigFromCloud() {
    if (WiFi.status() != WL_CONNECTED) return;
    char url[160];
    snprintf(url, sizeof(url), "%s/%s/config", API_BASE, MASTER_NODE_ID);

    HTTPClient http;
    http.begin(url);
    http.addHeader("Authorization", String("Bearer ") + MASTER_API_KEY);
    http.setTimeout(5000);

    int code = http.GET();
    if (code == HTTP_CODE_OK) {
        String payload = http.getString();
        DynamicJsonDocument doc(2048); // Larger buffer for slaves array

        if (!deserializeJson(doc, payload)) {
            float masterThreshold = doc["soil_moisture_threshold"] | 40.0;
            JsonArray slavesArr = doc["slaves"].as<JsonArray>();

            // Update internal zones based on what's configured in the cloud
            int i = 0;
            for (JsonObject s : slavesArr) {
                if (i >= MAX_SLAVES) break;
                
                zones[i].slaveID = s["slave_id"] | -1;
                zones[i].servoAngle = s["angle"] | 90;
                zones[i].moistureThreshold = masterThreshold;
                i++;
            }
            
            saveCache();
            Serial.println("Config synced successfully from Cloud.");
        }
    } else {
        Serial.printf("Config sync failed: %s — using cached NVS values.\n", http.errorToString(code).c_str());
    }
    http.end();
}

// ---------------------------------------------------------------------------
// 5. Local Decision & Actuation
// ---------------------------------------------------------------------------
void executeIrrigation(const SlaveTelemetry& data) {
    int idx = findZoneIndex(data.slaveID);
    if (idx == -1) {
        Serial.printf("Slave %d not in local config — ignoring.\n", data.slaveID);
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
        postTelemetryToCloud(data);
        return;
    }

    if (override24 && !dryEnough)
        Serial.println("ACTION — 24 h safety override triggered.");
    else
        Serial.println("ACTION — soil moisture below threshold.");

    // Actuate
    waterDirector.write(angle);
    delay(800); 

    digitalWrite(PUMP_PIN, HIGH);
    delay(5000); 
    digitalWrite(PUMP_PIN, LOW);

    lastShowerTime = millis();
    saveCache();

    // Upload after actuation
    postTelemetryToCloud(data);
}

// ---------------------------------------------------------------------------
// 6. ESP-NOW callback
// ---------------------------------------------------------------------------
void OnDataRecv(const uint8_t* mac, const uint8_t* inData, int len) {
    SlaveTelemetry incoming;
    if (len == sizeof(incoming)) {
        memcpy(&incoming, inData, sizeof(incoming));
        // CRITICAL FIX: Send to queue from an Interrupt Service Routine context
        xQueueSendFromISR(telemetryQueue, &incoming, NULL);
    }
}

// ---------------------------------------------------------------------------
// Setup & Loop
// ---------------------------------------------------------------------------
void setup() {
    Serial.begin(115200);

    // Initialize the FreeRTOS queue
    telemetryQueue = xQueueCreate(MAX_QUEUE_SIZE, sizeof(SlaveTelemetry));

    pinMode(PUMP_PIN, OUTPUT);
    digitalWrite(PUMP_PIN, LOW);
    waterDirector.attach(SERVO_PIN);

    loadCache();

    WiFi.mode(WIFI_AP_STA); 
    WiFi.begin(WIFI_SSID, WIFI_PASS);
    Serial.println("Wi-Fi connecting...");

    if (esp_now_init() == ESP_OK) {
        esp_now_register_recv_cb(OnDataRecv);
    } else {
        Serial.println("ESP-NOW init failed.");
        ESP.restart();
    }

    // Initial Sync (Non-blocking-ish)
    unsigned long start = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - start < 8000) { delay(100); }
    
    if (WiFi.status() == WL_CONNECTED) {
        syncConfigFromCloud();
        lastCloudSync = millis();
    }
}

void loop() {
    // Process Telemetry
    if (!telemetryQueue.empty()) {
        SlaveTelemetry pkt = telemetryQueue.front();
        telemetryQueue.pop();
        executeIrrigation(pkt); 
    }

    // Periodic Sync
    if (millis() - lastCloudSync >= SYNC_INTERVAL) {
        syncConfigFromCloud();
        lastCloudSync = millis();
    }
}
