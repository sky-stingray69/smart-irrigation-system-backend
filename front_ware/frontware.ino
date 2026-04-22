#include <esp_now.h>
#include <WiFi.h>
#include <esp_wifi.h> 
#include "DHT.h"

#define SLAVE_ID 1
#define DHTPIN 5
#define DHTTYPE DHT11
#define MOISTURE_PIN 32

// --- MUST MATCH THE CHANNEL PRINTED BY THE MASTER ---
#define WIFI_CHANNEL 11
uint8_t masterAddress[] = {0x94, 0xB5, 0x55, 0x26, 0x8C, 0xF4}; 

DHT dht(DHTPIN, DHTTYPE);

struct SlaveTelemetry { 
    int slaveID; 
    float humidity, temperature, soilMoisture; 
} myData;

volatile bool delivered = false;

void OnDataSent(const esp_now_send_info_t * info, esp_now_send_status_t status) {
    delivered = true;
    Serial.print("[ESPNOW] Delivery Status: ");
    Serial.println(status == ESP_NOW_SEND_SUCCESS ? "Success" : "Fail");
}

void setup() {
    // CRITICAL FIX: Restored to 115200 so the monitor is readable
    Serial.begin(115200);
    delay(1000); 
    Serial.println("\n=================================");
    Serial.println("--- SLAVE NODE WAKING UP ---");
    Serial.println("=================================");
    
    dht.begin();
    
    WiFi.mode(WIFI_STA);
    esp_wifi_set_channel(WIFI_CHANNEL, WIFI_SECOND_CHAN_NONE);
    
    if (esp_now_init() != ESP_OK) {
        Serial.println("[ESPNOW] FATAL: Init Failed");
        return;
    }
    esp_now_register_send_cb(OnDataSent);

    esp_now_peer_info_t peerInfo = {};
    memcpy(peerInfo.peer_addr, masterAddress, 6);
    peerInfo.channel = WIFI_CHANNEL;
    peerInfo.encrypt = false; 
    
    if (esp_now_add_peer(&peerInfo) != ESP_OK) {
        Serial.println("[ESPNOW] FATAL: Failed to add peer");
        return;
    }

    myData.slaveID = SLAVE_ID;
    
    float h = dht.readHumidity();
    float t = dht.readTemperature();
    
    if (isnan(h) || isnan(t)) {
        Serial.println("[SENSOR] Warning: Failed to read DHT! Sending 0.0");
        myData.humidity = 0.0;
        myData.temperature = 0.0;
    } else {
        myData.humidity = h;
        myData.temperature = t;
    }
    
    int raw = analogRead(MOISTURE_PIN);
    myData.soilMoisture = constrain(map(raw, 4095, 1500, 0, 100), 0, 100);

    Serial.printf("[DATA] Sending - Temp: %.2f C, Hum: %.2f %%, Moist: %.2f %%\n", 
                  myData.temperature, myData.humidity, myData.soilMoisture);

    esp_now_send(masterAddress, (uint8_t *) &myData, sizeof(myData));
}

void loop() {
    if (delivered || millis() > 3000) {
        if (!delivered) {
            Serial.println("[ESPNOW] Timeout: Master did not acknowledge.");
        }
        
        Serial.println("[SYSTEM] Task complete. Entering 30s Deep Sleep...");
        
        Serial.flush();        
        esp_wifi_stop(); 
        
        esp_sleep_enable_timer_wakeup(30 * 1000000ULL); 
        esp_deep_sleep_start();
    }
}