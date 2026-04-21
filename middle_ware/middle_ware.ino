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

#define PUMP_PIN        12
#define SERVO_PIN       13
#define MAX_SLAVES      10
#define MAX_QUEUE_SIZE  20
#define SYNC_INTERVAL   3600000UL   
#define FORCE_WATER_MS  86400000UL  

Servo       waterDirector;
Preferences prefs;

// ---------------------------------------------------------------------------
// Data Structures
// ---------------------------------------------------------------------------

// CRITICAL FIX: This struct must be identical on both Master and Slave
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
    char  cloudNodeId[48]      = "";    
    char  apiKey[80]           = "";    
} zones[MAX_SLAVES];

// CRITICAL FIX: Replaced std::queue with a thread-safe FreeRTOS queue
QueueHandle_t telemetryQueue; 

unsigned long lastShowerTime = 0;
unsigned long lastCloudSync  = 0;

// ---------------------------------------------------------------------------
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
    prefs.end();
}

int findZoneIndex(int slaveID) {
    for (int i = 0; i < MAX_SLAVES; i++) {
        if (zones[i].slaveID == slaveID) return i;
    }
    return -1;
}

// ---------------------------------------------------------------------------
// Cloud Functions (Unchanged)
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
    if (code >= 200 && code < 300) Serial.printf("Telemetry uploaded  [%s]\n", zones[zoneIdx].cloudNodeId);
    else Serial.printf("Telemetry upload failed [%s]\n", zones[zoneIdx].cloudNodeId);
    http.end();
}

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
            zones[zoneIdx].moistureThreshold = doc["soil_moisture_threshold"] | zones[zoneIdx].moistureThreshold;
            zones[zoneIdx].servoAngle        = doc["servo_angle"]             | zones[zoneIdx].servoAngle;
        }
    }
    http.end();
}

void syncAllZoneConfigs() {
    for (int i = 0; i < MAX_SLAVES; i++) {
        if (zones[i].slaveID != -1 && strlen(zones[i].cloudNodeId) > 0) syncConfigFromCloud(i);
    }
    saveCache();
}

// ---------------------------------------------------------------------------
// Actuation
// ---------------------------------------------------------------------------
void executeIrrigation(const SlaveTelemetry& data) {
    int idx = findZoneIndex(data.slaveID);
    if (idx == -1) return;

    float threshold  = zones[idx].moistureThreshold;
    int   angle      = zones[idx].servoAngle;
    bool  dryEnough  = (data.soilMoisture < threshold);
    bool  override24 = (millis() - lastShowerTime > FORCE_WATER_MS);

    if (!dryEnough && !override24) {
        postTelemetryToCloud(data, idx);
        return;
    }

    waterDirector.write(angle);
    delay(500);                        
    digitalWrite(PUMP_PIN, HIGH);
    
    // Because we are using FreeRTOS queues, this 5-second delay is now safe!
    // Incoming ESP-NOW messages will queue up in the background.
    delay(5000);                       
    digitalWrite(PUMP_PIN, LOW);

    lastShowerTime = millis();
    saveCache();
    postTelemetryToCloud(data, idx);
}

// ---------------------------------------------------------------------------
// ESP-NOW Callback
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

    if (esp_now_init() == ESP_OK) {
        esp_now_register_recv_cb(OnDataRecv);
    } else {
        ESP.restart();
    }

    if (WiFi.waitForConnectResult(5000) == WL_CONNECTED) {
        syncAllZoneConfigs();
        lastCloudSync = millis();
    }
}

void loop() {
    SlaveTelemetry pkt;
    // CRITICAL FIX: Pull from FreeRTOS queue (non-blocking)
    if (xQueueReceive(telemetryQueue, &pkt, 0) == pdTRUE) {
        executeIrrigation(pkt);   
    }

    if (millis() - lastCloudSync >= SYNC_INTERVAL) {
        syncAllZoneConfigs();
        lastCloudSync = millis();
    }
}
