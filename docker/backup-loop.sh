#!/bin/sh
# 로컬 스냅샷 백업.
#
# 이 시스템의 진실 전체가 .db 파일 하나다. 클라이언트마다 미러가 있어서
# 완전 소실은 아니지만, 커서와 seq 가 꼬이면 복구가 지저분해진다.
#
# **cp 로 복사하면 안 된다.** WAL 모드에서는 최근 쓰기가 별도 파일(-wal)에
# 있어서, .db 만 복사하면 그 부분이 빠진 사본이 나온다. sqlite3 의 .backup 은
# 서버가 돌고 있는 중에도 일관된 사본을 만든다.
#
# 한계: 인스턴스가 통째로 사라지면 백업도 같이 사라진다. 오프사이트로
# 보내려면 여기에 rclone/aws s3 cp 한 줄을 더하면 된다.
set -eu

DB="${DATABASE_URL#file:}"
DEST=/backups
KEEP="${KNEST_BACKUP_KEEP:-14}"
INTERVAL="${KNEST_BACKUP_INTERVAL:-86400}"

mkdir -p "$DEST"

snapshot() {
  if [ ! -f "$DB" ]; then
    echo "[backup] DB 가 아직 없다: $DB"
    return 0
  fi

  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  out="$DEST/kybird-nest-$stamp.db"

  if sqlite3 "$DB" ".backup '$out'"; then
    gzip -f "$out"
    echo "[backup] $out.gz ($(du -h "$out.gz" | cut -f1))"
  else
    echo "[backup] 실패: $DB" >&2
    return 0
  fi

  # 오래된 것부터 지운다. KEEP 개만 남긴다.
  count=$(ls -1 "$DEST"/kybird-nest-*.db.gz 2>/dev/null | wc -l)
  if [ "$count" -gt "$KEEP" ]; then
    ls -1t "$DEST"/kybird-nest-*.db.gz | tail -n +$((KEEP + 1)) | while read -r old; do
      rm -f "$old"
      echo "[backup] 정리: $old"
    done
  fi
}

echo "[backup] 시작 — ${INTERVAL}초마다, ${KEEP}개 보관"
# 컨테이너가 재시작될 때마다 한 번 뜨고 시작한다.
snapshot
while true; do
  sleep "$INTERVAL"
  snapshot
done
