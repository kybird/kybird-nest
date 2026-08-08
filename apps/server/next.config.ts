import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 는 네이티브 모듈이라 번들에 넣으면 깨진다.
  // Prisma 도 런타임에 생성물을 찾아야 하므로 번들 밖에 둔다.
  serverExternalPackages: ["better-sqlite3", "@prisma/adapter-better-sqlite3"],
};

export default nextConfig;
