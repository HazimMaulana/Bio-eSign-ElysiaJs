import mqtt, { type IClientPublishOptions, type MqttClient } from "mqtt";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

type CliOptions = {
  quantity: number;
  concurrency: number;
  chunkSize: number;
  deviceId: string;
  topicPrefix: string;
  retain: boolean;
  slotCycle: number;
  template: string;
};

function printUsage() {
  console.log("MQTT Template Upload Load Test");
  console.log("");
  console.log("Usage:");
  console.log("  bun run loadtest:mqtt-template -- <quantity> [options]");
  console.log("  bun run loadtest:mqtt-template -- --quantity 500 [options]");
  console.log("");
  console.log("Options:");
  console.log("  --quantity <n>         Jumlah template mahasiswa (default: 100)");
  console.log("  --concurrency <n>      Jumlah worker paralel (default: 20)");
  console.log("  --chunk-size <n>       Panjang karakter per chunk (default: 512)");
  console.log("  --device-id <id>       Device ID untuk topic MQTT");
  console.log("  --topic-prefix <text>  Prefix topic MQTT (default: presence)");
  console.log("  --retain               Publish sebagai retained message");
  console.log("  --slot-cycle <n>       Siklus slot fingerprint (default: 5)");
  console.log("  --template <base64>    Template sidik jari sample");
  console.log("  --template-file <path> File berisi template sidik jari sample");
  console.log("  --help                 Tampilkan bantuan");
  console.log("");
  console.log("Template fallback:");
  console.log("  Prioritas: --template > --template-file > TEMPLATE_SAMPLE (.env)");
}

type BenchmarkStats = {
  totalMessages: number;
  totalTemplates: number;
  publishLatenciesMs: number[];
  templateDurationsMs: number[];
};

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;

  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function applyDotEnvContent(content: string) {
  const lines = content.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const cleanLine = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separatorIndex = cleanLine.indexOf("=");
    if (separatorIndex <= 0) continue;

    const key = cleanLine.slice(0, separatorIndex).trim();
    const value = stripWrappingQuotes(cleanLine.slice(separatorIndex + 1));

    if (!key) continue;
    if (process.env[key] !== undefined) continue;

    process.env[key] = value;
  }
}

function findNearestEnvFile(startDir: string): string | null {
  let currentDir = resolve(startDir);

  while (true) {
    const candidate = join(currentDir, ".env");
    if (existsSync(candidate)) return candidate;

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }

  return null;
}

function ensureDotEnvLoaded(): void {
  const searchRoots = [
    process.cwd(),
    import.meta.dir,
    resolve(import.meta.dir, ".."),
    resolve(import.meta.dir, "../.."),
  ];

  const visited = new Set<string>();

  for (const root of searchRoots) {
    const normalized = resolve(root);
    if (visited.has(normalized)) continue;
    visited.add(normalized);

    const envFilePath = findNearestEnvFile(normalized);
    if (!envFilePath) continue;

    const content = readFileSync(envFilePath, "utf8");
    applyDotEnvContent(content);
    return;
  }
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function hasFlag(args: string[], name: string): boolean {
  const exact = `--${name}`;
  return args.includes(exact);
}

function getArgValue(args: string[], name: string): string | undefined {
  const exact = `--${name}`;
  const prefixed = `--${name}=`;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === exact) return args[i + 1];
    if (arg.startsWith(prefixed)) return arg.slice(prefixed.length);
  }

  return undefined;
}

function parseCliOptions(args: string[]): CliOptions {
  const positionalQuantity = args.find((arg) => !arg.startsWith("--"));

  const quantity = parseNumber(
    getArgValue(args, "quantity") ?? positionalQuantity,
    100
  );

  const concurrency = parseNumber(getArgValue(args, "concurrency"), 20);
  const chunkSize = parseNumber(getArgValue(args, "chunk-size"), 512);
  const slotCycle = parseNumber(getArgValue(args, "slot-cycle"), 5);

  const deviceId = getArgValue(args, "device-id") ?? "esp32-loadtest-01";
  const topicPrefix = getArgValue(args, "topic-prefix") ?? "presence";
  const retain = hasFlag(args, "retain");
  const templateFromArg = getArgValue(args, "template");
  const templateFilePath = getArgValue(args, "template-file");

  let templateFromFile: string | undefined;
  if (templateFilePath) {
    templateFromFile = readFileSync(templateFilePath, "utf8").trim();
  }

  const template = templateFromArg ?? templateFromFile ?? process.env.TEMPLATE_SAMPLE ?? "";

  if (!template) {
    throw new Error(
      "Template kosong. Isi lewat --template '<base64>', --template-file <path>, atau set TEMPLATE_SAMPLE di .env"
    );
  }

  return {
    quantity,
    concurrency,
    chunkSize,
    deviceId,
    topicPrefix,
    retain,
    slotCycle,
    template,
  };
}

function chunkTemplate(template: string, chunkSize: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < template.length; i += chunkSize) {
    chunks.push(template.slice(i, i + chunkSize));
  }
  return chunks;
}

function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedValues.length) - 1)
  );
  return sortedValues[index] ?? 0;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  const total = values.reduce((sum, value) => sum + value, 0);
  return total / values.length;
}

function createMqttClient(): Promise<MqttClient> {
  const brokerUrl = process.env.MQTT_URL;
  const username = process.env.MQTT_USERNAME;
  const password = process.env.MQTT_PASSWORD;

  if (!brokerUrl) throw new Error("MQTT_URL is required");
  if (!username) throw new Error("MQTT_USERNAME is required");
  if (!password) throw new Error("MQTT_PASSWORD is required");

  const client = mqtt.connect(brokerUrl, {
    clientId: `bioesign-loadtest-${Date.now()}`,
    username,
    password,
    clean: true,
    reconnectPeriod: 0,
    connectTimeout: 10_000,
  });

  return new Promise<MqttClient>((resolve, reject) => {
    const cleanup = () => {
      client.off("connect", onConnect);
      client.off("error", onError);
    };

    const onConnect = () => {
      cleanup();
      resolve(client);
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    client.once("connect", onConnect);
    client.once("error", onError);
  });
}

function publishAsync(
  client: MqttClient,
  topic: string,
  payload: unknown,
  options: IClientPublishOptions
): Promise<number> {
  const message = JSON.stringify(payload);

  return new Promise<number>((resolve, reject) => {
    const startedAt = performance.now();

    client.publish(topic, message, options, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(performance.now() - startedAt);
    });
  });
}

async function publishTemplateForStudent(
  client: MqttClient,
  options: CliOptions,
  studentIndex: number,
  chunks: string[],
  stats: BenchmarkStats
): Promise<void> {
  const startedAt = performance.now();
  const topic = `${options.topicPrefix}/${options.deviceId}/template/chunk`;
  const studentId = `loadtest-student-${String(studentIndex + 1).padStart(6, "0")}`;
  const slot = (studentIndex % options.slotCycle) + 1;

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    const payload = {
      device_id: options.deviceId,
      student_id: studentId,
      slot,
      chunk_index: chunkIndex,
      total_chunks: chunks.length,
      data: chunks[chunkIndex],
    };

    const latencyMs = await publishAsync(client, topic, payload, {
      qos: 1,
      retain: options.retain,
    });
    stats.publishLatenciesMs.push(latencyMs);
    stats.totalMessages += 1;
  }

  stats.templateDurationsMs.push(performance.now() - startedAt);
  stats.totalTemplates += 1;
}

async function runWithConcurrency(
  quantity: number,
  concurrency: number,
  worker: (index: number) => Promise<void>
): Promise<void> {
  let cursor = 0;

  const workers = Array.from(
    { length: Math.min(concurrency, quantity) },
    async () => {
      while (true) {
        const index = cursor;
        cursor += 1;

        if (index >= quantity) return;

        await worker(index);
      }
    }
  );

  await Promise.all(workers);
}

function printReport(
  options: CliOptions,
  stats: BenchmarkStats,
  totalDurationMs: number
) {
  const publishSorted = [...stats.publishLatenciesMs].sort((a, b) => a - b);
  const templateSorted = [...stats.templateDurationsMs].sort((a, b) => a - b);

  const templatesPerSecond = stats.totalTemplates / (totalDurationMs / 1000);
  const messagesPerSecond = stats.totalMessages / (totalDurationMs / 1000);

  console.log("\n=== MQTT Template Upload Load Test ===");
  console.log(`quantity            : ${options.quantity} templates`);
  console.log(`concurrency         : ${options.concurrency}`);
  console.log(`chunk size          : ${options.chunkSize} chars`);
  console.log(`retain              : ${options.retain}`);
  console.log(`chunks/template     : ${chunkTemplate(options.template, options.chunkSize).length}`);
  console.log(`total messages      : ${stats.totalMessages}`);
  console.log(`total duration      : ${totalDurationMs.toFixed(2)} ms`);
  console.log(`throughput template : ${templatesPerSecond.toFixed(2)} template/s`);
  console.log(`throughput message  : ${messagesPerSecond.toFixed(2)} msg/s`);

  console.log("\nPublish latency (per chunk, qos=1 ack)");
  console.log(`avg                 : ${average(publishSorted).toFixed(2)} ms`);
  console.log(`p95                 : ${percentile(publishSorted, 95).toFixed(2)} ms`);
  console.log(`p99                 : ${percentile(publishSorted, 99).toFixed(2)} ms`);
  console.log(`max                 : ${(publishSorted[publishSorted.length - 1] ?? 0).toFixed(2)} ms`);

  console.log("\nTemplate duration (all chunks/template)");
  console.log(`avg                 : ${average(templateSorted).toFixed(2)} ms`);
  console.log(`p95                 : ${percentile(templateSorted, 95).toFixed(2)} ms`);
  console.log(`p99                 : ${percentile(templateSorted, 99).toFixed(2)} ms`);
  console.log(`max                 : ${(templateSorted[templateSorted.length - 1] ?? 0).toFixed(2)} ms`);
}

async function main() {
  ensureDotEnvLoaded();

  const args = Bun.argv.slice(2);

  if (args.includes("--help")) {
    printUsage();
    return;
  }

  const options = parseCliOptions(args);

  const chunks = chunkTemplate(options.template, options.chunkSize);

  if (chunks.length === 0) {
    throw new Error("Template menghasilkan 0 chunk. Pastikan template tidak kosong.");
  }

  const client = await createMqttClient();

  const stats: BenchmarkStats = {
    totalMessages: 0,
    totalTemplates: 0,
    publishLatenciesMs: [],
    templateDurationsMs: [],
  };

  console.log("Starting MQTT template upload load test...");
  console.log(`Target topic: ${options.topicPrefix}/${options.deviceId}/template/chunk`);

  const startedAt = performance.now();

  try {
    await runWithConcurrency(options.quantity, options.concurrency, (index) =>
      publishTemplateForStudent(client, options, index, chunks, stats)
    );
  } finally {
    client.end(true);
  }

  const totalDurationMs = performance.now() - startedAt;
  printReport(options, stats, totalDurationMs);
}

main().catch((error) => {
  console.error("Load test failed:", error);
  process.exit(1);
});
