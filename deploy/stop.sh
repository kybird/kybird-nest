#!/bin/sh
# 컨테이너를 멈춘다. 볼륨(DB·백업)은 그대로 둔다 — 데이터 지우려면
# 'docker compose down -v' 를 직접 써라 (이 스크립트는 그건 안 한다).
set -eu
cd "$(dirname "$0")"

docker compose stop "$@"
