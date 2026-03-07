import { Elysia, t } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { prisma } from "./lib/prisma";
import { encryptTemplate, decryptTemplate } from "./lib/crypto";

const app = new Elysia()
  .use(
    jwt({
      name: 'jwt',
      secret: process.env.JWT_SECRET || 'super-secret-key-for-university-bioesign'
    })
  )
  .get("/", () => ({
    message: "Bio-eSign University Attendance API",
    status: "online",
    version: "1.0.0"
  }))
  .group("/api", (app) => 
    app
      .post("/auth/login", async ({ jwt, body }) => {
        // Simple mock login for now - you can integrate with User model later
        const token = await jwt.sign({
          sub: body.nim,
          role: 'ADMIN'
        });
        return { token };
      }, {
        body: t.Object({
          nim: t.String(),
          password: t.String()
        })
      })
      .group("/attendance", (app) => 
        app
          .onBeforeHandle(async ({ jwt, set, headers }) => {
            const auth = headers.authorization;
            if (!auth || !auth.startsWith('Bearer ')) {
              set.status = 401;
              return "Unauthorized";
            }
            const token = auth.split(' ')[1];
            const profile = await jwt.verify(token);
            if (!profile) {
              set.status = 401;
              return "Invalid Token";
            }
          })
          .get("/history", async () => {
            return await prisma.attendance.findMany({
              take: 10,
              orderBy: { timestamp: 'desc' }
            });
          })
          .post("/record", async ({ body }) => {
            // This is where MQTT data or Device API data would hit
            return await prisma.attendance.create({
              data: {
                userId: body.userId,
                location: body.location,
                deviceId: body.deviceId
              }
            });
          }, {
            body: t.Object({
              userId: t.String(),
              location: t.String(),
              deviceId: t.String()
            })
          })
      )
  )
  .listen(3000);

console.log(
  `🦊 Bio-eSign is running at ${app.server?.hostname}:${app.server?.port}`
);
