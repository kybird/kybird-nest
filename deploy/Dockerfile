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

# apps/server 의 postinstall(`prisma generate`)이 npm ci 때 같이 도는데,
# 스키마 파일이 있어야 성공한다 — 여기서 미리 넣어둔다.
#
# **`--ignore-scripts` 로 건너뛰지 않는다.** 예전엔 그랬는데, 그러면
# better-sqlite3 의 네이티브 컴파일(install 스크립트)까지 같이 꺼져버려서
# 빌드는 통과해놓고 런타임에 DB 를 여는 순간(가입 처리 등)에야
# "Could not locate the bindings file" 로 터진다 — 실제로 겪은 버그다.
# `--ignore-scripts` 는 패키지 하나만 못 끈다, 전부 다 끈다.
COPY apps/server/prisma/schema.prisma apps/server/prisma/schema.prisma
COPY apps/server/prisma.config.ts apps/server/prisma.config.ts

# 서버에 필요 없는 워크스페이스는 아예 설치하지 않는다.
#
# core 를 빼는 게 핵심이다 — transformers 트리(sharp, onnxruntime, adm-zip)가
# 통째로 사라진다. 이미지가 작아지는 것도 있지만, onnxruntime 은 arm64 프리빌드가
# 없으면 설치 자체가 실패할 수 있어서 아예 안 건드리는 게 안전하다.
RUN npm ci --include-workspace-root \
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
# prisma CLI 패키지만 골라 복사했더니 Prisma 7 의 설정 시스템(@prisma/config)이
# 끌고 오는 하위 의존성(effect, c12, deepmerge-ts, empathic, ...)이 하나씩
# 빠져서 실제 서버에서 "Cannot find module 'effect'" 로 죽는 걸 확인했다.
# 버전 올라갈 때마다 또 깨지기 쉬우니, builder 의 node_modules 전체를 그대로
# 가져온다 — standalone 트리 위에 덮어써지는 형태라 next 런타임에 필요한
# 트레이싱된 버전과 안 겹치는 나머지만 채워 넣는 셈이다. core 는 애초에
# npm ci 에서 뺐으니 여기 들어있는 것도 무겁지 않다.
COPY --from=builder --chown=node:node /app/apps/server/prisma ./apps/server/prisma
COPY --from=builder --chown=node:node /app/apps/server/prisma.config.ts ./apps/server/prisma.config.ts
COPY --from=builder --chown=node:node /app/node_modules ./node_modules

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
