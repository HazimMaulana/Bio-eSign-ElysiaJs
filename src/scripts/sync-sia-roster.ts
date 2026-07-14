import { prisma } from "../lib/prisma";
import { syncSiaRoster } from "../modules/sia-sync/sia-roster.service";

try {
  const result = await syncSiaRoster();
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error("[SIA] Roster sync failed:", error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
