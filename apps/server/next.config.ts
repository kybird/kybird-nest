import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 는 네이티브 모듈이라 번들에 넣으면 깨진다.
  // Prisma 도 런타임에 생성물을 찾아야 하므로 번들 밖에 둔다.
  serverExternalPackages: ["better-sqlite3", "@prisma/adapter-better-sqlite3"],

  // 컨테이너에 node_modules 를 통째로 넣지 않기 위해 필요한 것만 추린다.
  // 모노레포라 루트를 알려줘야 워크스페이스 패키지까지 같이 딸려온다.
  output: "standalone",
  // pathname 을 그대로 쓰면 Windows 에서 "/D:/..." 가 되어 깨진다.
  outputFileTracingRoot: fileURLToPath(new URL("../../", import.meta.url)),
};

export default nextConfig;
