#!/bin/sh
# 서버·백업 컨테이너를 띄우고 헬스체크까지 확인한다.
set -eu
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "[run] deploy/.env 가 없다 — deploy.md 2절 참고해서 먼저 만들어라." >&2
  exit 1
fi

docker compose up -d "$@"

# .env 의 KNEST_PORT 를 헬스체크에도 쓴다 (docker compose 는 자기가 알아서
# 읽지만, 이 스크립트의 curl 은 셸 변수로 따로 필요하다).
. ./.env
port="${KNEST_PORT:-3000}"
echo "[run] 기동 대기 중 (127.0.0.1:${port}) ..."
for i in $(seq 1 15); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${port}/login" || true)
  if [ "$code" = "200" ]; then
    echo "[run] OK — /login 200"
    exit 0
  fi
  sleep 2
done

echo "[run] 15회 안에 200을 못 받았다 — 'docker compose logs -f server' 로 확인해라." >&2
exit 1
