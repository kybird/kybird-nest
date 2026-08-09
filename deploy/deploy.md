# 배포 — Oracle ARM VPS

> 대상: Oracle Cloud Ampere A1 (aarch64), Ubuntu 22.04, Docker.
> 공개 인터넷 노출. 도메인은 있지만 다른 서비스도 같이 쓰고 있어서,
> **이 스택은 리버스 프록시를 포함하지 않는다** — 기존 프록시에 얹는다.

## 왜 이런 모양인가

로컬 전용(사설망)로 갈 수도 있었지만, 공개 노출을 선택했으므로
brief.md 에서 "안 만들어도 된다"고 판단했던 방어들을 전부 만들었다:
가입 제한, 레이트 리밋, DoS 완화, TLS 신뢰 경계.

서버 이미지에는 클라이언트 스택(임베딩·검색)이 들어가지 않는다.
`apps/server` 는 `@kybird/core` 를 의존하지 않으므로 `transformers` /
`onnxruntime` / `sharp` 트리가 통째로 빠진다 — 이미지가 작고, arm64 에서
프리빌드가 없는 네이티브 모듈 설치 실패 위험도 없다.

## 1. 사전 준비

```bash
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-plugin git
sudo usermod -aG docker $USER   # 재로그인 필요
```

레포를 받는다:

```bash
git clone https://github.com/kybird/kybird-nest.git
cd kybird-nest/deploy
```

아래 명령들은 전부 이 `deploy/` 디렉토리 기준이다 (`docker-compose.yml`,
`Dockerfile`, `docker/`, 이 문서까지 전부 여기 모여있다). 빌드 컨텍스트는
`docker-compose.yml` 안에서 레포 루트(`..`)를 가리키도록 이미 설정돼있다.

## 2. 환경변수

`.env` 를 `deploy/` 안에 만든다 (커밋하지 않는다 — `.gitignore` 에 이미
`.env` 패턴이 있어서 어느 위치든 걸린다):

```bash
# 가입 초대 코드. 비워두면 가입이 완전히 닫힌다.
# 추측 못 하게 길게: openssl rand -hex 16
KNEST_INVITE_CODE=여기에_긴_무작위_문자열

# 프록시가 TLS 를 끊는다면 1 (보통 그렇다)
KNEST_COOKIE_SECURE=1

# 프록시 뒤에 있으면 1. X-Forwarded-For 로 레이트 리밋을 건다.
# 프록시가 없는데 켜면 헤더 위조로 우회당하니 주의.
KNEST_TRUST_PROXY=1

# 앱을 로컬 어느 포트에 묶을지. 기존 프록시가 이 포트로 리버스 프록시한다.
KNEST_PORT=3000
```

## 3. 빌드와 기동

```bash
./build.sh   # docker compose build. .env 없으면 여기서 바로 실패한다
./run.sh     # up -d 하고 /login 이 200 뜰 때까지 최대 30초 기다린다
```

멈추려면 `./stop.sh` (컨테이너만 멈춘다, 볼륨은 안 건드린다). 로그를
계속 보고 싶으면:

```bash
docker compose logs -f server   # 마이그레이션과 시작 로그 확인
```

시작 로그에 `[kybird-nest]` 로 시작하는 경고가 있으면 설정을 다시 본다 —
특히 DB 경로나 초대 코드 미설정 경고는 프로덕션에서 무시하면 안 된다.

헬스체크:

```bash
curl -s http://127.0.0.1:3000/login -o /dev/null -w '%{http_code}\n'
# 200 이어야 한다
```

## 4. 기존 리버스 프록시(nginx)에 연결 — 포트 기반

이 VPS 는 **nginx + Certbot**(서브도메인별 개별 인증서)을 이미 쓰고 있다.
**dynu.net 무료 플랜의 호스트 개수 제한에 걸려 새 서브도메인을 못 만든다**
— 그래서 새 도메인이 아니라 **기존 도메인 `doall.kybird.dynu.net` 의
인증서를 그대로 재사용**하고, 포트만 새로 연다(`8443`). TLS 는 호스트명
기준으로 검증되므로 포트가 달라도 브라우저는 문제 삼지 않는다. 데이터나
서비스가 registry(기존에 `doall.kybird.dynu.net` 을 쓰던 서비스)와 섞이는
건 아니다 — 인증서만 공유한다.

`server` 는 `127.0.0.1:${KNEST_PORT}` 에만 묶인다 (`docker-compose.yml`) —
공인 IP 로 직접 노출되지 않는다. `/etc/nginx/sites-available/knest.conf`
를 만들고 `sites-enabled` 에 링크:

```nginx
server {
    listen 8443 ssl;
    listen [::]:8443 ssl;
    server_name doall.kybird.dynu.net;

    client_max_body_size 20M;

    ssl_certificate /etc/letsencrypt/live/doall.kybird.dynu.net/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/doall.kybird.dynu.net/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/knest.conf /etc/nginx/sites-enabled/knest.conf
sudo nginx -t && sudo systemctl reload nginx
```

Certbot 을 다시 돌릴 필요 없다 — 인증서는 이미 있는 걸 경로로만 참조한다
(자동 갱신 시 `doall.kybird.dynu.net` 의 다른 vhost 와 같이 갱신된다).

**포트를 두 군데서 열어야 한다:**

1. OS 방화벽(활성화돼 있다면):
   ```bash
   sudo ufw status                 # 활성 상태면
   sudo ufw allow 8443/tcp
   ```
2. **Oracle Cloud 콘솔** → 인스턴스의 VCN → Security List (또는 NSG) →
   Ingress Rules 에 `8443/tcp` 허용 규칙 추가. 이건 콘솔에서만 되고
   VPS 안에서는 안 보인다 — 놓치면 nginx 는 정상인데 밖에서 접속이
   막힌 것처럼 보인다.

`X-Forwarded-For` 는 위 블록에 이미 있다 — `KNEST_TRUST_PROXY=1` 인
상태에서 이게 없으면 레이트 리밋이 모든 요청을 같은 사용자로 본다.

## 5. 클라이언트를 서버에 연결

```bash
knest register --server https://doall.kybird.dynu.net:8443 --invite <위에서 정한 코드>
knest link
```

## 방어 기제 (구현 위치)

| 방어 | 위치 | 확인 방법 |
|---|---|---|
| 가입 초대 코드 | `apps/server/lib/invite.ts` | 코드 없이 `POST /api/auth/register` → 403 |
| 로그인/가입 레이트 리밋 | `apps/server/lib/rate-limit.ts` | 짧은 시간에 반복 → 429 |
| scrypt 동시 실행 제한 | `apps/server/lib/auth.ts` (`withHashSlot`) | 동시 다발 요청에도 메모리 상한 |
| 쿠키 secure 명시 | `apps/server/lib/session.ts` | `KNEST_COOKIE_SECURE` 로 제어, 자동 추론 안 함 |
| DB 경로 검증 | `apps/server/instrumentation.ts` | 상대경로면 프로덕션에서 기동 실패 |
| 배포 설정 요약 | `apps/server/lib/config.ts` | 한 파일에서 전체 노출 면 파악 가능 |

레이트 리밋은 **인스턴스 하나** 기준 메모리 구현이다. 나중에 여러 대로
늘리면 `lib/rate-limit.ts` 만 Redis 등으로 갈아끼우면 된다.

## 백업

`backup` 컨테이너가 하루 한 번(`KNEST_BACKUP_INTERVAL`, 기본 86400초)
`sqlite3 .backup` 으로 스냅샷을 뜨고 `KNEST_BACKUP_KEEP`(기본 14)개만
남긴다. **`cp` 로 복사하지 않는다** — WAL 모드에서 서버가 DB 를 열어둔 채로
파일을 복사하면 최근 쓰기가 빠진 사본이 나온다(직접 검증: 2000행 중 15행
누락). `.backup` 은 서버가 도는 중에도 일관된 사본을 만든다.

지금은 **로컬 스냅샷만** — 인스턴스가 통째로 사라지면 백업도 같이 사라진다.
오프사이트로 보내려면 `deploy/docker/backup-loop.sh` 의 `snapshot()` 끝에
`rclone`/`aws s3 cp` 한 줄을 추가하면 된다. 나중으로 미룬 부분이다.

복구:

```bash
docker compose stop server
gunzip -c /var/lib/docker/volumes/kybird-nest_kybird-backups/_data/kybird-nest-<시각>.db.gz \
  > /tmp/restore.db
docker run --rm -v kybird-nest_kybird-data:/data -v /tmp:/tmp \
  alpine cp /tmp/restore.db /data/kybird-nest.db
docker compose start server
```

## 재배포

```bash
git pull
./build.sh
./run.sh
```

마이그레이션은 컨테이너 시작 시 `prisma migrate deploy` 로 자동 적용된다
(`deploy/docker/entrypoint.sh`). `migrate dev` 가 아니다 — dev 는 스키마 드리프트를
보면 DB 를 리셋하려 드는데, 프로덕션에서 그건 데이터 전멸이다.

## 미결

- **arm64 이미지가 실제 서버에서 빌드되는지 확인되지 않았다.** 이 문서를
  쓴 환경에 Docker 가 없어 로컬에서 빌드 자체를 검증하지 못했다. 특히
  `better-sqlite3` 컴파일과 `npm ci` 워크스페이스 플래그는 **처음 배포할 때
  반드시 로그를 끝까지 확인해라.**
- 오프사이트 백업 미설정 (위 참고).
- 여러 서버 인스턴스로 늘어날 경우 레이트 리밋 공유 저장소 필요.
