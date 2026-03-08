import mqtt, { type IPublishPacket } from "mqtt";
import { prisma } from "./prisma";
import { redis } from "./redis";
import { encryptTemplate } from "./crypto";

// MQTT topic definitions
// bioesign/{deviceId}/attendance -> ESP32 reports check-in/check-out
// bioesign/{deviceId}/ping -> ESP32 heartbeat
// bioesign/{deviceId}/template/chunk -> ESP32 sends template chunks
// bioesign/server/{deviceId}/template/manifest -> Server sends manifest to device
// bioesign/server/{deviceId}/template/data -> Server sends template chunks to device

const TOPICS = {
  ATTENDANCE: "bioesign/+/attendance",
  DEVICE_PING: "bioesign/+/ping",
  TEMPLATE_CHUNK: "bioesign/+/template/chunk",
} as const;

const TOPIC_PATTERNS = {
  ATTENDANCE: /^bioesign\/[^/]+\/attendance$/,
  DEVICE_PING: /^bioesign\/[^/]+\/ping$/,
  TEMPLATE_CHUNK: /^bioesign\/[^/]+\/template\/chunk$/,
} as const;

const MQTT_DEBUG = (process.env.MQTT_DEBUG ?? "").toLowerCase() === "true";
const SUBSCRIBE_QOS = 1;

type TopicRoute = "attendance" | "ping" | "template/chunk";

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
  if (TOPIC_PATTERNS.ATTENDANCE.test(topic)) return "attendance";
  if (TOPIC_PATTERNS.DEVICE_PING.test(topic)) return "ping";
  if (TOPIC_PATTERNS.TEMPLATE_CHUNK.test(topic)) return "template/chunk";
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

function extractDeviceId(topic: string): string | null {
  const parts = topic.split("/");
  return parts.length >= 2 ? parts[1] : null;
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
      deviceId: device.deviceId,
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

export function startMqttSubscriber() {
  const brokerUrl = process.env.MQTT_BROKER_URL || "mqtt://localhost:1883";
  const clientId = `bioesign-server-${Date.now()}`;
  const topics = Object.values(TOPICS);

  debugLog("Starting MQTT subscriber", {
    broker_url: brokerUrl,
    client_id: clientId,
    topics,
    debug_enabled: MQTT_DEBUG,
  });

  const client = mqtt.connect(brokerUrl, {
    clientId,
    clean: true,
    reconnectPeriod: 5000,
  });

  client.on("connect", () => {
    console.log(`[MQTT] Connected to broker: ${brokerUrl}`);
    debugLog("Broker connection established", {
      broker_url: brokerUrl,
      client_id: clientId,
    });

    client.subscribe(topics, { qos: SUBSCRIBE_QOS }, (err, granted) => {
      if (err) {
        console.error("[MQTT] Subscribe error:", err);
        return;
      }

      console.log("[MQTT] Subscribed to:", topics.join(", "));
      debugLog("Subscribe acknowledged", {
        requested_topics: topics,
        granted:
          granted?.map((entry) => ({
            topic: entry.topic,
            qos: entry.qos,
          })) ?? [],
      });
    });
  });

  client.on(
    "message",
    async (topic: string, message: Buffer, packet: IPublishPacket) => {
      const deviceId = extractDeviceId(topic);
      const envelope = {
        topic,
        device_id: deviceId,
        payload_bytes: message.length,
        ...getPacketMetadata(packet),
      };

      debugLog("MQTT message received", envelope);

      let payload: unknown;
      try {
        payload = JSON.parse(message.toString());
      } catch {
        console.error(`[MQTT] Invalid JSON on topic ${topic}`);
        debugLog("MQTT payload JSON parsing failed", envelope);
        return;
      }

      const route = resolveTopicRoute(topic);
      if (!route) {
        console.warn(`[MQTT] No handler registered for topic ${topic}`);
        debugLog("MQTT message ignored because no route matched", envelope);
        return;
      }

      debugLog("Dispatching MQTT message", {
        ...envelope,
        route,
      });

      try {
        if (route === "attendance") {
          if (!isValidAttendance(payload)) {
            console.error("[MQTT] Invalid attendance payload");
            debugLog("Attendance payload validation failed", {
              ...envelope,
              ...describePayloadShape(payload),
            });
            return;
          }

          debugLog("Attendance payload accepted", summarizeAttendancePayload(payload));
          await handleAttendance(payload);
          return;
        }

        if (route === "ping") {
          if (!isValidPing(payload)) {
            console.error("[MQTT] Invalid ping payload");
            debugLog("Ping payload validation failed", {
              ...envelope,
              ...describePayloadShape(payload),
            });
            return;
          }

          debugLog("Ping payload accepted", summarizePingPayload(payload));
          await handleDevicePing(payload);
          return;
        }

        if (!isValidChunk(payload)) {
          console.error("[MQTT] Invalid template chunk payload");
          debugLog("Template chunk payload validation failed", {
            ...envelope,
            ...describePayloadShape(payload),
          });
          return;
        }

        debugLog(
          "Template chunk payload accepted",
          summarizeTemplateChunkPayload(payload)
        );
        await handleTemplateChunk(payload);
      } catch (error) {
        console.error(`[MQTT] Handler error on ${topic}:`, error);
      }
    }
  );

  client.on("error", (err) => {
    console.error("[MQTT] Connection error:", err);
  });

  client.on("reconnect", () => {
    console.log("[MQTT] Reconnecting...");
    debugLog("MQTT reconnect scheduled", {
      broker_url: brokerUrl,
      client_id: clientId,
    });
  });

  return client;
}
