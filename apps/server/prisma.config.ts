import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  // 마이그레이션/인트로스펙션 CLI 가 쓰는 접속 정보.
  // 런타임 접속은 lib/prisma.ts 에서 드라이버 어댑터로 따로 만든다.
  datasource: {
    url: process.env["DATABASE_URL"],
  },
});
