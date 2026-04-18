#include <esp_now.h>
#include <WiFi.h>
#include <ESP32Servo.h>
#include <Preferences.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <queue> 

// --- Configuration ---
const char* WIFI_SSID = "Your_SSID";
const char* WIFI_PASS = "Your_Password";
const char* CLOUD_URL = "http://your-api-endpoint.com/config";
const char* POST_URL  = "http://your-api-endpoint.com/telemetry";

#define PUMP_PIN 12
#define SERVO_PIN 13
#define MAX_SLAVES 10
#define MAX_QUEUE_SIZE 20 // Safety limit for pending cloud uploads

Servo waterDirector;
Preferences prefs;

// --- Data Structures ---
struct SlaveTelemetry {
    int slaveID;
    float humidity;
    float temperature;
    float waterFlow;
};

struct GlobalConfig {
    float waterThreshold = 30.0;
    bool rainExpected = false;
} systemSettings;

struct ZoneConfig {
    int slaveID = -1;
    int servoAngle = 90;
} zones[MAX_SLAVES];

// Shared resources
std::queue<SlaveTelemetry> telemetryQueue;
unsigned long lastCloudSync = 0;
const long SYNC_INTERVAL = 3600000; // 1 Hour
unsigned long lastShowerTime = 0;

// --- 1. Persistence Logic ---
void saveCache() {
    prefs.begin("irrigate", false);
    prefs.putBytes("settings", &systemSettings, sizeof(systemSettings));
    prefs.putBytes("zones", zones, sizeof(zones));
    prefs.putULong("lastWater", lastShowerTime);
    prefs.end();
    Serial.println(">> Local Cache Updated to NVS.");
}

void loadCache() {
    prefs.begin("irrigate", true);
    prefs.getBytes("settings", &systemSettings, sizeof(systemSettings));
    prefs.getBytes("zones", zones, sizeof(zones));
    lastShowerTime = prefs.getULong("lastWater", 0);
    prefs.end();
    Serial.println(">> Cache Loaded from NVS.");
}

// --- 2. Actuation Logic ---
void executeIrrigation(SlaveTelemetry data) {
    int targetAngle = -1;
    for (int i = 0; i < MAX_SLAVES; i++) {
        if (zones[i].slaveID == data.slaveID) {
            targetAngle = zones[i].servoAngle;
            break;
        }
    }

    if (targetAngle == -1) return;

    bool needsWater = (data.humidity < systemSettings.waterThreshold);
    bool forceWater = (millis() - lastShowerTime > 86400000); // 24hr safety override

    if (needsWater && (!systemSettings.rainExpected || forceWater)) {
        Serial.printf("Action: Watering Zone (Slave %d) at %d degrees\n", data.slaveID, targetAngle);
        waterDirector.write(targetAngle);
        delay(500); 
        digitalWrite(PUMP_PIN, HIGH);
        delay(5000); // Water for 5 seconds
        digitalWrite(PUMP_PIN, LOW);
        
        lastShowerTime = millis();
        saveCache();
    }
}

// --- 3. Cloud Sync ---
void postTelemetryToCloud(SlaveTelemetry data) {
    if (WiFi.status() != WL_CONNECTED) return;

    HTTPClient http;
    http.begin(POST_URL);
    http.addHeader("Content-Type", "application/json");

    StaticJsonDocument<200> doc;
    doc["id"] = data.slaveID;
    doc["hum"] = data.humidity;
    doc["temp"] = data.temperature;
    doc["flow"] = data.waterFlow;

    String requestBody;
    serializeJson(doc, requestBody);
    int httpResponseCode = http.POST(requestBody);
    
    if(httpResponseCode > 0) {
        Serial.printf("Cloud Log Success: %d\n", httpResponseCode);
    } else {
        Serial.printf("Cloud Log Failed: %s\n", http.errorToString(httpResponseCode).c_str());
    }
    http.end();
}

void syncSettingsWithCloud() {
    if (WiFi.status() != WL_CONNECTED) return;

    HTTPClient http;
    http.begin(CLOUD_URL);
    int httpCode = http.GET();

    if (httpCode == HTTP_CODE_OK) {
        String payload = http.getString();
        DynamicJsonDocument doc(2048);
        deserializeJson(doc, payload);

        systemSettings.waterThreshold = doc["threshold"];
        systemSettings.rainExpected = doc["willRain"];

        JsonArray slaves = doc["slaves"].as<JsonArray>();
        int i = 0;
        for (JsonObject slave : slaves) {
            if (i < MAX_SLAVES) {
                zones[i].slaveID = slave["id"];
                zones[i].servoAngle = slave["angle"];
                i++;
            }
        }
        saveCache();
        Serial.println(">> System settings synced with Cloud.");
    }
    http.end();
}

// --- 4. ESP-NOW Callback ---
// This function runs on an interrupt. It must be very fast.
void OnDataRecv(const uint8_t * mac, const uint8_t *data, int len) {
    SlaveTelemetry tempIncoming;
    if (len == sizeof(tempIncoming)) {
        memcpy(&tempIncoming, data, sizeof(tempIncoming));
        
        // Push to queue for processing in the loop()
        if (telemetryQueue.size() < MAX_QUEUE_SIZE) {
            telemetryQueue.push(tempIncoming);
        }
    }
}

// --- 5. Main Setup & Loop ---
void setup() {
    Serial.begin(115200);
    
    pinMode(PUMP_PIN, OUTPUT);
    digitalWrite(PUMP_PIN, LOW);
    waterDirector.attach(SERVO_PIN);
    
    loadCache(); 

    // Hybrid Mode: Access Point (for ESP-NOW) + Station (for Internet)
    WiFi.mode(WIFI_AP_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASS);
    Serial.print("Connecting to Wi-Fi...");
    
    // Non-blocking Wi-Fi check: We proceed even if Wi-Fi isn't ready yet
    // ESP-NOW will still work locally.

    if (esp_now_init() == ESP_OK) {
        Serial.println("ESP-NOW Initialized.");
        esp_now_register_recv_cb(OnDataRecv);
    } else {
        Serial.println("ESP-NOW Init Failed. Restarting...");
        ESP.restart();
    }
}

void loop() {
    // A. Process the queue (Handles multiple slave packets in order)
    if (!telemetryQueue.empty()) {
        SlaveTelemetry dataToProcess = telemetryQueue.front();
        
        // 1. Act locally (High priority)
        executeIrrigation(dataToProcess); 
        
        // 2. Upload to cloud (Low priority, might be slow)
        postTelemetryToCloud(dataToProcess); 
        
        telemetryQueue.pop(); 
    }

    // B. Periodic Cloud Sync for new configuration
    if (millis() - lastCloudSync >= SYNC_INTERVAL) {
        syncSettingsWithCloud();
        lastCloudSync = millis();
    }

    // Small delay to prevent CPU watchdog triggers
    delay(1); 
}