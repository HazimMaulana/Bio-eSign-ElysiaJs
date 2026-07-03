import { prisma } from "../lib/prisma";
import { syncSiaSchedules } from "../modules/sia-sync/sia-sync.service";

const forceDummy = process.argv.includes("--dummy");

try {
  const result = await syncSiaSchedules({ forceDummy });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error("[SIA] Sync failed:", error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
