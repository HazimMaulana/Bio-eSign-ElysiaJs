import { Elysia, t } from "elysia";
import { prisma } from "./lib/prisma";
import { startMqttSubscriber } from "./lib/mqtt";
import { jwtPlugin } from "./middleware/auth";
import { departmentRoutes } from "./modules/departments/departments.route";
import { studentRoutes } from "./modules/students/students.route";
import { lecturerRoutes } from "./modules/lecturers/lecturers.route";
import { courseRoutes } from "./modules/courses/courses.route";
import { userRoutes } from "./modules/users/users.route";
import { scheduleRoutes } from "./modules/schedules/schedules.route";
import { deviceRoutes } from "./modules/devices/devices.route";
import { attendanceRoutes } from "./modules/attendance/attendance.route";
import { classRoutes } from "./modules/classes/classes.route";
import { registrationRoutes } from "./modules/registration/registration.route";

// ─── Start MQTT Subscriber ─────────────────────────────
startMqttSubscriber();

const app = new Elysia()
  .use(jwtPlugin)
  .get("/", () => ({
    message: "Bio-eSign University Attendance API",
    status: "online",
    version: "1.0.0",
  }))
  .group("/api", (app) =>
    app
      // ─── Auth ─────────────────────────────────────────
      .post("/auth/login", async ({ jwt, body, set }) => {
        const user = await prisma.user.findUnique({
          where: { username: body.username },
        });
        if (!user) {
          set.status = 401;
          return { error: "Invalid credentials" };
        }
        if (!user.isActive) {
          set.status = 403;
          return { error: "Account is deactivated" };
        }
        const valid = await Bun.password.verify(body.password, user.passwordHash);
        if (!valid) {
          set.status = 401;
          return { error: "Invalid credentials" };
        }
        const token = await jwt.sign({
          sub: user.username,
          role: user.role,
        });
        return {
          token,
          user: {
            id: user.id,
            username: user.username,
            email: user.email,
            role: user.role,
          },
        };
      }, {
        body: t.Object({
          username: t.String(),
          password: t.String(),
        }),
      })
      // ─── Resource Routes ──────────────────────────────
      .use(departmentRoutes)
      .use(studentRoutes)
      .use(lecturerRoutes)
      .use(courseRoutes)
      .use(userRoutes)
      .use(scheduleRoutes)
      .use(deviceRoutes)
      .use(classRoutes)
      .use(registrationRoutes)
      .use(attendanceRoutes)
  )
  .listen(3000);

console.log(
  `🦊 Bio-eSign is running at ${app.server?.hostname}:${app.server?.port}`
);
