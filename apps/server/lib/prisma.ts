import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "./generated/prisma/client";

// dev 에서 핫리로드가 돌 때마다 새 클라이언트를 만들면 커넥션이 샌다.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function create(): PrismaClient {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL 이 설정되지 않았다");
  return new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
}

export const prisma: PrismaClient = globalForPrisma.prisma ?? create();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
