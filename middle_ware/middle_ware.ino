#include <esp_now.h>
#include <WiFi.h>
#include <esp_wifi.h> // Added to control Wi-Fi radio power states
#include <ESP32Servo.h>
#include <Preferences.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const char* WIFI_SSID = "Meow"; 
const char* WIFI_PASS = "nigga1234";

const char* API_BASE  = "http://10.241.255.121:5000/api/v1/devices"; 

const char* MASTER_NODE_ID = "8";
const char* MASTER_API_KEY = "a0419561cbd1f16bc22278d21f2997c4beee65a227e9235a520fd4aae1f7f673";

#define SERVO_PIN       13
#define MAX_SLAVES      10
#define MAX_QUEUE_SIZE  20
#define SYNC_INTERVAL   3600000UL   
#define FORCE_WATER_MS  86400000UL  

Servo       waterDirector;
Preferences prefs;

struct SlaveTelemetry {
    int   slaveID;
    float humidity, temperature, soilMoisture;
};

struct ZoneConfig {
    int   slaveID              = -1;
    int   servoAngle           = 90;
    float moistureThreshold    = 40.0; 
} zones[MAX_SLAVES];

QueueHandle_t telemetryQueue; 
unsigned long lastShowerTime = 0;
unsigned long lastCloudSync  = 0;
int currentServoAngle        = 90; 

float globalPredictedRain = 0.0;

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------
void moveServoSlowly(int targetAngle) {
    targetAngle = constrain(targetAngle, 0, 180);
    Serial.printf("[SERVO] Initiating movement from %d° to %d°...\n", currentServoAngle, targetAngle);
    
    while (currentServoAngle != targetAngle) {
        if (currentServoAngle < targetAngle) {
            currentServoAngle++;
        } else {
            currentServoAngle--;
        }
        waterDirector.write(currentServoAngle);
        delay(50); 
    }
    Serial.printf("[SERVO] Reached target angle: %d°\n", currentServoAngle);
}

void saveCache() {
    Serial.println("[NVS] Attempting to save cache...");
    prefs.begin("irrigate", false);
    prefs.putBytes("zones", zones, sizeof(zones));
    prefs.putULong("lastWater", lastShowerTime);
    prefs.end();
    Serial.println("[NVS] Cache saved successfully.");
}

void loadCache() {
    Serial.println("[NVS] Checking for existing cache...");
    prefs.begin("irrigate", false);
    if (!prefs.isKey("zones")) {
        Serial.println("[NVS] No existing cache found. Initializing defaults.");
        prefs.putBytes("zones", zones, sizeof(zones));
        prefs.putULong("lastWater", 0);
    } else {
        prefs.getBytes("zones", zones, sizeof(zones));
        lastShowerTime = prefs.getULong("lastWater", 0);
        Serial.println("[NVS] Existing cache loaded successfully.");
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
// Cloud Sync Function
// ---------------------------------------------------------------------------
void postTelemetryToCloud(const SlaveTelemetry& data) {
    if (WiFi.status() != WL_CONNECTED) return;
    char url[160];
    snprintf(url, sizeof(url), "%s/%s/telemetry", API_BASE, MASTER_NODE_ID);

    StaticJsonDocument<256> doc;
    doc["slave_id"]      = data.slaveID; 
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
        Serial.printf("[HTTP] Telemetry uploaded [Slave %d | HTTP %d]\n", data.slaveID, code);
    else
        Serial.printf("[HTTP] Telemetry upload failed: %s\n", http.errorToString(code).c_str());

    http.end();
}

void fetchConfigFromServer() {
    if (WiFi.status() != WL_CONNECTED) {
        Serial.println("[HTTP] Cannot fetch config. WiFi not connected.");
        return;
    }

    HTTPClient http;
    String url = String(API_BASE) + "/" + String(MASTER_NODE_ID) + "/config";
    Serial.printf("\n[HTTP] GET Request to: %s\n", url.c_str());

    http.begin(url);
    http.addHeader("Authorization", String("Bearer ") + MASTER_API_KEY); 

    int httpCode = http.GET();

    if (httpCode > 0) {
        Serial.printf("[HTTP] Response Code: %d\n", httpCode);
        
        if (httpCode == HTTP_CODE_OK || httpCode == HTTP_CODE_CREATED) {
            String payload = http.getString();
            
            JsonDocument doc; 
            DeserializationError error = deserializeJson(doc, payload);

            if (error) {
                Serial.printf("[JSON] Deserialization failed: %s\n", error.c_str());
                http.end();
                return;
            }

            float threshold = doc["soil_moisture_threshold"] | 40.0;
            globalPredictedRain = doc["predicted_rain"] | 0.0;
            
            Serial.printf("[CONFIG] Global Threshold: %.1f%%\n", threshold);
            Serial.printf("[CONFIG] Predicted Rain: %.1f mm\n", globalPredictedRain);

            JsonArray slavesArray = doc["slaves"].as<JsonArray>();
            Serial.printf("[CONFIG] Processing %d slaves from config.\n", slavesArray.size());
            
            for (JsonObject slaveObj : slavesArray) {
                int slaveId = slaveObj["slave_id"];
                int servoAngle = slaveObj["servo_angle"]; 
                
                int idx = findZoneIndex(slaveId);
                
                if (idx == -1) {
                    for (int i = 0; i < MAX_SLAVES; i++) {
                        if (zones[i].slaveID == -1) {
                            idx = i;
                            break;
                        }
                    }
                }
                
                if (idx != -1) {
                    zones[idx].slaveID = slaveId;
                    zones[idx].servoAngle = servoAngle;
                    zones[idx].moistureThreshold = threshold;
                    Serial.printf("   -> [ZONE UPDATE] Slot %d | Slave %d | Angle %d° | Thresh %.1f%%\n", 
                                  idx, slaveId, servoAngle, threshold);
                } else {
                    Serial.println("   -> [WARNING] Zone array is full! Cannot add new slave.");
                }
            }
            saveCache(); 
        } else {
            Serial.printf("[HTTP] Failed payload: %s\n", http.getString().c_str());
        }
    } else {
        Serial.printf("[HTTP] Request failed, error: %s\n", http.errorToString(httpCode).c_str());
    }
    http.end();
}

// ---------------------------------------------------------------------------
// Radio Callback
// ---------------------------------------------------------------------------
void OnDataRecv(const esp_now_recv_info_t * info, const uint8_t * inData, int len) {
    SlaveTelemetry incoming;
    if (len == sizeof(incoming)) {
        memcpy(&incoming, inData, sizeof(incoming));
        xQueueSendFromISR(telemetryQueue, &incoming, NULL);
    }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
void setup() {
    Serial.begin(115200);
    delay(1000);
    Serial.println("\n=================================");
    Serial.println("--- MASTER NODE INITIALIZING ---");
    Serial.println("=================================");

    Serial.println("[WIFI] Setting up WiFi as AP_STA...");
    WiFi.mode(WIFI_AP_STA); 

    // CRITICAL FIX: Disable Wi-Fi power saving so it doesn't miss ESP-NOW packets
    esp_wifi_set_ps(WIFI_PS_NONE);

    Serial.println("[SYSTEM] Creating telemetry queue...");
    telemetryQueue = xQueueCreate(MAX_QUEUE_SIZE, sizeof(SlaveTelemetry));

    Serial.println("[DIAG] Attaching servo to Pin 13...");
    waterDirector.setPeriodHertz(50);
    waterDirector.attach(SERVO_PIN, 500, 2400); 
    
    waterDirector.write(currentServoAngle); 
    delay(1000);
    
    Serial.println("[DIAG] Sweeping servo to 0°...");
    moveServoSlowly(0);
    delay(1000);
    
    Serial.println("[DIAG] Sweeping servo back to 90°...");
    moveServoSlowly(90);
    Serial.println("[DIAG] Servo test finished.");

    loadCache();

    Serial.printf("[WIFI] Attempting connection to SSID: %s\n", WIFI_SSID);
    WiFi.begin(WIFI_SSID, WIFI_PASS);
    
    unsigned long start = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - start < 10000) { 
        Serial.print(".");
        delay(500); 
    }
    
    if (WiFi.status() == WL_CONNECTED) {
        Serial.print("\n[WIFI] Connected! IP Address: ");
        Serial.println(WiFi.localIP());
        Serial.print("[WIFI] Master MAC Address: ");
        Serial.println(WiFi.macAddress());
        Serial.printf("[WIFI] Operating on Channel: %d\n", WiFi.channel()); // READ THIS VALUE
        
        fetchConfigFromServer();
        lastCloudSync = millis();
    } else {
        Serial.println("\n[WIFI] WARNING: Connection timed out. Running without router connection.");
    }

    Serial.println("[ESPNOW] Initializing ESP-NOW...");
    if (esp_now_init() == ESP_OK) {
        Serial.println("[ESPNOW] Init successful. Registering callback.");
        esp_now_register_recv_cb(OnDataRecv);
    } else {
        Serial.println("[ESPNOW] FATAL ERROR: Init failed. Restarting ESP32...");
        delay(3000);
        ESP.restart();
    }

    Serial.println("--- MASTER SETUP COMPLETE ---");
}

// ---------------------------------------------------------------------------
// Main Loop
// ---------------------------------------------------------------------------
void loop() {
    SlaveTelemetry pkt;
    
    if (xQueueReceive(telemetryQueue, &pkt, 0) == pdTRUE) {
        Serial.println("\n[DATA RECV] ---------------------");
        Serial.printf("   Slave ID : %d\n", pkt.slaveID);
        Serial.printf("   Temp     : %.2f C\n", pkt.temperature);
        Serial.printf("   Humidity : %.2f %%\n", pkt.humidity);
        Serial.printf("   Moisture : %.2f %%\n", pkt.soilMoisture);
        Serial.println("---------------------------------");

        // Post the received data directly to your Express backend
        postTelemetryToCloud(pkt);
    }

    if (WiFi.status() == WL_CONNECTED && millis() - lastCloudSync > SYNC_INTERVAL) {
        Serial.println("\n[SYSTEM] Initiating scheduled cloud sync...");
        fetchConfigFromServer();
        lastCloudSync = millis();
    }
}
