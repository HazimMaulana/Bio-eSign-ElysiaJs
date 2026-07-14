import { createApp } from "./app";
import { startMqttSubscriber } from "./lib/mqtt";
import { startSiaDailySyncScheduler } from "./modules/sia-sync/sia-sync.scheduler";
import { startScheduledMqttTemplateSync } from "./modules/sia-sync/sia-mqtt-template.scheduler";

startMqttSubscriber();
startSiaDailySyncScheduler();
startScheduledMqttTemplateSync();

const app = createApp().listen(3000);

console.log(
  `Bio-eSign is running at ${app.server?.hostname}:${app.server?.port}`
);
