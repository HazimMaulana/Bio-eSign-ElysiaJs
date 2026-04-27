import Redis from "ioredis";

const globalForRedis = globalThis as unknown as { redis?: Redis };

function parseBooleanEnv(value: string | undefined) {
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

const redisEnabled = parseBooleanEnv(process.env.REDIS_ENABLED);

function createDisabledRedis() {
  const noop = async () => undefined;

  return {
    status: "end",
    get: async () => null,
    set: async () => "OK",
    keys: async () => [],
    quit: noop,
    disconnect: () => undefined,
    ping: async () => "PONG",
  } as unknown as Redis;
}

export const redis = redisEnabled
  ? globalForRedis.redis || new Redis(process.env.REDIS_URL || "redis://127.0.0.1:6379")
  : createDisabledRedis();

if (redisEnabled && process.env.NODE_ENV !== "production") globalForRedis.redis = redis;

export { redisEnabled };
