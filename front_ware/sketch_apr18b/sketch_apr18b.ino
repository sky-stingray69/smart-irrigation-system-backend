#include <esp_now.h>
#include <WiFi.h>
#include "DHT.h"

// --- Configuration ---
#define DHTPIN 5
#define DHTTYPE DHT11
#define MOISTURE_AO_PIN 32
#define SLAVE_ID 1 

// Sleep Settings
#define uS_TO_S_FACTOR 1000000ULL  /* Conversion factor for micro seconds to seconds */
#define TIME_TO_SLEEP  7200        /* Time ESP32 will go to sleep (in seconds) - 2 hours */

// REPLACE WITH YOUR MASTER'S MAC ADDRESS
uint8_t masterAddress[] = {0xCC, 0xDB, 0xA7, 0x12, 0x34, 0x56}; // Example MAC

DHT dht(DHTPIN, DHTTYPE);

struct SlaveTelemetry {
    int slaveID;
    float humidity;
    float temperature;
    float waterFlow;
} myData;

// Callback when data is sent
void OnDataSent(const uint8_t *mac_addr, esp_now_send_status_t status) {
    Serial.print("\r\nLast Packet Send Status:\t");
    Serial.println(status == ESP_NOW_SEND_SUCCESS ? "Delivery Success" : "Delivery Fail");
}

void setup() {
    Serial.begin(115200);
    
    // 1. Initialize Sensors
    dht.begin();
    pinMode(MOISTURE_AO_PIN, INPUT);

    // 2. Setup WiFi & ESP-NOW
    WiFi.mode(WIFI_STA);
    if (esp_now_init() != ESP_OK) {
        Serial.println("Error initializing ESP-NOW");
        return;
    }

    esp_now_register_send_cb(OnDataSent);
    
    esp_now_peer_info_t peerInfo;
    memcpy(peerInfo.peer_addr, masterAddress, 6);
    peerInfo.channel = 0;  
    peerInfo.encrypt = false;
    
    if (esp_now_add_peer(&peerInfo) != ESP_OK) {
        Serial.println("Failed to add peer");
        return;
    }

    // 3. Gather Data
    float h = dht.readHumidity(); // Air humidity
    float t = dht.readTemperature();
    int rawMoisture = analogRead(MOISTURE_AO_PIN);

    if (isnan(h) || isnan(t)) {
        Serial.println("DHT failure! Checking again before sleep...");
    }

    float moisturePercent = map(rawMoisture, 4095, 1500, 0, 100);
    moisturePercent = constrain(moisturePercent, 0, 100);

    // 4. Prepare Struct
    myData.slaveID = SLAVE_ID;
    myData.humidity = moisturePercent; 
    myData.temperature = t;
    myData.waterFlow = 0.0; 

    // 5. Send Data
    esp_err_t result = esp_now_send(masterAddress, (uint8_t *) &myData, sizeof(myData));
    
    // Give the ESP a small moment to ensure the radio finished the transmission
    delay(200); 

    // 6. Go to Sleep
    Serial.println("Entering Deep Sleep for 2 hours...");
    esp_sleep_enable_timer_wakeup(TIME_TO_SLEEP * uS_TO_S_FACTOR);
    esp_deep_sleep_start();
}

void loop() {
    // This part is never reached because the ESP32 restarts after waking up.
}