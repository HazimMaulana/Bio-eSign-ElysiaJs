import mqtt, { type IPublishPacket, type MqttClient } from "mqtt";
import { prisma } from "./prisma";
import { redis } from "./redis";
import { encryptTemplate } from "./crypto";

// MQTT topic definitions
// {prefix}/{deviceId}/attendance -> ESP32 reports check-in/check-out
// {prefix}/{deviceId}/ping -> ESP32 heartbeat
// {prefix}/{deviceId}/template/chunk -> ESP32 sends template chunks
// {prefix}/server/{deviceId}/template/manifest -> Server sends manifest to device
// {prefix}/server/{deviceId}/template/data -> Server sends template chunks to device

const TOPIC_PREFIX = process.env.MQTT_TOPIC_PREFIX ?? "presence";
const SERVER_TOPIC_PREFIX = `${TOPIC_PREFIX}/server`;

const TOPICS = {
  ATTENDANCE: `${TOPIC_PREFIX}/+/attendance`,
  DEVICE_PING: `${TOPIC_PREFIX}/+/ping`,
  TEMPLATE_CHUNK: `${TOPIC_PREFIX}/+/template/chunk`,
  TEMPLATE_REQUEST: `${TOPIC_PREFIX}/mahasiswa/templates/request`,
} as const;

const MQTT_DEBUG = (process.env.MQTT_DEBUG ?? "").toLowerCase() === "true";
const SUBSCRIBE_QOS = 1;
const TEMPLATE_SAMPLE = process.env.TEMPLATE_SAMPLE ?? "";
const TEMPLATE_SYNC_CHUNK_SIZE = Math.max(
  64,
  Number(process.env.MQTT_TEMPLATE_CHUNK_SIZE ?? 512)
);
const TEMPLATE_SYNC_SLOT = Math.max(
  1,
  Number(process.env.MQTT_TEMPLATE_SLOT ?? 1)
);
const TEMPLATE_SYNC_STUDENT_ID =
  process.env.MQTT_TEMPLATE_STUDENT_ID ?? "env-student-0001";
const TEMPLATE_SYNC_TTL_SECONDS = Math.max(
  30,
  Number(process.env.MQTT_TEMPLATE_SYNC_TTL_SECONDS ?? 300)
);

type TopicRoute = "attendance" | "ping" | "template/chunk" | "template/request";

let mqttClient: MqttClient | null = null;
let subscriberStarted = false;

// Template chunk reassembly buffer
// Key: `{deviceId}:{studentId}:{slot}` -> chunks[]
const chunkBuffers = new Map<
  string,
  { total: number; received: Map<number, string>; timestamp: number }
>();

// Clean stale buffers every 60s
setInterval(() => {
  const now = Date.now();
  for (const [key, buf] of chunkBuffers) {
    if (now - buf.timestamp > 60_000) {
      chunkBuffers.delete(key);
      debugLog("Dropped stale template chunk buffer", {
        buffer_key: key,
        received_chunks: buf.received.size,
        total_chunks: buf.total,
      });
    }
  }
}, 60_000);

interface AttendancePayload {
  device_id: string;
  fingerprint_id: number;
  action: "check_in" | "check_out";
  match_score: number;
  timestamp?: string;
}

interface PingPayload {
  device_id: string;
  firmware_version?: string;
  uptime_seconds?: number;
}

interface TemplateChunkPayload {
  device_id: string;
  student_id: string;
  slot: number;
  chunk_index: number;
  total_chunks: number;
  data: string;
}

interface TemplateSyncRequestPayload {
  device_id: string;
  action?: string;
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
    fingerprint_id: payload.fingerprint_id,
    action: payload.action,
    match_score: payload.match_score,
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

function summarizeTemplateChunkPayload(payload: TemplateChunkPayload) {
  return {
    device_id: payload.device_id,
    student_id: payload.student_id,
    slot: payload.slot,
    chunk_index: payload.chunk_index,
    total_chunks: payload.total_chunks,
    data_length: payload.data.length,
  };
}

function resolveTopicRoute(topic: string): TopicRoute | null {
  if (!topic.startsWith(`${TOPIC_PREFIX}/`)) return null;

  const fullSuffix = topic.slice(TOPIC_PREFIX.length + 1);
  if (fullSuffix === "mahasiswa/templates/request") return "template/request";

  const parts = topic.split("/");
  if (parts.length < 3) return null;

  const suffix = parts.slice(2).join("/");

  if (suffix === "attendance") return "attendance";
  if (suffix === "ping") return "ping";
  if (suffix === "template/chunk") return "template/chunk";

  return null;
}

function isValidAttendance(p: unknown): p is AttendancePayload {
  if (!p || typeof p !== "object") return false;
  const o = p as Record<string, unknown>;
  return (
    typeof o.device_id === "string" &&
    typeof o.fingerprint_id === "number" &&
    (o.action === "check_in" || o.action === "check_out") &&
    typeof o.match_score === "number"
  );
}

function isValidPing(p: unknown): p is PingPayload {
  if (!p || typeof p !== "object") return false;
  const o = p as Record<string, unknown>;
  return typeof o.device_id === "string";
}

function isValidChunk(p: unknown): p is TemplateChunkPayload {
  if (!p || typeof p !== "object") return false;
  const o = p as Record<string, unknown>;
  return (
    typeof o.device_id === "string" &&
    typeof o.student_id === "string" &&
    typeof o.slot === "number" &&
    typeof o.chunk_index === "number" &&
    typeof o.total_chunks === "number" &&
    typeof o.data === "string"
  );
}

function isValidTemplateSyncRequest(p: unknown): p is TemplateSyncRequestPayload {
  if (!p || typeof p !== "object") return false;
  const o = p as Record<string, unknown>;
  return typeof o.device_id === "string";
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

function chunkTemplate(template: string, chunkSize: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < template.length; i += chunkSize) {
    chunks.push(template.slice(i, i + chunkSize));
  }
  return chunks;
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

async function syncTemplateToDevice(
  client: MqttClient,
  deviceId: string
): Promise<void> {
  if (!TEMPLATE_SAMPLE) {
    console.warn(
      "[MQTT] TEMPLATE_SAMPLE kosong. Sync template dilewati untuk device:",
      deviceId
    );
    return;
  }

  const cacheKey = `mqtt:template-sync:${deviceId}`;
  const lastSync = await redis.get(cacheKey);
  if (lastSync) {
    debugLog("Template sync skipped (cached)", { device_id: deviceId });
    return;
  }

  const chunks = chunkTemplate(TEMPLATE_SAMPLE, TEMPLATE_SYNC_CHUNK_SIZE);
  if (chunks.length === 0) {
    console.warn(
      "[MQTT] TEMPLATE_SAMPLE menghasilkan 0 chunk. Sync dibatalkan.",
      { device_id: deviceId }
    );
    return;
  }

  const manifestTopic = `${SERVER_TOPIC_PREFIX}/${deviceId}/template/manifest`;
  const dataTopic = `${SERVER_TOPIC_PREFIX}/${deviceId}/template/data`;

  const manifestPayload = {
    device_id: deviceId,
    student_id: TEMPLATE_SYNC_STUDENT_ID,
    slot: TEMPLATE_SYNC_SLOT,
    chunk_size: TEMPLATE_SYNC_CHUNK_SIZE,
    total_chunks: chunks.length,
    total_size: TEMPLATE_SAMPLE.length,
    source: "env",
    sent_at: new Date().toISOString(),
  };

  await publishAsync(client, manifestTopic, manifestPayload);

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    const payload = {
      device_id: deviceId,
      student_id: TEMPLATE_SYNC_STUDENT_ID,
      slot: TEMPLATE_SYNC_SLOT,
      chunk_index: chunkIndex,
      total_chunks: chunks.length,
      data: chunks[chunkIndex],
    };

    await publishAsync(client, dataTopic, payload);
  }

  await redis.set(
    cacheKey,
    new Date().toISOString(),
    "EX",
    TEMPLATE_SYNC_TTL_SECONDS
  );

  console.log(
    `[MQTT] Template sync sent to ${deviceId} (${chunks.length} chunks)`
  );
  debugLog("Template sync completed", {
    device_id: deviceId,
    total_chunks: chunks.length,
    total_size: TEMPLATE_SAMPLE.length,
  });
}

async function handleAttendance(payload: AttendancePayload) {
  const fingerprint = await prisma.studentFingerprint.findFirst({
    where: { fingerprintIdOnDevice: payload.fingerprint_id },
  });

  const action = payload.action === "check_in" ? "CHECK_IN" : "CHECK_OUT";

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
      matchScore: payload.match_score,
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

async function handleTemplateChunk(payload: TemplateChunkPayload) {
  const bufferKey = `${payload.device_id}:${payload.student_id}:${payload.slot}`;

  let buffer = chunkBuffers.get(bufferKey);
  if (!buffer) {
    buffer = {
      total: payload.total_chunks,
      received: new Map(),
      timestamp: Date.now(),
    };
    chunkBuffers.set(bufferKey, buffer);

    debugLog("Created template chunk buffer", {
      buffer_key: bufferKey,
      total_chunks: payload.total_chunks,
    });
  }

  buffer.received.set(payload.chunk_index, payload.data);
  buffer.timestamp = Date.now();

  if (buffer.received.size === buffer.total) {
    const chunks: string[] = [];
    for (let i = 0; i < buffer.total; i++) {
      const chunk = buffer.received.get(i);
      if (!chunk) {
        console.error(`[MQTT] Missing chunk ${i} for ${bufferKey}`);
        chunkBuffers.delete(bufferKey);
        return;
      }
      chunks.push(chunk);
    }

    const fullTemplate = chunks.join("");
    const { encrypted, iv, tag } = await encryptTemplate(fullTemplate);

    await prisma.studentFingerprint.upsert({
      where: {
        studentId_slot: {
          studentId: payload.student_id,
          slot: payload.slot,
        },
      },
      update: {
        templateEnc: encrypted,
        encryptionIv: iv,
        encryptionTag: tag,
        fingerprintIdOnDevice: null,
      },
      create: {
        studentId: payload.student_id,
        slot: payload.slot,
        templateEnc: encrypted,
        encryptionIv: iv,
        encryptionTag: tag,
      },
    });

    chunkBuffers.delete(bufferKey);
    console.log(
      `[MQTT] Template stored: student=${payload.student_id} slot=${payload.slot} (${buffer.total} chunks)`
    );

    debugLog("Template chunk handler completed", {
      ...summarizeTemplateChunkPayload(payload),
      reassembled_chunks: buffer.total,
    });
  } else {
    console.log(
      `[MQTT] Chunk ${payload.chunk_index + 1}/${buffer.total} for ${bufferKey}`
    );

    debugLog("Template chunk buffered", {
      ...summarizeTemplateChunkPayload(payload),
      received_chunks: buffer.received.size,
    });
  }
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
    TOPICS.TEMPLATE_CHUNK,
    TOPICS.TEMPLATE_REQUEST,
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
      const payload = parseJsonPayload(message);

      if (!route || payload === null) {
        debugLog("Ignoring message with unknown topic/payload", {
          topic,
          route,
          payload_shape: describePayloadShape(payload),
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
        await syncTemplateToDevice(client, payload.device_id);
        return;
      }

      if (route === "template/chunk") {
        if (!isValidChunk(payload)) {
          debugLog("Invalid template chunk payload", {
            topic,
            payload_shape: describePayloadShape(payload),
          });
          return;
        }
        await handleTemplateChunk(payload);
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

export function getMqttServerTopic(deviceId: string, suffix: string) {
  return `${SERVER_TOPIC_PREFIX}/${deviceId}/${suffix}`;
}
