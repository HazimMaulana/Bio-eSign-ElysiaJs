import "dotenv/config";
import { prisma } from "../lib/prisma";

const VALID_ROLES = ["SUPERADMIN", "FACULTY_ADMIN", "LECTURER", "STUDENT"] as const;

type UserRole = (typeof VALID_ROLES)[number];

const requireEnv = (key: string) => {
  const value = process.env[key]?.trim();
  if (!value) {
    throw new Error(`${key} is required`);
  }
  return value;
};

const getAdminRole = (): UserRole => {
  const role = process.env.ADMIN_ROLE?.trim() || "SUPERADMIN";
  if (!VALID_ROLES.includes(role as UserRole)) {
    throw new Error(`ADMIN_ROLE must be one of: ${VALID_ROLES.join(", ")}`);
  }
  return role as UserRole;
};

const username = requireEnv("ADMIN_USERNAME");
const password = requireEnv("ADMIN_PASSWORD");
const email = requireEnv("ADMIN_EMAIL");
const role = getAdminRole();

if (password.length < 12) {
  throw new Error("ADMIN_PASSWORD must be at least 12 characters long");
}

try {
  const passwordHash = await Bun.password.hash(password);

  const user = await prisma.user.upsert({
    where: { username },
    update: {
      passwordHash,
      email,
      role,
      isActive: true,
    },
    create: {
      username,
      passwordHash,
      email,
      role,
      isActive: true,
    },
    select: {
      id: true,
      username: true,
      email: true,
      role: true,
      isActive: true,
    },
  });

  console.log(`Admin user is ready: ${user.username} (${user.role})`);
} finally {
  await prisma.$disconnect();
}
