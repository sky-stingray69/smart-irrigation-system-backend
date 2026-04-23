#include <esp_now.h>
#include <WiFi.h>
#include <esp_wifi.h> 
#include <ESP32Servo.h>
#include <Preferences.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

// ---------------------------------------------------------------------------
// TIMING CONTROLS (Easily change these values)
// ---------------------------------------------------------------------------
#define BOUNCER_BLACKLIST_MS 30000 // (30s) Drops packets from slaves heard recently
#define WATERING_TIME_MS     2000  // (2s) How long the servo unpinches the pipe
#define SYNC_INTERVAL_MS     30000 // (30s) How often to fetch rules from the database

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
unsigned long lastCloudSync  = 0;

// THE BLACKLIST: Tracks the last time each slave was allowed into the queue
unsigned long lastQueuedTime[MAX_SLAVES + 1] = {0}; 

int currentServoAngle        = 0; 
float globalPredictedRain    = 0.0;

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------
void moveServoSlowly(int targetAngle) {
    targetAngle = constrain(targetAngle, 0, 180);
    Serial.printf("[SERVO] Moving from %d° to %d°...\n", currentServoAngle, targetAngle);
    
    while (currentServoAngle != targetAngle) {
        if (currentServoAngle < targetAngle) {
            currentServoAngle++;
        } else {
            currentServoAngle--;
        }
        waterDirector.write(currentServoAngle);
        delay(15); 
    }
}

void saveCache() {
    Serial.println("[NVS] Saving zone rules to memory...");
    prefs.begin("irrigate", false);
    prefs.putBytes("zones", zones, sizeof(zones));
    prefs.end();
}

void loadCache() {
    Serial.println("[NVS] Loading zone rules from memory...");
    prefs.begin("irrigate", false);
    if (!prefs.isKey("zones")) {
        prefs.putBytes("zones", zones, sizeof(zones));
    } else {
        prefs.getBytes("zones", zones, sizeof(zones));
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
// Cloud Sync Functions
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
    if (WiFi.status() != WL_CONNECTED) return;

    HTTPClient http;
    String url = String(API_BASE) + "/" + String(MASTER_NODE_ID) + "/config";
    Serial.printf("\n[HTTP] Fetching config from: %s\n", url.c_str());

    http.begin(url);
    http.addHeader("Authorization", String("Bearer ") + MASTER_API_KEY); 

    int httpCode = http.GET();

    if (httpCode > 0) {
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
            
            Serial.printf("[CONFIG] Global Threshold: %.1f%% | Predicted Rain: %.1f mm\n", threshold, globalPredictedRain);

            JsonArray slavesArray = doc["slaves"].as<JsonArray>();
            
            for (JsonObject slaveObj : slavesArray) {
                int slaveId = slaveObj["slave_id"];
                int servoAngle = slaveObj["angle"]; 
                
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
                    Serial.printf("   -> [ZONE] Slave %d | Directs to Angle %d°\n", slaveId, servoAngle);
                }
            }
            saveCache(); 
        }
    } else {
        Serial.printf("[HTTP] Config fetch failed, error: %s\n", http.errorToString(httpCode).c_str());
    }
    http.end();
}

// ---------------------------------------------------------------------------
// Radio Callback - THE BOUNCER
// ---------------------------------------------------------------------------
void OnDataRecv(const esp_now_recv_info_t * info, const uint8_t * inData, int len) {
    SlaveTelemetry incoming;
    if (len == sizeof(incoming)) {
        memcpy(&incoming, inData, sizeof(incoming));

        if (incoming.slaveID >= 0 && incoming.slaveID <= MAX_SLAVES) {
            
            // THE BLACKLIST LOGIC (Using the new variable)
            if (lastQueuedTime[incoming.slaveID] != 0 && (millis() - lastQueuedTime[incoming.slaveID] < BOUNCER_BLACKLIST_MS)) {
                return; 
            }
            
            lastQueuedTime[incoming.slaveID] = millis();
            xQueueSendFromISR(telemetryQueue, &incoming, NULL);
        }
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

    WiFi.mode(WIFI_AP_STA); 
    esp_wifi_set_ps(WIFI_PS_NONE); 

    telemetryQueue = xQueueCreate(MAX_QUEUE_SIZE, sizeof(SlaveTelemetry));

    Serial.println("[DIAG] Attaching servo and pinching pipe (0°)...");
    waterDirector.setPeriodHertz(50);
    waterDirector.attach(SERVO_PIN, 500, 2400); 
    waterDirector.write(0); 
    currentServoAngle = 0;
    delay(1000);

    loadCache();

    Serial.printf("[WIFI] Connecting to SSID: %s\n", WIFI_SSID);
    WiFi.begin(WIFI_SSID, WIFI_PASS);
    
    unsigned long start = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - start < 10000) { 
        Serial.print("."); delay(500); 
    }
    
    if (WiFi.status() == WL_CONNECTED) {
        Serial.print("\n[WIFI] Connected! Channel: ");
        Serial.println(WiFi.channel()); 
        fetchConfigFromServer();
        lastCloudSync = millis();
    }

    if (esp_now_init() == ESP_OK) {
        esp_now_register_recv_cb(OnDataRecv);
        Serial.println("[ESPNOW] Listening for Virtual Slaves...");
    } else {
        Serial.println("[ESPNOW] FATAL ERROR");
    }

    pinMode(2, OUTPUT);
}

// ---------------------------------------------------------------------------
// Main Loop
// ---------------------------------------------------------------------------
void loop() {
    SlaveTelemetry pkt;
    
    if (xQueueReceive(telemetryQueue, &pkt, 0) == pdTRUE) {
        Serial.println("\n[DATA RECV] ---------------------");
        Serial.printf("   Slave ID : %d\n", pkt.slaveID);
        Serial.printf("   Moisture : %.2f %%\n", pkt.soilMoisture);
        
        postTelemetryToCloud(pkt);

        int idx = findZoneIndex(pkt.slaveID);
        if (idx != -1) {
            float baseThreshold = zones[idx].moistureThreshold;
            float actualThreshold = baseThreshold;
            int actualWateringTime = WATERING_TIME_MS;

            if (pkt.temperature > 35.0) {
                actualThreshold = min(baseThreshold + 10.0f, 90.0f);
                actualWateringTime += 2000; 
                Serial.printf("   [SMART] Heatwave! Threshold adjusted: %.1f%% -> %.1f%%\n", baseThreshold, actualThreshold);
            }

            if (pkt.soilMoisture < actualThreshold && globalPredictedRain < 2.5) {
                Serial.printf("   [ACTION] Soil is dry (%.1f%% < %.1f%%). Triggering watering cycle!\n", pkt.soilMoisture, actualThreshold);
                
                digitalWrite(2, HIGH); 
                moveServoSlowly(zones[idx].servoAngle);
                digitalWrite(2, LOW);  

                Serial.printf("   [ACTION] Water flowing to Slave %d for %d seconds...\n", pkt.slaveID, actualWateringTime / 1000);
                delay(actualWateringTime);
                
                Serial.println("   [ACTION] Pinching pipe shut.");
                moveServoSlowly(0);
                
            } else if (globalPredictedRain >= 2.5) {
                Serial.printf("   [STANDBY] Expected rain (%.1f mm). Skipping watering to save water.\n", globalPredictedRain);
            } else {
                Serial.printf("   [STANDBY] Soil is adequately moist (%.1f%% >= %.1f%%).\n", pkt.soilMoisture, actualThreshold);
            }
        } else {
            Serial.println("   [WARNING] Slave ID not found in Master's configured zones!");
        }
        Serial.println("---------------------------------");
    }

    // Use the variable defined at the top
    if (WiFi.status() == WL_CONNECTED && millis() - lastCloudSync > SYNC_INTERVAL_MS) {
        fetchConfigFromServer();
        lastCloudSync = millis();
    }
}
