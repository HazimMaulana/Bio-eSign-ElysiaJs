import { Elysia, t } from "elysia";
import { prisma } from "../../lib/prisma";
import { jwtPlugin, authGuard } from "../../middleware/auth";

function mapSemesterBody(body: {
  code?: string;
  name?: string;
  academic_year?: string | null;
  starts_at?: string | null;
  ends_at?: string | null;
}) {
  return {
    ...(body.code !== undefined ? { code: body.code } : {}),
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.academic_year !== undefined
      ? { academicYear: body.academic_year ?? null }
      : {}),
    ...(body.starts_at !== undefined
      ? { startsAt: body.starts_at === null ? null : new Date(body.starts_at) }
      : {}),
    ...(body.ends_at !== undefined
      ? { endsAt: body.ends_at === null ? null : new Date(body.ends_at) }
      : {}),
  };
}

export const semesterRoutes = new Elysia({
  prefix: "/semesters",
  tags: ["Semesters"],
})
  .use(jwtPlugin)
  .onBeforeHandle(authGuard)
  .get("/", async () => {
    return await prisma.semester.findMany({
      orderBy: { createdAt: "desc" },
      include: { courseClasses: true },
    });
  })
  .post("/", async ({ body, set }) => {
    const semester = await prisma.semester.create({
      data: mapSemesterBody(body) as {
        code: string;
        name: string;
        academicYear?: string | null;
        startsAt?: Date | null;
        endsAt?: Date | null;
      },
    });

    set.status = 201;
    return semester;
  }, {
    body: t.Object({
      code: t.String(),
      name: t.String(),
      academic_year: t.Optional(t.Union([t.String(), t.Null()])),
      starts_at: t.Optional(t.Union([t.String(), t.Null()])),
      ends_at: t.Optional(t.Union([t.String(), t.Null()])),
    }),
  })
  .get("/:code", async ({ params, set }) => {
    const semester = await prisma.semester.findUnique({
      where: { code: params.code },
      include: { courseClasses: true },
    });

    if (!semester) {
      set.status = 404;
      return { error: "Semester not found" };
    }

    return semester;
  }, {
    params: t.Object({ code: t.String() }),
  })
  .put("/:code", async ({ params, body, set }) => {
    const existing = await prisma.semester.findUnique({
      where: { code: params.code },
      select: { id: true },
    });

    if (!existing) {
      set.status = 404;
      return { error: "Semester not found" };
    }

    return await prisma.semester.update({
      where: { id: existing.id },
      data: mapSemesterBody(body),
    });
  }, {
    params: t.Object({ code: t.String() }),
    body: t.Object({
      code: t.Optional(t.String()),
      name: t.Optional(t.String()),
      academic_year: t.Optional(t.Union([t.String(), t.Null()])),
      starts_at: t.Optional(t.Union([t.String(), t.Null()])),
      ends_at: t.Optional(t.Union([t.String(), t.Null()])),
    }),
  })
  .delete("/:code", async ({ params, set }) => {
    const existing = await prisma.semester.findUnique({
      where: { code: params.code },
      select: { id: true },
    });

    if (!existing) {
      set.status = 404;
      return { error: "Semester not found" };
    }

    await prisma.semester.delete({ where: { id: existing.id } });
    return { message: "Semester deleted" };
  }, {
    params: t.Object({ code: t.String() }),
  });
