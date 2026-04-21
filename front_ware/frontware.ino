#include <esp_now.h>
#include <WiFi.h>
#include "DHT.h"

// --- Configuration ---
#define DHTPIN 5
#define DHTTYPE DHT11
#define MOISTURE_AO_PIN 32
#define SLAVE_ID 1 

// CRITICAL FIX: You MUST set this to the Wi-Fi channel your home router uses. 
// If your router is on Channel 6, set this to 6.
#define WIFI_CHANNEL 6 

// Sleep Settings
#define uS_TO_S_FACTOR 1000000ULL  
#define TIME_TO_SLEEP  7200        

// REPLACE WITH YOUR MASTER'S MAC ADDRESS
uint8_t masterAddress[] = {0xCC, 0xDB, 0xA7, 0x12, 0x34, 0x56}; 

DHT dht(DHTPIN, DHTTYPE);

// CRITICAL FIX: Struct matches master exactly
struct SlaveTelemetry {
    int   slaveID;
    float humidity;
    float temperature;
    float soilMoisture; 
} myData;

// CRITICAL FIX: Flag to prevent going to sleep before transmission finishes
volatile bool messageSent = false;

// Callback when data is sent
void OnDataSent(const uint8_t *mac_addr, esp_now_send_status_t status) {
    Serial.print("\r\nLast Packet Send Status:\t");
    Serial.println(status == ESP_NOW_SEND_SUCCESS ? "Delivery Success" : "Delivery Fail");
    messageSent = true; // Signal the main loop we can sleep now
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
        // Don't just return, go back to sleep and try again later
        esp_sleep_enable_timer_wakeup(TIME_TO_SLEEP * uS_TO_S_FACTOR);
        esp_deep_sleep_start();
    }

    esp_now_register_send_cb(OnDataSent);
    
    esp_now_peer_info_t peerInfo;

    memset(&peerInfo,0,sizeof(peerInfo));

    memcpy(peerInfo.peer_addr, masterAddress, 6);
    peerInfo.channel = WIFI_CHANNEL; // Set the channel to match the Master  
    peerInfo.encrypt = false;
    
    if (esp_now_add_peer(&peerInfo) != ESP_OK) {
        Serial.println("Failed to add peer");
        return;
    }

    // 3. Gather Data
    delay(2000);
    float h = dht.readHumidity(); 
    float t = dht.readTemperature();
    int rawMoisture = analogRead(MOISTURE_AO_PIN);

    float moisturePercent = map(rawMoisture, 4095, 1500, 0, 100);
    moisturePercent = constrain(moisturePercent, 0, 100);

    // 4. Prepare Struct (Correct Mapping)
    myData.slaveID      = SLAVE_ID;
    myData.humidity     = h;                // Was missing before
    myData.temperature  = t;
    myData.soilMoisture = moisturePercent;  // Was accidentally sent as humidity before

    // 5. Send Data
    esp_now_send(masterAddress, (uint8_t *) &myData, sizeof(myData));
}

void loop() {
    // CRITICAL FIX: Wait for the radio to finish sending before sleeping
    if (messageSent) {
        Serial.println("Transmission complete. Entering Deep Sleep for 2 hours...");
        esp_sleep_enable_timer_wakeup(TIME_TO_SLEEP * uS_TO_S_FACTOR);
        esp_deep_sleep_start();
    }
    
    // Fail-safe: If the callback never fires (e.g., radio glitch), sleep anyway after 1 second
    if (millis() > 1000) {
        Serial.println("Timeout waiting for transmission. Sleeping anyway...");
        esp_sleep_enable_timer_wakeup(TIME_TO_SLEEP * uS_TO_S_FACTOR);
        esp_deep_sleep_start();
    }
}
