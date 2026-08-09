#!/bin/sh
set -e

# 마이그레이션을 먼저 적용한다.
#
# `migrate deploy` 다 — `migrate dev` 는 스키마 드리프트를 보면 DB 를 리셋하려
# 든다. 프로덕션에서 그건 데이터 전멸이다.
echo "[kybird-nest] 마이그레이션 적용: ${DATABASE_URL}"
# .bin 심볼릭 대신 진입점을 직접 부른다. 설정 파일을 찾으려면 cwd 가
# apps/server 여야 한다.
cd /app/apps/server
node /app/node_modules/prisma/build/index.js migrate deploy
cd /app

echo "[kybird-nest] 서버 시작"
exec "$@"
