import { Elysia, t } from "elysia";
import { swagger } from "@elysiajs/swagger";
import { prisma } from "./lib/prisma";
import { jwtPlugin } from "./middleware/auth";
import { facultyRoutes } from "./modules/faculties/faculties.route";
import { departmentRoutes } from "./modules/departments/departments.route";
import { studentRoutes } from "./modules/students/students.route";
import { lecturerRoutes } from "./modules/lecturers/lecturers.route";
import { courseRoutes } from "./modules/courses/courses.route";
import { courseClassRoutes } from "./modules/course-classes/course-classes.route";
import { userRoutes } from "./modules/users/users.route";
import { scheduleRoutes } from "./modules/schedules/schedules.route";
import { deviceRoutes } from "./modules/devices/devices.route";
import { attendanceRoutes } from "./modules/attendance/attendance.route";
import { attendanceRecordRoutes } from "./modules/attendance/attendance-records.route";
import { classRoutes } from "./modules/classes/classes.route";
import { registrationRoutes } from "./modules/registration/registration.route";
import { semesterRoutes } from "./modules/semesters/semesters.route";
import { siaSyncRoutes } from "./modules/sia-sync/sia-sync.route";

function buildAuthCookie(token: string) {
  const maxAgeSeconds = 60 * 60 * 24;
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";

  return `auth_token=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${secure}`;
}

export function createApp() {
  return new Elysia()
    .use(swagger({
      provider: "swagger-ui",
      path: "/swagger",
      documentation: {
        info: {
          title: "Bio-eSign University Attendance API",
          version: "1.0.0",
          description: "API untuk manajemen fakultas, departemen, kelas, device, registrasi sidik jari, dan presensi Bio-eSign.",
        },
        servers: [
          {
            url: "http://localhost:3000",
            description: "Local development",
          },
        ],
        components: {
          securitySchemes: {
            bearerAuth: {
              type: "http",
              scheme: "bearer",
              bearerFormat: "JWT",
            },
            cookieAuth: {
              type: "apiKey",
              in: "cookie",
              name: "auth_token",
            },
          },
        },
        security: [{ bearerAuth: [] }, { cookieAuth: [] }],
        tags: [
          { name: "Auth", description: "Login dan token JWT" },
          { name: "Faculties" },
          { name: "Departments" },
          { name: "Classes" },
          { name: "Devices" },
          { name: "Students" },
          { name: "Lecturers" },
          { name: "Courses" },
          { name: "Course Classes" },
          { name: "Semesters" },
          { name: "Schedules" },
          { name: "Attendance" },
          { name: "SIA Sync" },
          { name: "Fingerprint Registrations" },
          { name: "Users" },
        ],
      },
    }))
    .use(jwtPlugin)
    .get("/", () => ({
      message: "Bio-eSign University Attendance API",
      status: "online",
      version: "1.0.0",
    }))
    .group("/api", (app) =>
      app
        .post("/auth/sessions", async ({ jwt, body, set }) => {
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

          set.headers["Set-Cookie"] = buildAuthCookie(token);

          return {
            token,
            message: "Login success. Swagger requests on this origin can use the auth_token cookie automatically.",
            user: {
              id: user.id,
              username: user.username,
              email: user.email,
              role: user.role,
            },
          };
        }, {
          detail: {
            tags: ["Auth"],
            summary: "Login untuk mendapatkan JWT token",
            security: [],
          },
          body: t.Object({
            username: t.String(),
            password: t.String(),
          }),
        })
        .use(facultyRoutes)
        .use(departmentRoutes)
        .use(studentRoutes)
        .use(lecturerRoutes)
        .use(courseRoutes)
        .use(courseClassRoutes)
        .use(semesterRoutes)
        .use(userRoutes)
        .use(scheduleRoutes)
        .use(deviceRoutes)
        .use(classRoutes)
        .use(registrationRoutes)
        .use(siaSyncRoutes)
        .use(attendanceRecordRoutes)
        .use(attendanceRoutes)
    );
}

export type BioESignApp = ReturnType<typeof createApp>;
