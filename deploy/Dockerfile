# kybird-nest 서버 이미지
#
# 클라이언트(임베딩·검색)는 여기 들어가지 않는다. apps/server 는 @kybird/core 를
# 의존하지 않아서 transformers·onnxruntime·모델 파일이 통째로 빠진다.
# 서버에 필요한 건 next, react, prisma, better-sqlite3 뿐이다.
#
# 대상은 linux/arm64 (Oracle Ampere A1). 다른 아키텍처면 --platform 을 바꿔라.

# ---- 1) 의존성 ----
FROM node:22-bookworm-slim AS deps
WORKDIR /app

# better-sqlite3 는 네이티브 모듈이다. 프리빌드가 없는 아키텍처에서는
# 여기서 컴파일된다. 빌드 스테이지에만 두고 최종 이미지에는 넣지 않는다.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# 워크스페이스 매니페스트를 먼저 복사한다. 소스가 바뀌어도
# 의존성 레이어는 캐시에서 재사용된다.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY packages/cli/package.json packages/cli/
COPY apps/server/package.json apps/server/

# 서버에 필요 없는 워크스페이스는 아예 설치하지 않는다.
#
# core 를 빼는 게 핵심이다 — transformers 트리(sharp, onnxruntime, adm-zip)가
# 통째로 사라진다. 이미지가 작아지는 것도 있지만, onnxruntime 은 arm64 프리빌드가
# 없으면 설치 자체가 실패할 수 있어서 아예 안 건드리는 게 안전하다.
#
# --ignore-scripts: apps/server 의 postinstall(`prisma generate`)이 여기서
# 같이 도는데, 이 시점엔 package.json 만 있고 prisma/schema.prisma 는 아직
# 없어서 실패한다. generate 는 builder 스테이지에서 소스 전체가 들어온 뒤
# 명시적으로 다시 돈다 — 여기서는 그냥 건너뛴다.
RUN npm ci --include-workspace-root --ignore-scripts \
      --workspace=@kybird/shared \
      --workspace=@kybird/server

# ---- 2) 빌드 ----
FROM deps AS builder
WORKDIR /app

COPY packages/shared packages/shared
COPY apps/server apps/server
COPY tsconfig.base.json ./

RUN npm run build --workspace @kybird/shared

WORKDIR /app/apps/server
# 생성물이 없으면 빌드가 타입을 못 찾는다. 스키마만 있으면 되고 DB 는 필요 없다.
RUN npx prisma generate

# 빌드 시점에는 DB 에 실제로 쿼리하지 않지만, lib/prisma.ts 가 모듈
# 스코프에서 PrismaClient(better-sqlite3 어댑터)를 바로 생성해서 Next 의
# 정적 페이지 수집(/api/auth/register 등 임포트) 때 DATABASE_URL 이 없으면
# 죽는다. 더미 경로만 있으면 된다 — 이 파일은 이미지에 안 남는다(빌더
# 스테이지 전용). 실제 경로는 런타임에 docker-compose 의 환경변수로 온다.
ENV DATABASE_URL="file:/tmp/build-placeholder.db"
ENV NEXT_TELEMETRY_DISABLED=1
RUN npx next build

# ---- 3) 실행 ----
FROM node:22-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# 마이그레이션에 prisma CLI 가 필요하고, 백업 스크립트가 sqlite3 를 쓴다.
RUN apt-get update && apt-get install -y --no-install-recommends \
      sqlite3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# root 로 돌리지 않는다. node 이미지에 이미 있는 계정을 쓴다.
RUN mkdir -p /data && chown -R node:node /data

# standalone 은 필요한 node_modules 만 추려서 나온다.
COPY --from=builder --chown=node:node /app/apps/server/.next/standalone ./
COPY --from=builder --chown=node:node /app/apps/server/.next/static ./apps/server/.next/static
COPY --from=builder --chown=node:node /app/apps/server/public ./apps/server/public

# 마이그레이션은 런타임에 돈다. 스키마·설정·CLI 가 있어야 한다.
#
# .bin 은 복사하지 않는다 — 심볼릭 링크라 레이어를 넘나들면 깨지기 쉽다.
# 진입점(build/index.js)을 node 로 직접 부른다.
# dotenv 는 prisma.config.ts 가 import 하므로 없으면 마이그레이션이 죽는다.
COPY --from=builder --chown=node:node /app/apps/server/prisma ./apps/server/prisma
COPY --from=builder --chown=node:node /app/apps/server/prisma.config.ts ./apps/server/prisma.config.ts
COPY --from=builder --chown=node:node /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder --chown=node:node /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder --chown=node:node /app/node_modules/dotenv ./node_modules/dotenv

COPY --chown=node:node deploy/docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER node

# DB 는 이미지 밖 볼륨에 둔다. 이미지 안에 두면 재배포할 때 통째로 날아간다.
VOLUME ["/data"]
ENV DATABASE_URL="file:/data/kybird-nest.db"

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "apps/server/server.js"]
