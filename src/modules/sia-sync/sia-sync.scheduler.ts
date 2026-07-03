import { syncSiaSchedules } from "./sia-sync.service";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function getNextSixAmDelay(now = new Date()) {
  const next = new Date(now);
  next.setHours(6, 0, 0, 0);

  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }

  return next.getTime() - now.getTime();
}

async function runScheduledSiaSync() {
  try {
    const result = await syncSiaSchedules();
    console.log("[SIA] Scheduled sync completed:", result);
  } catch (error) {
    console.error("[SIA] Scheduled sync failed:", error);
  }
}

export function startSiaDailySyncScheduler() {
  if ((process.env.SIA_SYNC_ENABLED ?? "true").toLowerCase() === "false") {
    console.log("[SIA] Daily sync scheduler disabled");
    return;
  }

  const delayMs = getNextSixAmDelay();
  console.log(`[SIA] Daily sync scheduled in ${Math.round(delayMs / 1000)}s`);

  setTimeout(() => {
    void runScheduledSiaSync();
    setInterval(() => void runScheduledSiaSync(), ONE_DAY_MS);
  }, delayMs);
}
