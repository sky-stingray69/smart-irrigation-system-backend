#include <esp_now.h>
#include <WiFi.h>
#include <esp_wifi.h> 
#include "DHT.h"

// ---------------------------------------------------------------------------
// TIMING CONTROLS (Easily change these values)
// ---------------------------------------------------------------------------
#define DEEP_SLEEP_SECONDS 15  // How often the slave wakes up to send data

// ---------------------------------------------------------------------------
// CRITICAL SETTINGS
// ---------------------------------------------------------------------------
#define WIFI_CHANNEL 11 
uint8_t masterAddress[] = {0x94, 0xB5, 0x55, 0x26, 0x8C, 0xF4}; 

#define NUM_VIRTUAL_SLAVES 3

// Arrays to hold the settings for each virtual slave
const int slaveIDs[NUM_VIRTUAL_SLAVES]   = {1, 2, 3};
const int dhtPins[NUM_VIRTUAL_SLAVES]    = {5, 18, 19};
const int moistPins[NUM_VIRTUAL_SLAVES]  = {32, 33, 34};

// Initialize the 3 DHT sensors
DHT dht1(dhtPins[0], DHT11);
DHT dht2(dhtPins[1], DHT11);
DHT dht3(dhtPins[2], DHT11);
DHT* dhtSensors[NUM_VIRTUAL_SLAVES] = {&dht1, &dht2, &dht3};

struct SlaveTelemetry { 
    int slaveID; 
    float humidity, temperature, soilMoisture; 
} myData;

volatile int packetsDelivered = 0;

void OnDataSent(const esp_now_send_info_t * info, esp_now_send_status_t status) {
    packetsDelivered++;
    Serial.print("[ESPNOW] Delivery Status for a packet: ");
    Serial.println(status == ESP_NOW_SEND_SUCCESS ? "Success" : "Fail");
}

void setup() {
    Serial.begin(115200);
    delay(1000); 
    Serial.println("\n=================================");
    Serial.println("--- MULTI-SLAVE NODE WAKING UP ---");
    Serial.println("=================================");
    
    for (int i = 0; i < NUM_VIRTUAL_SLAVES; i++) {
        dhtSensors[i]->begin();
    }
    
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

    for (int i = 0; i < NUM_VIRTUAL_SLAVES; i++) {
        Serial.printf("\n[DATA] Reading Virtual Slave %d...\n", slaveIDs[i]);
        
        myData.slaveID = slaveIDs[i]; 
        
        float h = dhtSensors[i]->readHumidity();
        float t = dhtSensors[i]->readTemperature();
        
        if (isnan(h) || isnan(t)) {
            Serial.printf("   -> [SENSOR] Warning: DHT on pin %d failed! Sending 0.0\n", dhtPins[i]);
            myData.humidity = 0.0;
            myData.temperature = 0.0;
        } else {
            myData.humidity = h;
            myData.temperature = t;
        }
        
        // --- PRO CALIBRATION: PIECEWISE INTERPOLATION ---
        int raw = analogRead(moistPins[i]);
        Serial.printf("   -> [DEBUG] Pin %d Raw ADC Value: %d\n", moistPins[i], raw);
        
        if (raw >= 1726) {
            // From Bone Dry (4095) to Sticky Clay (1726) -> Maps to 0% - 60%
            myData.soilMoisture = constrain(map(raw, 4095, 1726, 0, 60), 0, 100);
        } else {
            // From Sticky Clay (1726) to Swamp (1390) -> Maps to 60% - 100%
            myData.soilMoisture = constrain(map(raw, 1726, 1390, 60, 100), 0, 100);
        }
        Serial.printf("   -> Sending [ID: %d] Temp: %.2f C, Hum: %.2f %%, Moist: %.2f %%\n", 
                      myData.slaveID, myData.temperature, myData.humidity, myData.soilMoisture);

        esp_now_send(masterAddress, (uint8_t *) &myData, sizeof(myData));
        
        delay(100); 
    }
}

void loop() {
    if (packetsDelivered >= NUM_VIRTUAL_SLAVES || millis() > 3000) {
        if (packetsDelivered < NUM_VIRTUAL_SLAVES) {
            Serial.println("\n[ESPNOW] Timeout: Master missed some packets.");
        } else {
            Serial.println("\n[ESPNOW] All Virtual Slave packets successfully delivered!");
        }
        
        Serial.printf("[SYSTEM] Task complete. Entering %d-second Deep Sleep...\n", DEEP_SLEEP_SECONDS);
        Serial.flush();        
        esp_wifi_stop(); 
        
        // Use the variable defined at the top
        esp_sleep_enable_timer_wakeup(DEEP_SLEEP_SECONDS * 1000000ULL); 
        esp_deep_sleep_start();
    }
}
