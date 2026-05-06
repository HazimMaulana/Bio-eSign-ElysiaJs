import mqtt, { type IPublishPacket, type MqttClient } from "mqtt";
import { prisma } from "./prisma";
import { redis } from "./redis";

// MQTT topic definitions
// {prefix}/{deviceId}/attendance -> ESP32 reports check-in/check-out
// {prefix}/{deviceId}/ping -> ESP32 heartbeat
// {prefix}/mahasiswa/templates/request -> ESP32 requests active class templates
// {prefix}/mahasiswa/registrasi -> ESP32 reports registration metadata
// {prefix}/mahasiswa/registrasi/template/{deviceId}/{nim}/{slot}/{fingerId} -> ESP32 sends raw template bytes

const TOPIC_PREFIX = process.env.MQTT_TOPIC_PREFIX ?? "presence";
const SERVER_TOPIC_PREFIX = `${TOPIC_PREFIX}/server`;

const TOPICS = {
  ATTENDANCE: `${TOPIC_PREFIX}/+/attendance`,
  DEVICE_PING: `${TOPIC_PREFIX}/+/ping`,
  TEMPLATE_REQUEST: `${TOPIC_PREFIX}/mahasiswa/templates/request`,
  REGISTRATION_RESULT: `${TOPIC_PREFIX}/mahasiswa/registrasi`,
  REGISTRATION_TEMPLATE: `${TOPIC_PREFIX}/mahasiswa/registrasi/template/#`,
} as const;

const MQTT_DEBUG = (process.env.MQTT_DEBUG ?? "").toLowerCase() === "true";
const SUBSCRIBE_QOS = 1;

type TopicRoute =
  | "attendance"
  | "ping"
  | "template/request"
  | "registration/result"
  | "registration/template";

let mqttClient: MqttClient | null = null;
let subscriberStarted = false;

const pendingRegistrationMetadata = new Map<
  string,
  { name: string; classCode?: string; timestamp: number }
>();

interface AttendancePayload {
  device_id: string;
  fingerprint_id?: number;
  finger_id?: number;
  action?: "check_in" | "check_out";
  match_score?: number;
  confidence?: number;
  timestamp?: string;
}

interface PingPayload {
  device_id: string;
  firmware_version?: string;
  uptime_seconds?: number;
}

interface TemplateSyncRequestPayload {
  device_id: string;
  action?: string;
  class_code?: string;
}

interface RegistrationResultPayload {
  device_id: string;
  nim: string;
  nama?: string;
  name?: string;
  slot: number;
  finger_id?: number;
  fingerprint_id?: number;
  success: boolean;
  message?: string;
  class_code?: string;
}

function debugLog(message: string, metadata?: Record<string, unknown>) {
  if (!MQTT_DEBUG) return;

  if (metadata) {
    console.log(`[MQTT][DEBUG] ${message}`, metadata);
    return;
  }

  console.log(`[MQTT][DEBUG] ${message}`);
}

function describePayloadShape(payload: unknown) {
  if (Array.isArray(payload)) {
    return {
      payload_type: "array",
      keys: [],
    };
  }

  if (payload && typeof payload === "object") {
    return {
      payload_type: "object",
      keys: Object.keys(payload as Record<string, unknown>),
    };
  }

  return {
    payload_type: payload === null ? "null" : typeof payload,
    keys: [],
  };
}

function getPacketMetadata(packet: IPublishPacket) {
  return {
    qos: packet.qos,
    retain: packet.retain,
    dup: packet.dup,
  };
}

function summarizeAttendancePayload(payload: AttendancePayload) {
  return {
    device_id: payload.device_id,
    fingerprint_id: payload.fingerprint_id ?? payload.finger_id,
    action: payload.action ?? "check_in",
    match_score: payload.match_score ?? payload.confidence,
    has_timestamp: typeof payload.timestamp === "string",
  };
}

function summarizePingPayload(payload: PingPayload) {
  return {
    device_id: payload.device_id,
    firmware_version: payload.firmware_version ?? null,
    uptime_seconds: payload.uptime_seconds ?? null,
  };
}

function resolveTopicRoute(topic: string): TopicRoute | null {
  if (!topic.startsWith(`${TOPIC_PREFIX}/`)) return null;

  const fullSuffix = topic.slice(TOPIC_PREFIX.length + 1);
  if (fullSuffix === "mahasiswa/templates/request") return "template/request";
  if (fullSuffix === "mahasiswa/registrasi") return "registration/result";
  if (fullSuffix.startsWith("mahasiswa/registrasi/template/")) {
    return "registration/template";
  }

  const parts = topic.split("/");
  if (parts.length < 3) return null;

  const suffix = parts.slice(2).join("/");

  if (suffix === "attendance") return "attendance";
  if (suffix === "ping") return "ping";

  return null;
}

function isValidAttendance(p: unknown): p is AttendancePayload {
  if (!p || typeof p !== "object") return false;
  const o = p as Record<string, unknown>;
  return (
    typeof o.device_id === "string" &&
    (typeof o.fingerprint_id === "number" || typeof o.finger_id === "number") &&
    (o.action === undefined || o.action === "check_in" || o.action === "check_out") &&
    (o.match_score === undefined || typeof o.match_score === "number") &&
    (o.confidence === undefined || typeof o.confidence === "number")
  );
}

function isValidPing(p: unknown): p is PingPayload {
  if (!p || typeof p !== "object") return false;
  const o = p as Record<string, unknown>;
  return typeof o.device_id === "string";
}

function isValidTemplateSyncRequest(p: unknown): p is TemplateSyncRequestPayload {
  if (!p || typeof p !== "object") return false;
  const o = p as Record<string, unknown>;
  return typeof o.device_id === "string";
}

function isValidRegistrationResult(p: unknown): p is RegistrationResultPayload {
  if (!p || typeof p !== "object") return false;
  const o = p as Record<string, unknown>;
  return (
    typeof o.device_id === "string" &&
    typeof o.nim === "string" &&
    typeof o.slot === "number" &&
    typeof o.success === "boolean"
  );
}

function extractDeviceId(topic: string): string | null {
  const parts = topic.split("/");
  return parts.length >= 2 ? parts[1] : null;
}

function parseJsonPayload(message: Buffer) {
  try {
    return JSON.parse(message.toString());
  } catch (error) {
    console.warn("[MQTT] Payload is not valid JSON:", message.toString());
    if (MQTT_DEBUG) {
      console.warn("[MQTT][DEBUG] JSON parse error:", error);
    }
    return null;
  }
}

function publishAsync(client: MqttClient, topic: string, payload: unknown) {
  return new Promise<void>((resolve, reject) => {
    const message = JSON.stringify(payload);

    client.publish(topic, message, { qos: 1 }, (error) => {
      if (error) {
        reject(error);
        return;
      }

      console.log(`[MQTT] Published to ${topic}`);
      resolve();
    });
  });
}

function publishBinaryAsync(client: MqttClient, topic: string, payload: Buffer | Uint8Array) {
  return new Promise<void>((resolve, reject) => {
    client.publish(topic, Buffer.from(payload), { qos: 1 }, (error) => {
      if (error) {
        reject(error);
        return;
      }

      console.log(`[MQTT] Published binary to ${topic} (${payload.byteLength} bytes)`);
      resolve();
    });
  });
}

function waitForMqttConnected(client: MqttClient) {
  if (client.connected) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("MQTT client is not connected"));
    }, 10_000);

    const cleanup = () => {
      clearTimeout(timeout);
      client.off("connect", onConnect);
      client.off("error", onError);
    };

    const onConnect = () => {
      cleanup();
      resolve();
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    client.once("connect", onConnect);
    client.once("error", onError);
  });
}

async function handleAttendance(payload: AttendancePayload) {
  const fingerprintId = payload.fingerprint_id ?? payload.finger_id;
  if (fingerprintId === undefined) {
    console.warn("[MQTT] Attendance ignored: missing fingerprint id");
    return;
  }

  const fingerprint = await prisma.studentFingerprint.findFirst({
    where: { fingerprintIdOnDevice: fingerprintId },
  });

  const action = payload.action === "check_out" ? "CHECK_OUT" : "CHECK_IN";
  const matchScore = payload.match_score ?? payload.confidence ?? null;

  const device = await prisma.device.findUnique({
    where: { deviceId: payload.device_id },
  });

  if (!device) {
    console.error(`[MQTT] Unknown device: ${payload.device_id}`);
    debugLog("Attendance rejected because device was not found", {
      ...summarizeAttendancePayload(payload),
      student_id: fingerprint?.studentId ?? null,
    });
    return;
  }

  const cachedScheduleId = await redis.get(
    `active_schedule:${payload.device_id}`
  );

  await prisma.attendanceEvent.create({
    data: {
      studentId: fingerprint?.studentId ?? null,
      deviceId: device.id,
      scheduleId: cachedScheduleId ?? null,
      action,
      matchScore,
      eventTime: payload.timestamp ? new Date(payload.timestamp) : new Date(),
      rawPayload: payload as object,
    },
  });

  console.log(
    `[MQTT] Attendance recorded: ${action} by student ${fingerprint?.studentId ?? "UNKNOWN"} on ${payload.device_id}`
  );

  debugLog("Attendance handler completed", {
    ...summarizeAttendancePayload(payload),
    action_recorded: action,
    student_id: fingerprint?.studentId ?? null,
    schedule_id: cachedScheduleId ?? null,
  });
}

async function handleDevicePing(payload: PingPayload) {
  await prisma.device.upsert({
    where: { deviceId: payload.device_id },
    update: {
      status: "ONLINE",
      lastPing: new Date(),
      firmwareVersion: payload.firmware_version ?? undefined,
    },
    create: {
      deviceId: payload.device_id,
      status: "ONLINE",
      lastPing: new Date(),
      firmwareVersion: payload.firmware_version ?? undefined,
    },
  });

  await redis.set(`device:${payload.device_id}:status`, "ONLINE", "EX", 300);

  debugLog("Ping handler completed", summarizePingPayload(payload));
}

async function handleTemplateSyncRequest(payload: TemplateSyncRequestPayload) {
  const { syncClassForDeviceRequest } = await import(
    "../modules/classes/classes.service"
  );

  const result = await syncClassForDeviceRequest(
    payload.device_id,
    payload.class_code
  );

  if (!result.ok) {
    console.warn("[MQTT] Template sync request failed:", result);
    return;
  }

  console.log(
    `[MQTT] Template sync request served: device=${result.deviceId} class=${result.classCode}`
  );
}

async function handleRegistrationResult(payload: RegistrationResultPayload) {
  const name = payload.name ?? payload.nama ?? "";
  const fingerprintId = payload.finger_id ?? payload.fingerprint_id ?? null;

  if (!payload.success) {
    console.warn("[MQTT] Registration failed on device:", {
      device_id: payload.device_id,
      nim: payload.nim,
      slot: payload.slot,
      message: payload.message ?? null,
    });
    return;
  }

  pendingRegistrationMetadata.set(
    `${payload.device_id}:${payload.nim}:${payload.slot}:${fingerprintId ?? ""}`,
    { name, classCode: payload.class_code, timestamp: Date.now() }
  );

  await prisma.student.upsert({
    where: { nim: payload.nim },
    update: { name, isActive: true },
    create: { nim: payload.nim, name, isActive: true },
  });

  console.log(
    `[MQTT] Registration metadata received: nim=${payload.nim} slot=${payload.slot} finger_id=${fingerprintId ?? "null"}`
  );
}

function parseRegistrationTemplateTopic(topic: string) {
  const prefix = `${TOPIC_PREFIX}/mahasiswa/registrasi/template/`;
  if (!topic.startsWith(prefix)) return null;

  const parts = topic.slice(prefix.length).split("/");
  if (parts.length < 4) return null;

  const slot = Number(parts[2]);
  const fingerprintId = Number(parts[3]);
  if (!Number.isInteger(slot) || !Number.isInteger(fingerprintId)) return null;

  return {
    deviceId: parts[0],
    nim: parts[1],
    slot,
    fingerprintId,
  };
}

async function handleRegistrationTemplate(topic: string, templateBytes: Buffer) {
  const parsed = parseRegistrationTemplateTopic(topic);
  if (!parsed) {
    console.warn("[MQTT] Invalid registration template topic:", topic);
    return;
  }

  const metadataKey = `${parsed.deviceId}:${parsed.nim}:${parsed.slot}:${parsed.fingerprintId}`;
  const metadata = pendingRegistrationMetadata.get(metadataKey);
  const existingStudent = await prisma.student.findUnique({
    where: { nim: parsed.nim },
    select: { name: true },
  });
  const name = metadata?.name || existingStudent?.name || parsed.nim;

  const { storeRegistrationTemplate } = await import(
    "../modules/registration/registration.service"
  );

  const result = await storeRegistrationTemplate({
    nim: parsed.nim,
    name,
    slot: parsed.slot,
    fingerprintId: parsed.fingerprintId,
    templateBytes,
    deviceId: parsed.deviceId,
    classCode: metadata?.classCode,
  });

  if (!result.ok) {
    console.warn("[MQTT] Registration binary template store failed:", result);
    return;
  }

  pendingRegistrationMetadata.delete(metadataKey);
  console.log(
    `[MQTT] Registration binary template stored: nim=${result.nim} slot=${result.slot} finger_id=${result.fingerprintIdOnDevice ?? "null"} size=${templateBytes.length}`
  );
}

export function startMqttSubscriber() {
  if (mqttClient && subscriberStarted) {
    return mqttClient;
  }

  const brokerUrl = process.env.MQTT_URL;
  const username = process.env.MQTT_USERNAME;
  const password = process.env.MQTT_PASSWORD;

  if (!brokerUrl) {
    throw new Error("MQTT_URL is required");
  }

  if (!username) {
    throw new Error("MQTT_USERNAME is required");
  }

  if (!password) {
    throw new Error("MQTT_PASSWORD is required");
  }

  const clientId = `bioesign-server-${Date.now()}`;

  const topics = [
    TOPICS.ATTENDANCE,
    TOPICS.DEVICE_PING,
    TOPICS.TEMPLATE_REQUEST,
    TOPICS.REGISTRATION_RESULT,
    TOPICS.REGISTRATION_TEMPLATE,
  ];

  debugLog("Starting MQTT subscriber", {
    broker_url: brokerUrl,
    client_id: clientId,
    username,
    topics,
    debug_enabled: MQTT_DEBUG,
  });

  const client = mqttClient ?? mqtt.connect(brokerUrl, {
    clientId,
    username,
    password,
    clean: true,
    reconnectPeriod: 5000,
    connectTimeout: 10_000,
  });

  mqttClient = client;
  subscriberStarted = true;

  client.on("connect", () => {
    console.log(`[MQTT] Connected to broker: ${brokerUrl}`);

    client.subscribe(topics, { qos: SUBSCRIBE_QOS }, (err, granted) => {
      if (err) {
        console.error("[MQTT] Subscribe error:", err);
        return;
      }

      console.log("[MQTT] Subscribed to:", topics.join(", "));
    });
  });

  client.on(
    "message",
    async (topic: string, message: Buffer, packet: IPublishPacket) => {
      const route = resolveTopicRoute(topic);

      if (!route) {
        debugLog("Ignoring message with unknown topic/payload", {
          topic,
          route,
          packet: getPacketMetadata(packet),
        });
        return;
      }

      if (route === "registration/template") {
        await handleRegistrationTemplate(topic, message);
        return;
      }

      const payload = parseJsonPayload(message);
      if (payload === null) {
        debugLog("Ignoring message with invalid JSON payload", {
          topic,
          route,
          packet: getPacketMetadata(packet),
        });
        return;
      }

      const topicDeviceId = extractDeviceId(topic);
      if (topicDeviceId && payload.device_id && topicDeviceId !== payload.device_id) {
        debugLog("Device ID mismatch between topic and payload", {
          topic_device_id: topicDeviceId,
          payload_device_id: payload.device_id,
          topic,
        });
      }

      if (route === "attendance") {
        if (!isValidAttendance(payload)) {
          debugLog("Invalid attendance payload", {
            topic,
            payload_shape: describePayloadShape(payload),
          });
          return;
        }
        await handleAttendance(payload);
        return;
      }

      if (route === "ping") {
        if (!isValidPing(payload)) {
          debugLog("Invalid ping payload", {
            topic,
            payload_shape: describePayloadShape(payload),
          });
          return;
        }
        await handleDevicePing(payload);
        return;
      }

      if (route === "template/request") {
        if (!isValidTemplateSyncRequest(payload)) {
          debugLog("Invalid template sync request payload", {
            topic,
            payload_shape: describePayloadShape(payload),
          });
          return;
        }
        await handleTemplateSyncRequest(payload);
        return;
      }

      if (route === "registration/result") {
        if (!isValidRegistrationResult(payload)) {
          debugLog("Invalid registration result payload", {
            topic,
            payload_shape: describePayloadShape(payload),
          });
          return;
        }
        await handleRegistrationResult(payload);
      }
    }
  );

  client.on("error", (err) => {
    console.error("[MQTT] Connection error:", err);
  });

  client.on("reconnect", () => {
    console.log("[MQTT] Reconnecting...");
  });

  return client;
}

export async function publishMqtt(topic: string, payload: unknown) {
  const client = mqttClient ?? startMqttSubscriber();
  await waitForMqttConnected(client);
  await publishAsync(client, topic, payload);
}

export async function publishMqttBinary(topic: string, payload: Buffer | Uint8Array) {
  const client = mqttClient ?? startMqttSubscriber();
  await waitForMqttConnected(client);
  await publishBinaryAsync(client, topic, payload);
}

export function getMqttServerTopic(deviceId: string, suffix: string) {
  return `${SERVER_TOPIC_PREFIX}/${deviceId}/${suffix}`;
}
