#!/bin/sh
# 서버 이미지를 빌드한다. deploy/ 안 어디서 실행해도 되게 스스로 cd 한다.
set -eu
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "[build] deploy/.env 가 없다 — deploy.md 2절 참고해서 먼저 만들어라." >&2
  exit 1
fi

docker compose build "$@"
