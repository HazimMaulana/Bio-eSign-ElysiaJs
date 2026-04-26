import mqtt, { type MqttClient } from "mqtt";

const MQTT_URL = process.env.MQTT_URL;
const MQTT_USERNAME = process.env.MQTT_USERNAME;
const MQTT_PASSWORD = process.env.MQTT_PASSWORD;

if (!MQTT_URL) {
  throw new Error("MQTT_URL is required");
}

if (!MQTT_USERNAME) {
  throw new Error("MQTT_USERNAME is required");
}

if (!MQTT_PASSWORD) {
  throw new Error("MQTT_PASSWORD is required");
}

export const mqttClient: MqttClient = mqtt.connect(MQTT_URL, {
  username: MQTT_USERNAME,
  password: MQTT_PASSWORD,

  clientId: `backend-service-${Math.random().toString(16).slice(2)}`,

  clean: true,
  reconnectPeriod: 3000,
  connectTimeout: 10_000,
});

mqttClient.on("connect", () => {
  console.log("[MQTT] Connected to broker:", MQTT_URL);

  mqttClient.subscribe("presence/#", { qos: 1 }, (error) => {
    if (error) {
      console.error("[MQTT] Subscribe error:", error);
      return;
    }

    console.log("[MQTT] Subscribed to topic: presence/#");
  });
});

mqttClient.on("reconnect", () => {
  console.log("[MQTT] Reconnecting...");
});

mqttClient.on("error", (error) => {
  console.error("[MQTT] Error:", error.message);
});

mqttClient.on("close", () => {
  console.log("[MQTT] Connection closed");
});

mqttClient.on("message", async (topic, payload) => {
  const message = payload.toString();

  console.log("[MQTT] Message received");
  console.log("Topic:", topic);
  console.log("Payload:", message);

  try {
    const data = JSON.parse(message);

    if (topic.endsWith("/attendance/log")) {
      console.log("[ATTENDANCE LOG]", data);

      // TODO:
      // Simpan data presensi ke database
      // await attendanceService.create(data);
    }

    if (topic.endsWith("/status")) {
      console.log("[DEVICE STATUS]", data);

      // TODO:
      // Update status device di database
    }
  } catch {
    console.warn("[MQTT] Payload is not valid JSON:", message);
  }
});

export function publishMqtt(topic: string, payload: unknown) {
  return new Promise<void>((resolve, reject) => {
    const message =
      typeof payload === "string" ? payload : JSON.stringify(payload);

    mqttClient.publish(topic, message, { qos: 1 }, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}